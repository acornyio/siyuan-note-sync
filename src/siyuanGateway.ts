import type { SiyuanClient } from './siyuanClientCore'
import type { ExportFeedHighlight, ExportFeedSource, SyncedIndex } from './types'
import { buildDocHPath } from './docPath'
import { renderHighlightBlock } from './renderer'

interface AttrRow {
  block_id: string
  value: string
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
  opts: { notebookId: string; docFolderPath: string; isAborted?: () => boolean },
): SiyuanGateway {
  /** 一次拉全库已同步索引：source 锚定 + 高亮去重。 */
  async function loadSyncedIndex(): Promise<SyncedIndex> {
    const srcRows = await client.querySql<AttrRow>(
      "SELECT block_id, value FROM attributes WHERE name = 'custom-acorny-source-id'",
    )
    const hlRows = await client.querySql<AttrRow>(
      "SELECT block_id, value FROM attributes WHERE name = 'custom-acorny-id'",
    )
    const sourceDocMap: Record<string, string> = {}
    for (const r of srcRows) sourceDocMap[r.value] = r.block_id
    const syncedHlIds = new Set<string>(hlRows.map((r) => r.value))
    return { sourceDocMap, syncedHlIds }
  }

  async function writeSource(
    source: ExportFeedSource,
    highlights: ExportFeedHighlight[],
    index: SyncedIndex,
  ): Promise<{ docId: string; added: number }> {
    let docId = index.sourceDocMap[source.id]
    if (!docId) {
      const hpath = buildDocHPath(opts.docFolderPath, source.title)
      docId = await client.createDocWithMd(opts.notebookId, hpath, '')
      // 先把 docId 记进索引，再写 source 锚定属性：createDocWithMd/setBlockAttrs 非原子，
      // 若属性写入失败，至少同一 run 内不会对该 source 重复建文档（跨 run 的孤儿文档见 §11）。
      index.sourceDocMap[source.id] = docId
      await client.setBlockAttrs(docId, { 'custom-acorny-source-id': source.id })
    }
    let added = 0
    for (const h of highlights) {
      // 卸载/重载时停止后续写入（不只是"不保存状态"），避免废弃实例继续批量写。
      if (opts.isAborted?.()) break
      if (index.syncedHlIds.has(h.id)) continue
      // 块 + custom-acorny-id 一次原子落地（内联 IAL），规避崩溃窗口（spec §5）。
      await client.appendBlock(docId, renderHighlightBlock(h))
      index.syncedHlIds.add(h.id)
      added += 1
    }
    return { docId, added }
  }

  return { loadSyncedIndex, writeSource }
}
