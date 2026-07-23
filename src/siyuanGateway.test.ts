import { describe, expect, it } from 'vitest'
import { createSiyuanGateway } from './siyuanGateway'
import type { SiyuanClient } from './siyuanClientCore'
import type { ExportFeedHighlight, ExportFeedSource, SyncedIndex } from './types'

const s1: ExportFeedSource = { id: 's1', title: 'Deep Work', author: null, canonicalUrl: '', type: 'article' }
const hl = (id: string, s = s1): ExportFeedHighlight => ({
  id, quote: id, quoteMarkdown: null, note: null, tags: [], updatedAt: '', source: s,
})

/** 内存版 fake client，记录调用。 */
function fakeClient() {
  const created: { path: string; markdown: string; id: string }[] = []
  const appended: { parentId: string; markdown: string; id: string }[] = []
  const attrs: { blockId: string; attrs: Record<string, string> }[] = []
  let n = 0
  const client: SiyuanClient = {
    async lsNotebooks() { return [] },
    async createDocWithMd(_nb, path, markdown) { const id = `doc${++n}`; created.push({ path, markdown, id }); return id },
    async appendBlock(parentId, markdown) { const id = `blk${++n}`; appended.push({ parentId, markdown, id }); return id },
    async setBlockAttrs(blockId, a) { attrs.push({ blockId, attrs: a }) },
    async querySql() { return [] as never },
    forwardProxy: async () => ({ status: 200, body: '', headers: {} }),
  }
  return { client, created, appended, attrs }
}

const empty = (): SyncedIndex => ({ sourceDocMap: {}, syncedHlIds: new Set() })

describe('siyuanGateway.writeSource', () => {
  it('creates a source doc with source-id path + anchors custom-acorny-source-id', async () => {
    const f = fakeClient()
    const gw = createSiyuanGateway(f.client, { notebookId: 'nb', docFolderPath: '/Acorny' })
    const index = empty()
    const res = await gw.writeSource(s1, [hl('h1')], index)
    expect(f.created[0].path).toBe('/Acorny/Deep Work-s1')
    expect(f.attrs).toContainEqual({ blockId: res.docId, attrs: { 'custom-acorny-source-id': 's1' } })
    expect(index.sourceDocMap.s1).toBe(res.docId)
  })

  it('appends each highlight with inline IAL in ONE appendBlock call (no separate setBlockAttrs on the block)', async () => {
    const f = fakeClient()
    const gw = createSiyuanGateway(f.client, { notebookId: 'nb', docFolderPath: '/Acorny' })
    const index = empty()
    await gw.writeSource(s1, [hl('h1')], index)
    expect(f.appended[0].markdown).toContain('{: custom-acorny-id="h1"}')
    // 块级去重属性不通过 setBlockAttrs 设置（只有文档锚定用 setBlockAttrs）
    expect(f.attrs.some((a) => a.attrs['custom-acorny-id'])).toBe(false)
    expect(index.syncedHlIds.has('h1')).toBe(true)
  })

  it('skips highlights already in the index (idempotent)', async () => {
    const f = fakeClient()
    const gw = createSiyuanGateway(f.client, { notebookId: 'nb', docFolderPath: '/Acorny' })
    const index = empty()
    index.syncedHlIds.add('h1')
    const res = await gw.writeSource(s1, [hl('h1'), hl('h2')], index)
    expect(res.added).toBe(1)
    expect(f.appended.map((a) => a.markdown.includes('h2'))).toContain(true)
    expect(f.appended.some((a) => a.markdown.includes('* h1'))).toBe(false)
  })

  it('reuses an existing doc from the index without re-creating', async () => {
    const f = fakeClient()
    const gw = createSiyuanGateway(f.client, { notebookId: 'nb', docFolderPath: '/Acorny' })
    const index: SyncedIndex = { sourceDocMap: { s1: 'existing-doc' }, syncedHlIds: new Set() }
    const res = await gw.writeSource(s1, [hl('h1')], index)
    expect(res.docId).toBe('existing-doc')
    expect(f.created).toHaveLength(0)
  })
})

describe('siyuanGateway.loadSyncedIndex', () => {
  it('builds sourceDocMap and syncedHlIds from two SQL queries', async () => {
    const f = fakeClient()
    const client: SiyuanClient = {
      ...f.client,
      async querySql(stmt: string) {
        if (stmt.includes('custom-acorny-source-id')) return [{ block_id: 'doc1', value: 's1' }] as never
        return [{ block_id: 'blk1', value: 'h1' }, { block_id: 'blk2', value: 'h2' }] as never
      },
    }
    const gw = createSiyuanGateway(client, { notebookId: 'nb', docFolderPath: '/Acorny' })
    const index = await gw.loadSyncedIndex()
    expect(index.sourceDocMap).toEqual({ s1: 'doc1' })
    expect([...index.syncedHlIds].sort()).toEqual(['h1', 'h2'])
  })
})
