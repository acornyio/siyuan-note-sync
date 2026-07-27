import { describe, expect, it } from 'vitest'
import { createSiyuanGateway, MIN_NEW_DOCS_PER_SYNC, SEED_ROW_LIMIT, SyncIndexError } from './siyuanGateway'
import type { SiyuanClient } from './siyuanClientCore'
import type { ExportFeedHighlight, ExportFeedSource, SyncedIndex } from './types'

const s1: ExportFeedSource = { id: 's1', title: 'Deep Work', author: null, canonicalUrl: '', type: 'article' }
const hl = (id: string, s = s1): ExportFeedHighlight => ({
  id, quote: id, quoteMarkdown: null, note: null, tags: [], updatedAt: '', source: s,
})

/**
 * 内存版 fake：建模"思源里的文档"——每个 doc 有属性 + 已同步高亮 id 列表。
 * getBlockAttrs / getBlockKramdown 直读该模型（无延迟）；删除用 `remove(id)` 模拟。
 * querySql 只返回已 settle 的 source-id 行（用于冷启动种子）。
 */
function fakeClient(opts: { attributesIndexed?: boolean } = {}) {
  const docs = new Map<string, { attrs: Record<string, string>; hlIds: string[]; path: string }>()
  const created: string[] = []
  const statements: string[] = []
  // false = 建模 attributes 表尚未索引完（真机 1–2s 窗口），此时所有 SQL 查属性一律查不到。
  const attributesIndexed = opts.attributesIndexed ?? true
  let n = 0
  const client: SiyuanClient = {
    async lsNotebooks() { return [] },
    async createDocWithMd(_nb, path, _md) { const id = `doc${++n}`; docs.set(id, { attrs: {}, hlIds: [], path }); created.push(path); return id },
    // 真机实测：按 hpath 查 id **零延迟**（建完立刻可见），与滞后 1–2s 的 attributes 表不同。
    async getIDsByHPath(_nb, hpath) {
      return [...docs].filter(([, d]) => d.path === hpath).map(([id]) => id)
    },
    async appendBlock(parentId, md) {
      const id = `blk${++n}`
      const d = docs.get(parentId)
      const m = /custom-acorny-id="([^"]+)"/.exec(md)
      if (d && m) d.hlIds.push(m[1])
      return id
    },
    async setBlockAttrs(id, attrs) { const d = docs.get(id); if (d) Object.assign(d.attrs, attrs) },
    async getHPathByID(id) { return docs.get(id)?.path ?? '' },
    async getDocNotebookId(id) { return docs.has(id) ? 'nb' : '' },
    async removeDocByID(id) { docs.delete(id) },
    async moveDocsByID(fromIDs, toID) {
      const target = docs.get(toID)!.path
      for (const id of fromIDs) { const d = docs.get(id)!; d.path = `${target}/${d.path.split('/').pop()}` }
    },
    async getBlockKramdown(id) {
      const d = docs.get(id)
      // 真机语义（实测）：文档不存在 → 空串；存在但没内容 → 仍有文档根块 IAL，非空。
      if (!d) return ''
      const body = d.hlIds.map((h) => `- body\n{: custom-acorny-id="${h}"}`).join('\n')
      const src = d.attrs['custom-acorny-source-id']
      const anchor = `{: ${src ? `custom-acorny-source-id="${src}" ` : ''}id="${id}" type="doc"}`
      return `${body}\n${anchor}`
    },
    async querySql<T>(stmt: string) {
      statements.push(stmt)
      if (!attributesIndexed) return [] as unknown as T[]
      let rows: { block_id: string; value: string }[] = []
      for (const [id, d] of docs) { const v = d.attrs['custom-acorny-source-id']; if (v) rows.push({ block_id: id, value: v }) }
      // 建模 `... AND value = 'x'` 点查（注意 SQL 字面量里的 '' 转义）。
      const eq = /value = '((?:[^']|'')*)'/.exec(stmt)
      if (eq) { const want = eq[1].replace(/''/g, "'"); rows = rows.filter((r) => r.value === want) }
      // 建模真实内核：语句无显式 LIMIT 时默认只返回 64 行（3.7.3 实测）。
      const lim = /LIMIT (\d+)/.exec(stmt)
      return rows.slice(0, lim ? Number(lim[1]) : KERNEL_DEFAULT_SQL_LIMIT) as unknown as T[]
    },
    forwardProxy: async () => ({ status: 200, body: '', headers: {} }),
  }
  return { client, docs, created, statements, remove: (id: string) => docs.delete(id) }
}

