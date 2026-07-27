import {
  isParentMissingError, parseDocSourceId, parseSyncedHighlightIds, sqlLiteral, type SiyuanClient,
} from './siyuanClientCore'
import type { ExportFeedHighlight, ExportFeedSource, SyncedIndex } from './types'
import { buildDocHPath } from './docPath'
import { renderHighlightBlock } from './renderer'

interface AttrRow {
  block_id: string
  value: string
}

const SOURCE_ATTR = 'custom-acorny-source-id'

/**
 * 冷启动种子查询的显式行上限。**必须显式给**：内核对无 `LIMIT` 的语句默认只返回 64 行，
 * 静默截断曾把 446 个 source 的库放大成 6850 篇重复文档。取值远大于任何真实库规模，
 * 触顶即视为「结果不完整」而中止同步（见 loadSyncedIndex）。
 */
export const SEED_ROW_LIMIT = 100_000

/**
 * 同一 source 的候选文档点查上限。正常为 1；>1 说明历史上已产生重复。
 * 取值要能覆盖真实重复规模——事故里单个 source 曾有 88 篇文档，而删除后 attributes 表还会
 * 返回滞后行约 3s，上限太小会让「前若干条都是已删的幽灵行」把活着的那篇挤出候选，进而重复建档。
 */
export const POINT_LOOKUP_LIMIT = 128

/**
 * 单次同步允许新建的文档数下限。实际预算 = max(本数, 同步开始时的已知 source 数)，
 * 即「一次同步最多让文档库翻一倍」。这是熔断兜底，不是主要防线——主要防线是建档前的点查。
 * 它的职责是：当某个索引通道再次静默失效时，让同步**停摆并报错**，而不是安静地造脏数据。
 */
export const MIN_NEW_DOCS_PER_SYNC = 50

/** 索引不可信 → 中止本次同步（宁可不同步，也不要重复建档）。 */
export class SyncIndexError extends Error {
  constructor(readonly kind: 'seed_truncated' | 'create_budget_exceeded', message: string) {
    super(message)
    this.name = 'SyncIndexError'
  }
}

export interface SiyuanGateway {
  loadSyncedIndex(): Promise<SyncedIndex>
  writeSource(
    source: ExportFeedSource,
    highlights: ExportFeedHighlight[],
    index: SyncedIndex,
  ): Promise<{ docId: string; added: number }>
}

