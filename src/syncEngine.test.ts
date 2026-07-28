import { describe, expect, it } from 'vitest'
import { SyncEngine, type SyncEngineDeps } from './syncEngine'
import type { ExportFeedHighlight, ExportFeedResponse, ExportFeedSource, SyncedIndex } from './types'
import { AuthError, RateLimitError } from './apiClient'
import { SyncIndexError } from './siyuanGateway'

const src = (id: string): ExportFeedSource => ({ id, title: id, author: null, canonicalUrl: '', type: 'article' })
const hl = (id: string, s: ExportFeedSource): ExportFeedHighlight => ({
  id, quote: id, quoteMarkdown: null, note: null, tags: [], updatedAt: '', source: s,
})

function makeDeps(pages: ExportFeedResponse[], over: Partial<SyncEngineDeps> = {}) {
  const index: SyncedIndex = { sourceDocMap: {} }
  const syncedHlIds = new Set<string>() // fake 的"思源里已有的高亮"，模拟网关的每文档去重
  const writes: { sourceId: string; ids: string[] }[] = []
  const deps: SyncEngineDeps = {
    getSettings: () => ({ exportToken: 'tk', notebookId: 'nb', docFolderPath: '/Acorny', syncOnStartup: false, pollIntervalMinutes: 0 }),
    loadSyncedIndex: async () => index,
    // 每页按分页游标返回；null → 第 0 页。全量对账每次都从 null 开始。
    fetchPage: async ({ cursor }) => pages[cursor ? Number(cursor) : 0],
    writeSource: async (source, highlights, idx) => {
      // 复刻真实网关：跳过思源里已有的高亮、mutate docMap，同一 source 复用 docId。
      let docId = idx.sourceDocMap[source.id]
      if (!docId) { docId = `doc-${source.id}`; idx.sourceDocMap[source.id] = docId }
      let added = 0
      const ids: string[] = []
      for (const h of highlights) {
        if (syncedHlIds.has(h.id)) continue
        syncedHlIds.add(h.id); ids.push(h.id); added++
      }
      writes.push({ sourceId: source.id, ids })
      return { docId, added }
    },
    onStatus: () => {},
    ...over,
  }
  return { deps, writes, index, syncedHlIds }
}

