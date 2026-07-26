import { parseDocSourceId, type SiyuanClient } from './siyuanClientCore'
import { normalizeFolderPath } from './docPath'

export interface MigrationOptions {
  notebookId: string
  /** 目标文件夹（笔记本内路径），会被规范化成 `/foo/bar`。 */
  targetFolder: string
  /** 候选文档 id（通常是 docMap 的全部值）。 */
  docIds: string[]
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
    const hpath = await client.getHPathByID(docId)
    if (hpath.startsWith(prefix)) { skipped += 1; continue } // 已经在目标文件夹里
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