/** 内核对无显式 LIMIT 的 SQL 语句施加的默认行数上限（实测 3.7.3）。 */
const KERNEL_DEFAULT_SQL_LIMIT = 64

/** 在 fake 里预置 n 篇「上个会话已同步」的文档（SQL 已 settle，内存 docMap 为空）。 */
async function seedExistingDocs(f: ReturnType<typeof fakeClient>, n: number): Promise<ExportFeedSource[]> {
  const sources: ExportFeedSource[] = []
  for (let i = 0; i < n; i++) {
    const s: ExportFeedSource = { id: `src-${i}`, title: `Doc ${i}`, author: null, canonicalUrl: '', type: 'article' }
    const id = await f.client.createDocWithMd('nb', `/Acorny/Doc ${i}`, '')
    await f.client.setBlockAttrs(id, { 'custom-acorny-source-id': s.id })
    sources.push(s)
  }
  f.created.length = 0 // 只统计后续同步新建的文档
  return sources
}

const gw = (client: SiyuanClient, docMap: Record<string, string> = {}, over: Partial<{ isAborted: () => boolean }> = {}) =>
  createSiyuanGateway(client, { notebookId: 'nb', docFolderPath: '/Acorny', docMap, ...over })

const empty = (map: Record<string, string> = {}): SyncedIndex => ({ sourceDocMap: map })

describe('siyuanGateway.writeSource', () => {
  it('creates a source doc anchored by custom-acorny-source-id and appends the highlight', async () => {
    const f = fakeClient()
    const map: Record<string, string> = {}
    const res = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    expect(f.created).toEqual(['/Acorny/Deep Work'])
    expect(f.docs.get(res.docId)!.attrs['custom-acorny-source-id']).toBe('s1')
    expect(f.docs.get(res.docId)!.hlIds).toEqual(['h1'])
    expect(map.s1).toBe(res.docId) // 记入内存 docMap
    expect(res.added).toBe(1)
  })

  it('reuses the doc from docMap and dedups highlights already present (idempotent, per-doc kramdown)', async () => {
    const f = fakeClient()
    const map: Record<string, string> = {}
    const g = gw(f.client, map)
    await g.writeSource(s1, [hl('h1')], empty(map))
    const res = await g.writeSource(s1, [hl('h1'), hl('h2')], empty(map))
    expect(f.created).toHaveLength(1) // 没有重复建文档
    expect(res.added).toBe(1) // 只补 h2
    expect(f.docs.get(map.s1)!.hlIds).toEqual(['h1', 'h2'])
  })

  it('does NOT duplicate on a rapid re-sync: docMap carries the just-created doc even if SQL still lags', async () => {
    const f = fakeClient()
    const map: Record<string, string> = {}
    // 第一次同步建了文档并记入 map；querySql 此刻仍可能滞后（这里 fake 直接返回，但真机滞后）——
    // 关键是第二次靠 docMap + getBlockAttrs 校验命中，不重复建。
    await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    const res = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    expect(f.created).toHaveLength(1)
    expect(res.added).toBe(0)
  })

  it('self-heals a deleted doc: recreates it and re-appends all highlights', async () => {
    const f = fakeClient()
    const map: Record<string, string> = {}
    const first = await gw(f.client, map).writeSource(s1, [hl('h1'), hl('h2')], empty(map))
    f.remove(first.docId) // 用户删掉了这篇文档
    const res = await gw(f.client, map).writeSource(s1, [hl('h1'), hl('h2')], empty(map))
    expect(res.docId).not.toBe(first.docId) // 建了新文档
    expect(res.added).toBe(2) // 两条都重建
    expect(f.docs.get(res.docId)!.hlIds).toEqual(['h1', 'h2'])
    expect(map.s1).toBe(res.docId)
  })

  it('ignores a poisoned docMap entry that anchors a different source (no append to the wrong doc)', async () => {
    const f = fakeClient()
    // 预置一篇属于 other 的文档，把 map.s1 指向它（污染）
    const otherId = await f.client.createDocWithMd('nb', '/Acorny/Other', '')
    await f.client.setBlockAttrs(otherId, { 'custom-acorny-source-id': 'other' })
    const map: Record<string, string> = { s1: otherId }
    const res = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    expect(res.docId).not.toBe(otherId) // 不复用锚定不符的文档
    expect(f.docs.get(otherId)!.hlIds).toEqual([]) // other 文档没被写入
  })

  it('stops appending remaining highlights once isAborted becomes true', async () => {
    const f = fakeClient()
    const map: Record<string, string> = {}
    const g = gw(f.client, map, { isAborted: () => (f.docs.get(map.s1)?.hlIds.length ?? 0) >= 1 })
    const res = await g.writeSource(s1, [hl('h1'), hl('h2'), hl('h3')], empty(map))
    expect(res.added).toBe(1)
    expect(f.docs.get(map.s1)!.hlIds).toEqual(['h1'])
  })
})

