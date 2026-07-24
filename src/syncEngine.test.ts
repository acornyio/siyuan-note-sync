import { describe, expect, it, vi } from 'vitest'
import { SyncEngine, type SyncEngineDeps } from './syncEngine'
import type { ExportFeedHighlight, ExportFeedResponse, ExportFeedSource, PluginState, SyncedIndex } from './types'
import { AuthError, RateLimitError } from './apiClient'
import { connectionId } from './connection'

const src = (id: string): ExportFeedSource => ({ id, title: id, author: null, canonicalUrl: '', type: 'article' })
const hl = (id: string, s: ExportFeedSource): ExportFeedHighlight => ({
  id, quote: id, quoteMarkdown: null, note: null, tags: [], updatedAt: '', source: s,
})

function makeDeps(pages: ExportFeedResponse[], over: Partial<SyncEngineDeps> = {}) {
  let saved: PluginState | null = null
  const index: SyncedIndex = { sourceDocMap: {}, syncedHlIds: new Set() }
  const writes: { sourceId: string; ids: string[] }[] = []
  const deps: SyncEngineDeps = {
    getSettings: () => ({ serverUrl: 'https://api.acorny.io', exportToken: 'tk', notebookId: 'nb', docFolderPath: '/Acorny', syncOnStartup: false, pollIntervalMinutes: 0 }),
    loadState: async () => saved ?? { lastCursor: null, connectionId: null },
    saveState: async (s) => { saved = s },
    loadSyncedIndex: async () => index,
    fetchPage: vi.fn(async ({ cursor }) => pages[cursor ? Number(cursor) : 0]),
    writeSource: async (source, highlights, idx) => {
      // 复刻真实网关：跳过已同步、mutate 索引，同一 source 复用 docId
      let docId = idx.sourceDocMap[source.id]
      if (!docId) { docId = `doc-${source.id}`; idx.sourceDocMap[source.id] = docId }
      let added = 0
      const ids: string[] = []
      for (const h of highlights) {
        if (idx.syncedHlIds.has(h.id)) continue
        idx.syncedHlIds.add(h.id); ids.push(h.id); added++
      }
      writes.push({ sourceId: source.id, ids })
      return { docId, added }
    },
    onStatus: () => {},
    ...over,
  }
  return { deps, getSaved: () => saved, writes, index }
}

describe('SyncEngine.sync', () => {
  it('drains pages, groups by source, returns added count', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [
      { highlights: [hl('h1', s1), hl('h2', s1)], nextCursor: '1', done: false },
      { highlights: [hl('h3', s1)], nextCursor: '2', done: true },
    ]
    const { deps, getSaved } = makeDeps(pages)
    const res = await new SyncEngine(deps).sync()
    expect(res).toEqual({ status: 'completed', pages: 2, added: 3 })
    expect(getSaved()).toEqual({ lastCursor: '2', connectionId: expect.any(String) })
  })

  it('is idempotent: a highlight already in the SQL index is skipped', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const { deps, index } = makeDeps(pages)
    index.syncedHlIds.add('h1')
    const res = await new SyncEngine(deps).sync()
    expect(res).toMatchObject({ status: 'completed', added: 0 })
  })

  it('reuses the same doc for a source spanning two pages', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [
      { highlights: [hl('h1', s1)], nextCursor: '1', done: false },
      { highlights: [hl('h2', s1)], nextCursor: '', done: true },
    ]
    const { deps, index } = makeDeps(pages)
    await new SyncEngine(deps).sync()
    expect(Object.keys(index.sourceDocMap)).toEqual(['s1'])
  })

  it('self-heals: cursor set + empty SQL index (data wiped) → full re-fetch from null', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const fetchPage = vi.fn(async () => pages[0])
    // 同连接 + 有游标，但 SQL 索引为空（用户删光了同步文档）→ 应弃用游标
    const conn = connectionId('https://api.acorny.io', 'tk')
    const { deps } = makeDeps(pages, {
      fetchPage,
      loadState: async () => ({ lastCursor: 'END', connectionId: conn }),
    })
    const res = await new SyncEngine(deps).sync()
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }))
    expect(res).toMatchObject({ status: 'completed', added: 1 })
  })

  it('discards a foreign cursor when connection changed', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const fetchPage = vi.fn(async () => pages[0])
    const { deps } = makeDeps(pages, { fetchPage, loadState: async () => ({ lastCursor: '999', connectionId: 'OTHER' }) })
    await new SyncEngine(deps).sync()
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }))
  })

  it('aborted before drain starts → skipped and no state persisted', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const { deps, getSaved } = makeDeps(pages, { isAborted: () => true })
    const res = await new SyncEngine(deps).sync()
    expect(res).toEqual({ status: 'skipped' })
    expect(getSaved()).toBeNull()
  })

  it('aborts between source groups mid-drain: later sources not written, no state saved', async () => {
    const s1 = src('s1')
    const s2 = src('s2')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1), hl('h2', s2)], nextCursor: '', done: true }]
    let aborted = false
    const written: string[] = []
    const { deps, getSaved } = makeDeps(pages, {
      isAborted: () => aborted,
      writeSource: async (source) => { written.push(source.id); aborted = true; return { docId: 'd', added: 0 } },
    })
    const res = await new SyncEngine(deps).sync()
    expect(written).toEqual(['s1']) // abort 在 s1 后置真，s2 不再写
    expect(res).toEqual({ status: 'skipped' })
    expect(getSaved()).toBeNull()
  })

  it('maps AuthError → auth_failed', async () => {
    const { deps } = makeDeps([], { fetchPage: async () => { throw new AuthError() } })
    expect(await new SyncEngine(deps).sync()).toEqual({ status: 'auth_failed' })
  })

  it('maps RateLimitError → backoff', async () => {
    const { deps } = makeDeps([], { fetchPage: async () => { throw new RateLimitError(12) } })
    expect(await new SyncEngine(deps).sync()).toEqual({ status: 'backoff', retryAfterSeconds: 12 })
  })
})