describe('SyncEngine.sync (full reconciliation)', () => {
  it('drains every page from cursor=null, groups by source, returns added count', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [
      { highlights: [hl('h1', s1), hl('h2', s1)], nextCursor: '1', done: false },
      { highlights: [hl('h3', s1)], nextCursor: '2', done: true },
    ]
    const seen: (string | null)[] = []
    const { deps } = makeDeps(pages, {
      fetchPage: async ({ cursor }) => { seen.push(cursor); return pages[cursor ? Number(cursor) : 0] },
    })
    const res = await new SyncEngine(deps).sync()
    expect(res).toEqual({ status: 'completed', pages: 2, added: 3 })
    // 首页必须从 null 起（每次全量），随后按 nextCursor 分页。
    expect(seen[0]).toBeNull()
    expect(seen).toEqual([null, '1'])
  })

  it('always starts from null even after a prior sync (no cursor is persisted or resumed)', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const firstCursors: (string | null)[] = []
    const { deps } = makeDeps(pages, {
      fetchPage: async ({ cursor }) => { firstCursors.push(cursor); return pages[0] },
    })
    const engine = new SyncEngine(deps)
    await engine.sync()
    await engine.sync()
    // 两次同步都从 null 起——引擎不保存也不恢复游标。
    expect(firstCursors).toEqual([null, null])
  })

  it('is idempotent: a highlight already in the SQL index is skipped', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const { deps, syncedHlIds } = makeDeps(pages)
    syncedHlIds.add('h1')
    const res = await new SyncEngine(deps).sync()
    expect(res).toMatchObject({ status: 'completed', added: 0 })
  })

  it('restores a deleted doc: highlights missing from the index are re-added on the next sync', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1), hl('h2', s1)], nextCursor: '', done: true }]
    const { deps, index, syncedHlIds } = makeDeps(pages)
    // 首次同步：两条都建。
    expect(await new SyncEngine(deps).sync()).toMatchObject({ status: 'completed', added: 2 })
    // 模拟用户删掉该文档：思源清掉块属性 → 已同步 id 消失（含 sourceDocMap）。
    syncedHlIds.clear()
    delete index.sourceDocMap.s1
    // 再次点同步：全量对账应把被删的重新建回来（增量游标做不到这一点）。
    const res = await new SyncEngine(deps).sync()
    expect(res).toMatchObject({ status: 'completed', added: 2 })
    expect(index.sourceDocMap.s1).toBeDefined()
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

  it('aborted before drain starts → skipped', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const { deps } = makeDeps(pages, { isAborted: () => true })
    expect(await new SyncEngine(deps).sync()).toEqual({ status: 'skipped' })
  })

  it('aborts between source groups mid-drain: later sources not written', async () => {
    const s1 = src('s1')
    const s2 = src('s2')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1), hl('h2', s2)], nextCursor: '', done: true }]
    let aborted = false
    const written: string[] = []
    const { deps } = makeDeps(pages, {
      isAborted: () => aborted,
      writeSource: async (source) => { written.push(source.id); aborted = true; return { docId: 'd', added: 0 } },
    })
    const res = await new SyncEngine(deps).sync()
    expect(written).toEqual(['s1']) // abort 在 s1 后置真，s2 不再写
    expect(res).toEqual({ status: 'skipped' })
  })

  it('is single-flight: a concurrent sync while one is running → skipped', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const { deps } = makeDeps(pages, {
      fetchPage: async ({ cursor }) => { await gate; return pages[cursor ? Number(cursor) : 0] },
    })
    const engine = new SyncEngine(deps)
    const first = engine.sync()
    const second = await engine.sync() // 第一次还卡在 gate 上
    expect(second).toEqual({ status: 'skipped' })
    release()
    expect(await first).toMatchObject({ status: 'completed' })
  })

  it('maps AuthError → auth_failed', async () => {
    const { deps } = makeDeps([], { fetchPage: async () => { throw new AuthError() } })
    expect(await new SyncEngine(deps).sync()).toEqual({ status: 'auth_failed' })
  })

  it('maps SyncIndexError → index_error (never a silent backoff retry)', async () => {
    const { deps } = makeDeps([], {
      loadSyncedIndex: async () => { throw new SyncIndexError('seed_truncated', 'truncated') },
    })
    expect(await new SyncEngine(deps).sync()).toEqual({ status: 'index_error', reason: 'truncated' })
  })

  it('maps a mid-drain SyncIndexError (create budget blown) → index_error', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const { deps } = makeDeps(pages, {
      writeSource: async () => { throw new SyncIndexError('create_budget_exceeded', 'too many') },
    })
    expect(await new SyncEngine(deps).sync()).toEqual({ status: 'index_error', reason: 'too many' })
  })

  it('carries the failure reason on the generic backoff so the UI can show it', async () => {
    // 曾经只把原因交给 onStatus（index.ts 里是空函数），结果弹窗只说"同步已延后 60s"，
    // 用户必须去翻控制台才知道发生了什么。
    const { deps } = makeDeps([], { fetchPage: async () => { throw new Error('forwardProxy timeout') } })
    expect(await new SyncEngine(deps).sync())
      .toEqual({ status: 'backoff', retryAfterSeconds: 60, reason: 'forwardProxy timeout' })
  })

  it('maps RateLimitError → backoff', async () => {
    const { deps } = makeDeps([], { fetchPage: async () => { throw new RateLimitError(12) } })
    expect(await new SyncEngine(deps).sync()).toEqual({ status: 'backoff', retryAfterSeconds: 12 })
  })
})