describe('siyuanGateway.loadSyncedIndex', () => {
  it('cold start: seeds docMap from the settled SQL source-id rows (reuses pre-existing docs, no dup)', async () => {
    const f = fakeClient()
    // 已存在一篇 s1 的文档（上个会话建的，SQL 已 settle），但内存 docMap 为空（重装/重载）
    const existing = await f.client.createDocWithMd('nb', '/Acorny/Deep Work', '')
    await f.client.setBlockAttrs(existing, { 'custom-acorny-source-id': 's1' })
    const map: Record<string, string> = {}
    const g = gw(f.client, map)
    const index = await g.loadSyncedIndex()
    expect(index.sourceDocMap.s1).toBe(existing) // 种子命中
    const res = await g.writeSource(s1, [hl('h1')], index)
    expect(res.docId).toBe(existing) // 种子命中
    expect(f.created).toHaveLength(1) // 只有最初那篇
  })

  it('seeds every source beyond the kernel default row cap (regression: 64-row silent truncation)', async () => {
    // 事故复现：内核对无显式 LIMIT 的语句默认只返回 64 行。用户有 100 个 source 时，
    // 冷启动种子若被静默截断到 64，剩下 36 个会被判成"从没同步过"→ 每次同步重建一遍文档。
    const f = fakeClient()
    const sources = await seedExistingDocs(f, 100)
    expect(sources.length).toBeGreaterThan(KERNEL_DEFAULT_SQL_LIMIT)
    const map: Record<string, string> = {}
    const g = gw(f.client, map)
    const index = await g.loadSyncedIndex()
    expect(Object.keys(index.sourceDocMap)).toHaveLength(100)
    for (const s of sources) await g.writeSource(s, [hl('h1', s)], index)
    expect(f.created).toEqual([]) // 一篇都不该新建
  })

  it('throws instead of silently proceeding when the seed query hits its row limit', async () => {
    // 触顶意味着"结果可能不完整"。不完整的索引会被下游理解成"没同步过"→ 重复建档，
    // 所以必须中止同步，而不是拿一份残缺索引继续跑。
    const f = fakeClient()
    const rows = Array.from({ length: SEED_ROW_LIMIT }, (_, i) => ({ block_id: `d${i}`, value: `s${i}` }))
    const client = { ...f.client, querySql: async <T>() => rows as unknown as T[] }
    await expect(gw(client, {}).loadSyncedIndex()).rejects.toBeInstanceOf(SyncIndexError)
  })
})

