import { parseDocSourceId, type SiyuanClient } from './siyuanClientCore'
import { normalizeFolderPath } from './docPath'

export interface MigrationOptions {
  notebookId: string
  /** 目标文件夹（笔记本内路径），会被规范化成 `/foo/bar`。 */
  targetFolder: string
  /** 候选文档 id（通常是 docMap 的全部值）。 */
  docIds: string[]
}

/** 同步目标位置（笔记本 + 文件夹）。 */
export interface SyncDestination {
  notebookId: string
  docFolderPath: string
}

export interface DestinationChangePlan {
  /** 目标位置变了 → 值得立刻跑一次同步，让新设置马上可见。 */
  destinationChanged: boolean
  folderChanged: boolean
  /** 需要把已有文档搬到新位置。 */
  needsMigration: boolean
}

/**
 * 判断保存设置后要做什么。抽成纯函数是为了让它可回归——这段逻辑原先内联在 `index.ts` 的
 * `confirmCallback` 里，而 `index.ts` 因 import 'siyuan' 无法单测，于是漏掉了「只换笔记本」
 * 这条分支：它触发同步却不迁移，docMap 里的旧文档按 block id 校验照样通过，新高亮继续写进
 * 旧笔记本，换笔记本形同无效。
 */
export function planDestinationChange(prev: SyncDestination, next: SyncDestination): DestinationChangePlan {
  const folderChanged = normalizeFolderPath(prev.docFolderPath) !== normalizeFolderPath(next.docFolderPath)
  const notebookChanged = prev.notebookId !== next.notebookId
  return {
    destinationChanged: folderChanged || notebookChanged,
    folderChanged,
    // 之前根本没选过笔记本 = 不存在已有文档，没什么可搬。
    needsMigration: (folderChanged || notebookChanged) && prev.notebookId !== '',
  }
}

export interface MigrationResult {
  moved: number
  /** 已删除、非 Acorny 文档、或已在目标文件夹里而未移动的数量。 */
  skipped: number
}

/**
 * 把已有的 Acorny 文档搬到当前目标文件夹。
 *
 * 用户改了「文档文件夹」设置后调用。不这么做的话，老文档留在旧文件夹继续接收新高亮，
 * 而重建/新建的文档落到新文件夹，文档库被劈成两半、设置只生效一半。
 *
 * 安全约束（每条都有对应回归测试）：
 *  - 只搬**带 Acorny 锚定属性**的文档，绝不碰用户自己写的文档；
 *  - kramdown 为空 = 文档已被用户删除，跳过，不会因迁移而复活；
 *  - 已在目标文件夹里的不动；
 *  - 没有要搬的就什么都不做（连目标文件夹都不建）。
 *
 * `moveDocsByID` **不改变文档 id**（真机实测），所以 docMap、锚定属性、已同步高亮全部保持有效。
 */
export async function migrateDocsToFolder(
  client: SiyuanClient,
  opts: MigrationOptions,
): Promise<MigrationResult> {
  const target = normalizeFolderPath(opts.targetFolder)
  const prefix = `${target}/`
  const toMove: string[] = []
  let skipped = 0

  for (const docId of opts.docIds) {
    const kramdown = await client.getBlockKramdown(docId)
    // 空串 = 已删除；无锚定 = 不是 Acorny 建的文档。两种都不碰。
    if (kramdown === '' || parseDocSourceId(kramdown) === null) { skipped += 1; continue }
    // 必须同时比对笔记本：hpath 是**笔记本内**相对路径，别的笔记本里的同名文件夹前缀完全一样，
    // 只比 hpath 会把「旧笔记本的 /Acorny」误判成「已经在目标 /Acorny 里」→ 永远搬不过去。
    const notebookId = await client.getDocNotebookId(docId)
    const hpath = await client.getHPathByID(docId)
    if (notebookId === opts.notebookId && hpath.startsWith(prefix)) { skipped += 1; continue }
    toMove.push(docId)
  }

  if (toMove.length === 0) return { moved: 0, skipped }

  // 目标文件夹在思源里本身也是一篇文档，必须先有 id 才能作为移动目标。
  const existing = await client.getIDsByHPath(opts.notebookId, target)
  const targetId = existing[0] ?? await client.createDocWithMd(opts.notebookId, target, '')

  // 一次批量移动，而不是每篇一个请求。
  await client.moveDocsByID(toMove, targetId)
  return { moved: toMove.length, skipped }
}