export function createSiyuanGateway(
  client: SiyuanClient,
  opts: {
    notebookId: string
    /** 新建文档的落点。 */
    docFolderPath: string
    /**
     * 曾经用过的文件夹（不含当前）。用户改过目标文件夹、但已有文档还留在旧处时，
     * L3a 必须连旧文件夹一起找，否则那些文档对零延迟通道不可见 → 重新打开重复建档的窗口。
     */
    knownFolders?: string[]
    /** 跨同步存活的内存 source→doc 映射（就地 mutate）。见 §去重设计。 */
    docMap: Record<string, string>
    /**
     * 历史上见过的 source 数（持久化的高水位）。用来区分「真·首次同步」与「索引因故全空」：
     * 前者全量新建正常、不该熔断；后者恰恰是最需要熔断的时刻。只看当前 baseline 分不出来。
     */
    knownSourceCount?: number
    isAborted?: () => boolean
  },
): SiyuanGateway {
  /** 本次同步已新建的文档数，与 baseline 一起构成熔断预算。 */
  let createdThisRun = 0
  /** 同步开始时已知的 source 数（docMap 持久化条目 + SQL 种子）。0 = 首次同步，不设预算。 */
  let baseline = Object.keys(opts.docMap).length

  /**
   * 用 SQL 的 source-id 行给内存 docMap 补种子（**批量快路径**）。docMap 本身是持久化的，
   * 种子只用于补齐「上个会话建了但没来得及落盘」的条目，以及 data.json 丢失后的整体恢复。
   *
   * 注意这条查询**必须**带显式 LIMIT：内核对无 LIMIT 的语句默认只返回 64 行且不作任何提示。
   * 触顶即中止——残缺的索引会被下游理解成"这些 source 没同步过"，进而重复建档。
   */
  async function loadSyncedIndex(): Promise<SyncedIndex> {
    const rows = await client.querySql<AttrRow>(
      `SELECT block_id, value FROM attributes WHERE name = '${SOURCE_ATTR}' LIMIT ${SEED_ROW_LIMIT}`,
    )
    if (rows.length >= SEED_ROW_LIMIT) {
      throw new SyncIndexError(
        'seed_truncated',
        `已同步索引查询触到 ${SEED_ROW_LIMIT} 行上限，结果可能不完整；已中止同步以免重复建档。`,
      )
    }
    for (const r of rows) if (!(r.value in opts.docMap)) opts.docMap[r.value] = r.block_id
    baseline = Object.keys(opts.docMap).length
    return { sourceDocMap: opts.docMap }
  }

  /**
   * 一次 kramdown 读取同时得到三件事：文档在不在、锚定的是不是本 source、已同步了哪些高亮。
   * 返回 null = 文档不存在或不属于本 source（两种都要走重建/另寻）。
   *
   * kramdown 是**唯一**可靠的存在性判据：删除后立即返回空串，而"存在但没内容"的文档
   * 仍带根块 IAL（非空），两者可区分。`getBlockAttrs` 对已删文档仍返回属性，不可用。
   */
  async function readDocOf(docId: string, sourceId: string): Promise<Set<string> | null> {
    const kramdown = await client.getBlockKramdown(docId)
    if (kramdown === '') return null // 文档已删除 / id 不存在
    if (parseDocSourceId(kramdown) !== sourceId) return null // 锚定不符（污染 / 被改）
    return parseSyncedHighlightIds(kramdown)
  }

  /**
   * 针对单个 source 的**精确点查**——建档前的最后一道确认。
   * 带 WHERE 且结果集极小，不受任何批量截断影响；docMap/种子整体失效时它仍然正确。
   */
  async function findDocBySourceId(sourceId: string): Promise<{ docId: string; present: Set<string> } | null> {
    const rows = await client.querySql<AttrRow>(
      `SELECT block_id, value FROM attributes WHERE name = '${SOURCE_ATTR}'`
      + ` AND value = '${sqlLiteral(sourceId)}' LIMIT ${POINT_LOOKUP_LIMIT}`,
    )
    // 逐行校验，不能拿到行就当文档还在：删除后 attributes 表还会返回该行约 3 秒（实测）。
    // 历史重复也会返回多行，取第一个仍存活且锚定正确的。
    for (const r of rows) {
      const present = await readDocOf(r.block_id, sourceId)
      if (present) return { docId: r.block_id, present }
    }
    return null
  }

  /**
   * 按 hpath 找该 source 的现有文档——**零延迟**通道。
   * `attributes` SQL 表建档后要 1–2s 才查得到（实测），那段窗口里若 docMap 恰好为空，
   * 只靠 SQL 会重复建档。按路径查立刻可见，正好补上这个洞。
   * 思源允许同名文档，故每个候选仍要用锚定属性校验，避免抢用别的 source 的文档。
   */
  async function findDocByHPath(source: ExportFeedSource): Promise<{ docId: string; present: Set<string> } | null> {
    // 当前文件夹优先，再找历史文件夹——用户改过目标位置、老文档还没迁走时靠后者命中。
    for (const folder of [opts.docFolderPath, ...(opts.knownFolders ?? [])]) {
      const hpath = buildDocHPath(folder, source.title)
      // 与点查同样设上限：每个候选都是一次 kramdown 请求，同名文档一多就线性发请求。
      const candidates = (await client.getIDsByHPath(opts.notebookId, hpath)).slice(0, POINT_LOOKUP_LIMIT)
      for (const id of candidates) {
        const present = await readDocOf(id, source.id)
        if (present) return { docId: id, present }
      }
    }
    return null
  }

  /**
   * 熔断计费。**只对"索引声称完全不知道这个 source、我却要建文档"的情况计费**——那正是
   * 索引失效的signature（种子被截断 → 条目凭空消失 → 重复建档）。
   *
   * 刻意不计费的两类新建，因为它们都有正面证据、不是索引可疑：
   *  - docMap 有条目但实时核实文档已删 → 用户主动删除，重建合法
   *    （否则"清空整个文件夹后重新同步"必然超预算，被误伤）；
   *  - **真·首次同步** → 全量新建本就正常。
   *
   * 注意「真·首次同步」不能只看 `baseline === 0`：索引因故全空时 baseline 同样是 0，
   * 而那恰恰是最需要熔断的时刻。用持久化的历史 source 数（knownSourceCount）区分二者。
   */
  function chargeUnknownSourceCreate(): void {
    if (baseline === 0 && (opts.knownSourceCount ?? 0) === 0) return // 从没同步过，全量新建正常
    const budget = Math.max(MIN_NEW_DOCS_PER_SYNC, baseline)
    if (createdThisRun >= budget) {
      throw new SyncIndexError(
        'create_budget_exceeded',
        `本次同步已为 ${createdThisRun} 个「索引查不到」的 source 新建文档（上限 ${budget}），`
        + '疑似已同步索引失效；已中止同步。',
      )
    }
    createdThisRun += 1
  }

  /**
   * 解析该 source 的文档 id，**四级下降**——任一级命中都不会新建：
   *   L1  docMap（内存 + 持久化）→ readDocOf / getBlockKramdown 零延迟校验
   *   L3a getIDsByHPath 按路径查（零延迟，覆盖刚建完那 1–2s 窗口）
   *   L3b SQL 按 source-id 点查（滞后 1–2s，覆盖文档被改名/移走）
   *   都没有 → 过熔断 → createDocWithMd 新建
   * （L2 是 loadSyncedIndex 的批量种子，在同步开始时一次性补进 docMap，不在本函数里。）
   *
   * `verifiedDeletion` = 调用方已实时核实过原文档确实没了（TOCTOU 重试）。这类重建有正面
   * 证据、不是索引可疑，和「docMap 有条目但文档已删」同等对待，**不计入熔断预算**。
   */
  async function resolveDoc(
    source: ExportFeedSource,
    index: SyncedIndex,
    verifiedDeletion = false,
  ): Promise<{ docId: string; present: Set<string> }> {
    const cached = index.sourceDocMap[source.id]
    if (cached) {
      const present = await readDocOf(cached, source.id)
      if (present) return { docId: cached, present }
      delete index.sourceDocMap[source.id]
    }
    // 有过条目 = 索引记得这个 source，只是文档被删/被改。这是**实时核实过**的删除，
    // 属于合法重建，不计入熔断预算（否则清空文件夹后的整库重建会被误伤）。
    const knownToIndex = Boolean(cached) || verifiedDeletion

    // docMap 未命中 ≠ 文档不存在（data.json 丢失、种子失效、上次建档后没落盘……）。
    // createDocWithMd 非 hpath 幂等，所以下面两级是"绝不重复建档"的关键保证，不能省。
    // 先按路径查（零延迟，覆盖"刚建完、attributes 表还没索引"的 1–2s 窗口），
    // 再按属性点查（有 1–2s 延迟，但覆盖"用户把文档改名/移走了"）。
    const found = await findDocByHPath(source) ?? await findDocBySourceId(source.id)
    if (found) {
      index.sourceDocMap[source.id] = found.docId
      return found
    }

    if (!knownToIndex) chargeUnknownSourceCreate()
    const hpath = buildDocHPath(opts.docFolderPath, source.title)
    const docId = await client.createDocWithMd(opts.notebookId, hpath, '')
    index.sourceDocMap[source.id] = docId
    try {
      await client.setBlockAttrs(docId, { [SOURCE_ATTR]: source.id })
    } catch (error) {
      // 建档与锚定不是一个事务。锚定失败必须回滚刚建的空文档，否则会留下一篇**无锚定**的
      // 文档：下个会话 L3a 按路径找到它、readDocOf 因锚定不符拒绝采用 → 再建一篇，孤儿永久堆积。
      // 此刻文档必然是空的（还没 append 过），删除不会丢内容。
      delete index.sourceDocMap[source.id]
      await client.removeDocByID(docId).catch((e: unknown) => {
        console.error('[Acorny] Failed to roll back an unanchored doc:', docId, e)
      })
      throw error
    }
    return { docId, present: new Set<string>() } // 新文档必然没有已同步高亮
  }

  async function writeSource(
    source: ExportFeedSource,
    highlights: ExportFeedHighlight[],
    index: SyncedIndex,
  ): Promise<{ docId: string; added: number }> {
    // 最多重来一轮：文档中途消失时，必须对**重建后的空文档重跑整个列表**，而不是接着往下写——
    // 那些因"旧文档里已有"而被跳过的高亮，在新文档里并不存在，接着写会把它们漏掉。
    for (let attempt = 0; ; attempt += 1) {
      // attempt > 0 = 上一轮亲眼看到内核报「父块不存在」，属实时核实过的删除，不该计熔断预算。
      const target = await resolveDoc(source, index, attempt > 0)
      try {
        let added = 0
        for (const h of highlights) {
          // 卸载/重载时停止后续写入（不只是"不保存状态"），避免废弃实例继续批量写。
          if (opts.isAborted?.()) break
          if (target.present.has(h.id)) continue
          // 块 + custom-acorny-id 一次原子落地（内联 IAL），规避崩溃窗口（spec §5）。
          await client.appendBlock(target.docId, renderHighlightBlock(h))
          target.present.add(h.id)
          added += 1
        }
        return { docId: target.docId, added }
      } catch (error) {
        // TOCTOU：读完 kramdown 之后、追加之前用户删掉了这篇文档，内核报
        // `parent block not found`。整轮同步不该为此中断并退避 60s。
        // 只重来一次，避免用户持续删除时无限重试。
        if (attempt >= 1 || !isParentMissingError(error)) throw error
        delete index.sourceDocMap[source.id] // 下一轮 resolveDoc 会重建
      }
    }
  }

  return { loadSyncedIndex, writeSource }
}