describe('siyuanGateway 重复文档熔断', () => {
  it('falls back to a point lookup before creating, so a lost docMap never duplicates existing docs', async () => {
    // docMap 未命中 ≠ 文档不存在。建档前必须针对该 source 精确查一次——点查带 WHERE，
    // 不受任何批量截断影响，是"绝不重复建档"的最后保证。
    const f = fakeClient()
    const existing = await f.client.createDocWithMd('nb', '/Acorny/Deep Work', '')
    await f.client.setBlockAttrs(existing, { 'custom-acorny-source-id': 's1' })
    f.created.length = 0
    // 故意跳过 loadSyncedIndex：docMap 与 index 都是空的（模拟种子彻底失效）
    const res = await gw(f.client, {}).writeSource(s1, [hl('h1')], empty())
    expect(res.docId).toBe(existing)
    expect(f.created).toEqual([])
  })

  it('escapes the source id in the point lookup instead of interpolating it raw', async () => {
    const f = fakeClient()
    const nasty: ExportFeedSource = { ...s1, id: "s'1" }
    await gw(f.client, {}).writeSource(nasty, [], empty())
    const lookup = f.statements.find((s) => s.includes('value ='))!
    expect(lookup).toContain("value = 's''1'")
  })

  it('aborts the sync once new-doc creations blow past the budget', async () => {
    const f = fakeClient()
    await seedExistingDocs(f, 5) // baseline 5 → 预算 = max(MIN_NEW_DOCS_PER_SYNC, 5)
    const map: Record<string, string> = {}
    const g = gw(f.client, map)
    const index = await g.loadSyncedIndex()
    const write = async (i: number) => {
      const s: ExportFeedSource = { id: `new-${i}`, title: `New ${i}`, author: null, canonicalUrl: '', type: 'article' }
      await g.writeSource(s, [hl('h1', s)], index)
    }
    for (let i = 0; i < MIN_NEW_DOCS_PER_SYNC; i++) await write(i)
    await expect(write(MIN_NEW_DOCS_PER_SYNC)).rejects.toBeInstanceOf(SyncIndexError)
  })

  it('lets a full rebuild through after the user purged every doc (dead entries lower the baseline)', async () => {
    // 用户清空整个 Acorny 文件夹后再同步：全部 source 都要重建，数量必然远超预算。
    // 但每一次"docMap 有条目、getBlockAttrs 却说文档没了"都是**实时核实过**的删除证据，
    // 应当相应下调基线——否则熔断会把合法的整库重建也挡掉。
    const f = fakeClient()
    const sources = await seedExistingDocs(f, MIN_NEW_DOCS_PER_SYNC + 20)
    const map: Record<string, string> = {}
    const g = gw(f.client, map)
    const index = await g.loadSyncedIndex()
    for (const id of [...f.docs.keys()]) f.remove(id) // 用户删光了
    // 期间 Acorny 侧还新增了几篇文章——重建量因此**超过**原基线，正好压在预算边界之外。
    const added: ExportFeedSource[] = [1, 2, 3].map((i): ExportFeedSource => (
      { id: `fresh-${i}`, title: `Fresh ${i}`, author: null, canonicalUrl: '', type: 'article' }
    ))
    for (const s of [...sources, ...added]) await g.writeSource(s, [hl('h1', s)], index)
    expect(f.created).toHaveLength(sources.length + added.length) // 全部重建，没有被熔断挡住
  })

  it('treats a contentless-but-existing doc as present (kramdown still carries the doc IAL)', async () => {
    // 回归：`getBlockAttrs` 对已删文档仍返回属性，不能当存在性判据；改用 kramdown 空串判定。
    // 但"存在却没内容"的文档 kramdown **非空**（含根块 IAL），绝不能被误判成已删除而重建。
    const f = fakeClient()
    const map: Record<string, string> = {}
    const first = await gw(f.client, map).writeSource(s1, [], empty(map)) // 建了文档，一条高亮都没写
    expect(f.docs.get(first.docId)!.hlIds).toEqual([])
    f.created.length = 0
    const res = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    expect(res.docId).toBe(first.docId) // 复用那篇空文档
    expect(f.created).toEqual([]) // 没有重建
  })

  it('detects a deleted doc via empty kramdown and rebuilds it', async () => {
    const f = fakeClient()
    const map: Record<string, string> = {}
    const first = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    f.remove(first.docId)
    const res = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    expect(res.docId).not.toBe(first.docId)
    expect(res.added).toBe(1)
  })

  it('skips a stale point-lookup row whose doc is already gone (attributes table lags ~3s on delete)', async () => {
    // 删除后 attributes 表还会返回该行几秒。点查必须逐个校验，不能拿到行就当文档还在。
    const f = fakeClient()
    const map: Record<string, string> = {}
    const first = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    const ghost = { block_id: first.docId, value: s1.id }
    f.remove(first.docId)
    // 点查仍返回这条滞后的行
    const client = { ...f.client, querySql: async <T>(stmt: string) => (
      stmt.includes('value =') ? [ghost] as unknown as T[] : await f.client.querySql<T>(stmt)
    ) }
    f.created.length = 0
    const res = await gw(client, {}).writeSource(s1, [hl('h1')], empty())
    expect(res.docId).not.toBe(first.docId) // 没有复用已删的幽灵文档
    expect(f.created).toHaveLength(1)
  })

  it('reuses an existing doc via the lag-free hpath lookup while the attributes table is still indexing', async () => {
    // 真机实测：文档建好后 attributes 表要 1–2s 才能查到，而 getIDsByHPath 立刻可见。
    // 若这段窗口内 docMap 恰好为空（data.json 丢失 / 刚重载），只靠 SQL 就会重复建档——
    // 这正是端到端探针抓到的失败。按路径查是这段窗口里唯一的可靠通道。
    const f = fakeClient({ attributesIndexed: false })
    const existing = await f.client.createDocWithMd('nb', '/Acorny/Deep Work', '')
    await f.client.setBlockAttrs(existing, { 'custom-acorny-source-id': 's1' })
    f.created.length = 0
    const res = await gw(f.client, {}).writeSource(s1, [hl('h1')], empty())
    expect(res.docId).toBe(existing)
    expect(f.created).toEqual([]) // 没有重复建档
  })

  it('finds a doc still sitting in a previously configured folder (no duplicate after changing folders)', async () => {
    // 用户把目标文件夹从 /Acorny 改成 /Acorny2，老文档还在 /Acorny（迁移没跑成 / 手动挪过）。
    // L3a 若只查当前文件夹就看不见它们 → attributes 表那 1–2s 窗口里会重复建档。
    const f = fakeClient({ attributesIndexed: false })
    const old = await f.client.createDocWithMd('nb', '/Acorny/Deep Work', '')
    await f.client.setBlockAttrs(old, { 'custom-acorny-source-id': 's1' })
    f.created.length = 0
    const g = createSiyuanGateway(f.client, {
      notebookId: 'nb', docFolderPath: '/Acorny2', knownFolders: ['/Acorny'], docMap: {},
    })
    const res = await g.writeSource(s1, [hl('h1')], empty())
    expect(res.docId).toBe(old)
    expect(f.created).toEqual([])
  })

  it('prefers the current folder when the same source somehow exists in both', async () => {
    const f = fakeClient({ attributesIndexed: false })
    const old = await f.client.createDocWithMd('nb', '/Acorny/Deep Work', '')
    await f.client.setBlockAttrs(old, { 'custom-acorny-source-id': 's1' })
    const current = await f.client.createDocWithMd('nb', '/Acorny2/Deep Work', '')
    await f.client.setBlockAttrs(current, { 'custom-acorny-source-id': 's1' })
    const g = createSiyuanGateway(f.client, {
      notebookId: 'nb', docFolderPath: '/Acorny2', knownFolders: ['/Acorny'], docMap: {},
    })
    expect((await g.writeSource(s1, [hl('h1')], empty())).docId).toBe(current)
  })

  it('does not adopt a same-titled doc that belongs to a different source', async () => {
    // 思源允许同名文档：按 hpath 查会命中别的 source 的文档，必须用锚定属性排除。
    const f = fakeClient({ attributesIndexed: false })
    const other = await f.client.createDocWithMd('nb', '/Acorny/Deep Work', '')
    await f.client.setBlockAttrs(other, { 'custom-acorny-source-id': 'other-source' })
    f.created.length = 0
    const res = await gw(f.client, {}).writeSource(s1, [hl('h1')], empty())
    expect(res.docId).not.toBe(other)
    expect(f.docs.get(other)!.hlIds).toEqual([]) // 别人的文档没被写脏
  })

  it('self-heals when appendBlock reports the parent doc vanished mid-write', async () => {
    // TOCTOU：读完 kramdown 之后、追加之前用户删掉了文档。内核报
    // `parent block not found: <id>`。整轮同步不该因此中断 60s，应重建后继续。
    const f = fakeClient()
    const map: Record<string, string> = {}
    const first = await gw(f.client, map).writeSource(s1, [hl('h1')], empty(map))
    let sabotaged = false
    const client: SiyuanClient = {
      ...f.client,
      async appendBlock(parentId, md) {
        if (!sabotaged) { sabotaged = true; f.remove(first.docId) }
        if (!f.docs.has(parentId)) throw new Error(`parent block not found: ${parentId} v3.7.3`)
        return f.client.appendBlock(parentId, md)
      },
    }
    const res = await gw(client, map).writeSource(s1, [hl('h1'), hl('h2')], empty(map))
    expect(res.docId).not.toBe(first.docId)
    expect(f.docs.get(res.docId)!.hlIds).toEqual(['h1', 'h2']) // 两条都补齐
  })

  it('still applies the budget when the index is empty but we have synced before (index suspect, not first run)', async () => {
    // baseline===0 曾无条件关掉熔断，于是分不清「首次同步」和「索引因故全空」——
    // 恰恰在最需要兜底时兜底失效。持久化的历史 source 数是区分二者的唯一信号。
    const f = fakeClient()
    const g = createSiyuanGateway(f.client, {
      notebookId: 'nb', docFolderPath: '/Acorny', docMap: {}, knownSourceCount: 400,
    })
    const index = await g.loadSyncedIndex() // 空库：种子查不到任何东西
    const write = async (i: number) => {
      const s: ExportFeedSource = { id: `new-${i}`, title: `New ${i}`, author: null, canonicalUrl: '', type: 'article' }
      await g.writeSource(s, [hl('h1', s)], index)
    }
    for (let i = 0; i < MIN_NEW_DOCS_PER_SYNC; i++) await write(i)
    await expect(write(MIN_NEW_DOCS_PER_SYNC)).rejects.toBeInstanceOf(SyncIndexError)
  })

  it('rolls back the freshly created doc when anchoring it fails (no unanchored orphans)', async () => {
    // 建档 → 记 docMap → setBlockAttrs 三步不原子。锚定失败若不回滚，会留下一篇没有
    // custom-acorny-source-id 的文档：下个会话 L3a 按路径找到它、readDocOf 因无锚定拒绝采用
    // → 再建一篇，孤儿永久堆积。
    const f = fakeClient()
    const client: SiyuanClient = {
      ...f.client,
      async setBlockAttrs() { throw new Error('kernel busy') },
    }
    const map: Record<string, string> = {}
    await expect(gw(client, map).writeSource(s1, [hl('h1')], empty(map))).rejects.toThrow('kernel busy')
    expect(map).toEqual({}) // docMap 不留悬空条目
    expect(f.docs.size).toBe(0) // 刚建的文档已被删除，没有无锚定孤儿
  })

  it('scans enough point-lookup candidates to survive a source with many historical duplicates', async () => {
    // 事故里单个 source 曾有 88 篇重复文档。若点查上限太小、返回的前几行又都是已删的滞后行，
    // 就会漏掉那篇还活着的 → 再建一篇。
    const f = fakeClient()
    const alive = await f.client.createDocWithMd('nb', '/Acorny/Deep Work', '')
    await f.client.setBlockAttrs(alive, { 'custom-acorny-source-id': 's1' })
    const ghosts = Array.from({ length: 80 }, (_, i) => ({ block_id: `dead-${i}`, value: 's1' }))
    const client: SiyuanClient = {
      ...f.client,
      // 点查返回 80 条已删的滞后行在前、活着的那条在最后
      async querySql<T>(stmt: string) {
        if (!stmt.includes('value =')) return [] as unknown as T[]
        const lim = Number(/LIMIT (\d+)/.exec(stmt)![1])
        return [...ghosts, { block_id: alive, value: 's1' }].slice(0, lim) as unknown as T[]
      },
    }
    f.created.length = 0
    const res = await createSiyuanGateway(client, {
      notebookId: 'nb', docFolderPath: '/Other', docMap: {}, // 换个文件夹让 L3a 查不到，逼它走点查
    }).writeSource(s1, [hl('h1')], empty())
    expect(res.docId).toBe(alive)
    expect(f.created).toEqual([])
  })

  it('does not apply the budget on a first-ever sync (empty index → everything is legitimately new)', async () => {
    const f = fakeClient()
    const g = gw(f.client, {})
    const index = await g.loadSyncedIndex() // 空库
    for (let i = 0; i <= MIN_NEW_DOCS_PER_SYNC; i++) {
      const s: ExportFeedSource = { id: `new-${i}`, title: `New ${i}`, author: null, canonicalUrl: '', type: 'article' }
      await g.writeSource(s, [hl('h1', s)], index)
    }
    expect(f.created.length).toBe(MIN_NEW_DOCS_PER_SYNC + 1)
  })
})
