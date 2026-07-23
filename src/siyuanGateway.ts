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
  opts: { notebookId: string; docFolderPath: string },
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

  /** 建文档并把 custom-acorny-source-id 锚在根块；返回 docId。 */
  async function ensureSourceDoc(source: ExportFeedSource): Promise<string> {
    const hpath = buildDocHPath(opts.docFolderPath, source.title)
    const docId = await client.createDocWithMd(opts.notebookId, hpath, '')
    await client.setBlockAttrs(docId, { 'custom-acorny-source-id': source.id })
    return docId
  }

  async function writeSource(
    source: ExportFeedSource,
    highlights: ExportFeedHighlight[],
    index: SyncedIndex,
  ): Promise<{ docId: string; added: number }> {
    let docId = index.sourceDocMap[source.id]
    if (!docId) {
      docId = await ensureSourceDoc(source)
      index.sourceDocMap[source.id] = docId
    }
    let added = 0
    for (const h of highlights) {
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
