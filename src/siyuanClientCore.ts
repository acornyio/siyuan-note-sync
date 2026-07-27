import type { ForwardProxyFn } from './httpProxy'

// 纯逻辑核心：不导入 'siyuan'（该包无运行时 JS，仅类型），因此本文件可在 vitest 下单测，
// 也可被 siyuanGateway 以 `import type` 引用而不牵入 siyuan。真正调用 kernel 的工厂在
// siyuanClient.ts。

export interface Notebook {
  id: string
  name: string
}

export interface SiyuanClient {
  lsNotebooks(): Promise<Notebook[]>
  /**
   * 建文档，返回文档（根块）id。
   * ⚠️ **非 hpath 幂等**：同一 hpath 连建两次会得到两篇独立的同名文档（真机 spike 实测，见
   * docs/superpowers/notes/2026-07-23-kernel-contract-fixtures.md 结论 6）。因此路径**不能**
   * 当唯一键——调用方必须先确认该 source 没有文档，见 siyuanGateway.resolveDocId。
   */
  createDocWithMd(notebookId: string, hpath: string, markdown: string): Promise<string>
  /**
   * 按 hpath 取文档 id（同名文档会返回多个）。**零延迟**：文档建完立刻可见（实测），
   * 与滞后 1–2s 的 `attributes` SQL 表不同——这是刚建档那段窗口里唯一可靠的查找通道。
   * 路径不存在时返回空数组。
   */
  getIDsByHPath(notebookId: string, hpath: string): Promise<string[]>
  /** 取某文档当前的 hpath（**笔记本内**相对路径）。不存在时返回空串。 */
  getHPathByID(blockId: string): Promise<string>
  /**
   * 取某块所属笔记本 id（`getBlockInfo.box`）。因为 hpath 是笔记本内相对路径，
   * 判断"文档在不在目标位置"必须笔记本 + hpath 一起比。块不存在时该接口报错。
   */
  getDocNotebookId(blockId: string): Promise<string>
  /**
   * 批量把文档移到目标文档（思源的"文件夹"本身也是文档）之下。
   * **文档 id 不变**（真机实测），故 docMap / 锚定属性 / 已同步高亮全部保持有效。
   */
  moveDocsByID(fromIDs: string[], toID: string): Promise<void>
  /**
   * 删除文档。**仅用于回滚本插件刚建出来、尚未写入任何内容的空文档**（锚定失败时），
   * 绝不可用于用户已有内容的文档。
   */
  removeDocByID(blockId: string): Promise<void>
  /** 追加块（markdown 可含内联 IAL），返回新块 id。 */
  appendBlock(parentId: string, markdown: string): Promise<string>
  setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void>
  /**
   * 读某块（文档）的 kramdown。由实时块树生成、含文档根块 IAL 与各子块内联 IAL，**无延迟**
   * （append 后立即可见）。
   *
   * **这是唯一可靠的存在性判据**（2026-07-26 真机实测）：
   *  - 文档不存在（已删除 / id 不存在）→ **空串**，且删除后立即生效；
   *  - 文档存在但没有任何内容 → 仍返回根块 IAL，**非空**。
   *
   * ⚠️ 不要改用 `/api/attr/getBlockAttrs` 判存在：它对已删除文档**仍然长期返回完整属性**，
   * 曾导致同步往已删文档追加块并以 `parent block not found` 整轮失败。
   */
  getBlockKramdown(blockId: string): Promise<string>
  /**
   * 跑一条 SQL。⚠️ 语句**没有显式 `LIMIT` 时内核默认只返回 64 行**（3.7.3 实测），且不报错、
   * 不带任何截断标记——静默的残缺结果曾被上层理解成"没同步过"，导致重复建出数千篇文档。
   * 凡结果集大小不可控的查询，必须显式给 `LIMIT` 并检查是否触顶。
   */
  querySql<T>(sql: string): Promise<T[]>
  forwardProxy: ForwardProxyFn
}

export interface KernelResponse<T> {
  code: number
  msg: string
  data: T
}

/**
 * 从文档 kramdown 里解析出已同步高亮的 `custom-acorny-id` 集合（每文档去重的真相）。
 * 前置 `(?<![-\w])` 边界确保不会把文档锚定属性 `custom-acorny-source-id` 误当高亮 id。
 */
export function parseSyncedHighlightIds(kramdown: string): Set<string> {
  const ids = new Set<string>()
  const re = /(?<![-\w])custom-acorny-id="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(kramdown)) !== null) ids.add(m[1])
  return ids
}

/**
 * 从文档 kramdown 里读出锚定的 source id（文档根块 IAL 上的 `custom-acorny-source-id`）。
 * 空 kramdown（= 文档不存在）或未锚定的文档返回 `null`。
 */
export function parseDocSourceId(kramdown: string): string | null {
  const m = /custom-acorny-source-id="([^"]*)"/.exec(kramdown)
  return m && m[1].length > 0 ? m[1] : null
}

/** appendBlock 报「父块不存在」——文档在读取与追加之间被删掉了。 */
export function isParentMissingError(error: unknown): boolean {
  return error instanceof Error && /parent block not found/i.test(error.message)
}

/**
 * 转义 SQL 单引号字符串字面量的内容（SQLite 语义：`'` → `''`，无反斜杠转义）。
 * 思源 `/api/query/sql` 只收整条语句、不支持参数绑定，凡拼接外部值必须过这里。
 */
export function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

/** 从 appendBlock 事务响应中取新块 id：data[0].doOperations[0].id。 */
export function extractAppendedBlockId(data: unknown): string {
  const op = Array.isArray(data)
    ? (data[0] as { doOperations?: Array<{ id?: string }> } | undefined)?.doOperations?.[0]
    : undefined
  const id = op?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`appendBlock: 无法从响应解析新块 id: ${JSON.stringify(data)}`)
  }
  return id
}
