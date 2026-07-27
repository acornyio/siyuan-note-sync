import { describe, expect, it } from 'vitest'
import {
  findDocsOutsideFolder, LOCATION_SCAN_LIMIT, MAX_KNOWN_FOLDERS, migrateDocsToFolder,
  planDestinationChange, rememberFolders,
} from './folderMigration'
import { SyncIndexError } from './siyuanGateway'
import type { SiyuanClient } from './siyuanClientCore'

const NB = 'nb'
const OTHER_NB = 'nb-other'

/**
 * 内存版思源：文档有笔记本 + hpath + 锚定属性；删除即从 map 移除（kramdown 变空串）。
 * hpath 是**笔记本内相对路径**——不同笔记本里的同名文件夹 hpath 完全一样，这正是跨笔记本
 * 迁移必须同时比对 notebook 的原因。
 */
function fakeClient() {
  const docs = new Map<string, { notebookId: string; hpath: string; sourceId: string | null }>()
  const moves: { fromIDs: string[]; toID: string }[] = []
  const created: string[] = []
  let n = 0
  const add = (hpath: string, sourceId: string | null, notebookId = NB) => {
    const id = `doc${++n}`
    docs.set(id, { notebookId, hpath, sourceId })
    return id
  }
  const client = {
    async getIDsByHPath(nb: string, hpath: string) {
      return [...docs].filter(([, d]) => d.notebookId === nb && d.hpath === hpath).map(([id]) => id)
    },
    async getHPathByID(id: string) { return docs.get(id)?.hpath ?? '' },
    async getDocNotebookId(id: string) { return docs.get(id)?.notebookId ?? '' },
    async createDocWithMd(nb: string, hpath: string) { created.push(hpath); return add(hpath, null, nb) },
    async getBlockKramdown(id: string) {
      const d = docs.get(id)
      if (!d) return '' // 已删除
      return `{: ${d.sourceId ? `custom-acorny-source-id="${d.sourceId}" ` : ''}id="${id}" type="doc"}`
    },
    async moveDocsByID(fromIDs: string[], toID: string) {
      moves.push({ fromIDs, toID })
      const target = docs.get(toID)!
      for (const id of fromIDs) {
        const d = docs.get(id)!
        d.hpath = `${target.hpath}/${d.hpath.split('/').pop()}`
        d.notebookId = target.notebookId // 跨笔记本移动：文档会落到目标所在的笔记本
      }
    },
  } as unknown as SiyuanClient
  return { client, docs, moves, created, add, remove: (id: string) => docs.delete(id) }
}

const run = (f: ReturnType<typeof fakeClient>, docIds: string[], targetFolder = '/Acorny2') =>
  migrateDocsToFolder(f.client, { notebookId: NB, targetFolder, docIds })

describe('migrateDocsToFolder', () => {
  it('moves anchored docs out of the old folder into the target folder', async () => {
    const f = fakeClient()
    const a = f.add('/Acorny/Deep Work', 's1')
    const b = f.add('/Acorny/Shape Up', 's2')
    const res = await run(f, [a, b])
    expect(res.moved).toBe(2)
    expect(f.docs.get(a)!.hpath).toBe('/Acorny2/Deep Work')
    expect(f.docs.get(b)!.hpath).toBe('/Acorny2/Shape Up')
  })

  it('creates the target folder when it does not exist yet', async () => {
    const f = fakeClient()
    const a = f.add('/Acorny/Deep Work', 's1')
    await run(f, [a])
    expect(f.created).toEqual(['/Acorny2'])
  })

  it('reuses an existing target folder instead of creating a second one', async () => {
    const f = fakeClient()
    f.add('/Acorny2', null) // 目标文件夹已存在
    const a = f.add('/Acorny/Deep Work', 's1')
    await run(f, [a])
    expect(f.created).toEqual([])
  })

  it('skips docs already in the target folder (no pointless churn)', async () => {
    const f = fakeClient()
    f.add('/Acorny2', null)
    const stay = f.add('/Acorny2/Already There', 's1')
    const move = f.add('/Acorny/Deep Work', 's2')
    const res = await run(f, [stay, move])
    expect(res.moved).toBe(1)
    expect(f.moves.flatMap((m) => m.fromIDs)).toEqual([move])
  })

  it('skips docs the user already deleted (empty kramdown), never resurrecting them', async () => {
    const f = fakeClient()
    const gone = f.add('/Acorny/Gone', 's1')
    const alive = f.add('/Acorny/Alive', 's2')
    f.remove(gone)
    const res = await run(f, [gone, alive])
    expect(res.moved).toBe(1)
    expect(res.skipped).toBe(1)
    expect(f.moves.flatMap((m) => m.fromIDs)).toEqual([alive])
  })

  it('refuses to move a doc that is not an Acorny doc (no anchor) — never touches user documents', async () => {
    const f = fakeClient()
    const foreign = f.add('/Acorny/Handwritten Note', null)
    const res = await run(f, [foreign])
    expect(res.moved).toBe(0)
    expect(f.moves).toEqual([])
    expect(f.docs.get(foreign)!.hpath).toBe('/Acorny/Handwritten Note')
  })

  it('does nothing at all when there is nothing to move (no folder gets created)', async () => {
    const f = fakeClient()
    const res = await run(f, [])
    expect(res).toEqual({ moved: 0, skipped: 0 })
    expect(f.created).toEqual([])
    expect(f.moves).toEqual([])
  })

  it('moves a doc sitting in a same-named folder of ANOTHER notebook (hpath alone is ambiguous)', async () => {
    // 用户只换了笔记本、文件夹名不变。hpath 是笔记本内相对路径，两边都叫 /Acorny，
    // 只比 hpath 前缀会误判成"已经在目标文件夹里"→ 永远搬不过去，换笔记本形同无效。
    const f = fakeClient()
    const stale = f.add('/Acorny/Deep Work', 's1', OTHER_NB)
    const res = await migrateDocsToFolder(f.client, { notebookId: NB, targetFolder: '/Acorny', docIds: [stale] })
    expect(res.moved).toBe(1)
    expect(f.docs.get(stale)!.notebookId).toBe(NB)
    expect(f.docs.get(stale)!.hpath).toBe('/Acorny/Deep Work')
  })

  it('still skips a doc already in the target folder OF THE TARGET NOTEBOOK', async () => {
    const f = fakeClient()
    const here = f.add('/Acorny/Deep Work', 's1', NB)
    const res = await migrateDocsToFolder(f.client, { notebookId: NB, targetFolder: '/Acorny', docIds: [here] })
    expect(res).toEqual({ moved: 0, skipped: 1 })
    expect(f.moves).toEqual([])
  })

  it('moves in one batched call rather than one request per doc', async () => {
    const f = fakeClient()
    const ids = ['a', 'b', 'c'].map((t) => f.add(`/Acorny/${t}`, `s-${t}`))
    await run(f, ids)
    expect(f.moves).toHaveLength(1)
    expect(f.moves[0].fromIDs).toEqual(ids)
  })
})

describe('findDocsOutsideFolder', () => {
  /** 建模 blocks ⋈ attributes 的联表查询：返回所有 acorny 文档的 box + hpath。 */
  const clientWith = (rows: { id: string; box: string; hpath: string }[], limitOverride?: number) => ({
    async querySql<T>(stmt: string) {
      const lim = limitOverride ?? Number(/LIMIT (\d+)/.exec(stmt)![1])
      return rows.slice(0, lim) as unknown as T[]
    },
  } as unknown as SiyuanClient)

  const at = (id: string, hpath: string, box = NB) => ({ id, box, hpath })

  it('reports docs sitting in a different folder', async () => {
    const c = clientWith([at('d1', '/Acorny33/Deep Work'), at('d2', '/Acorny11/Shape Up')])
    expect(await findDocsOutsideFolder(c, { notebookId: NB, targetFolder: '/Acorny11' })).toEqual(['d1'])
  })

  it('reports docs sitting in another notebook even when the path matches', async () => {
    const c = clientWith([at('d1', '/Acorny11/Deep Work', OTHER_NB)])
    expect(await findDocsOutsideFolder(c, { notebookId: NB, targetFolder: '/Acorny11' })).toEqual(['d1'])
  })

  it('treats nested paths under the target as already in place', async () => {
    const c = clientWith([at('d1', '/Acorny11/Books/Deep Work')])
    expect(await findDocsOutsideFolder(c, { notebookId: NB, targetFolder: '/Acorny11' })).toEqual([])
  })

  it('is not fooled by a folder that merely shares a prefix', async () => {
    // /Acorny111 不是 /Acorny11 的子目录。少了分隔符就会把它误判成"已在目标里"。
    const c = clientWith([at('d1', '/Acorny111/Deep Work')])
    expect(await findDocsOutsideFolder(c, { notebookId: NB, targetFolder: '/Acorny11' })).toEqual(['d1'])
  })

  it('normalizes the configured folder spelling', async () => {
    const c = clientWith([at('d1', '/Acorny11/Deep Work')])
    expect(await findDocsOutsideFolder(c, { notebookId: NB, targetFolder: 'Acorny11/' })).toEqual([])
  })

  it('throws instead of silently reporting a partial picture when the query hits its row limit', async () => {
    // 触顶 = 结果可能不完整。据此去搬文档等于凭残缺信息动用户的文档树，必须中止。
    const rows = Array.from({ length: LOCATION_SCAN_LIMIT }, (_, i) => at(`d${i}`, '/Elsewhere/x'))
    await expect(findDocsOutsideFolder(clientWith(rows), { notebookId: NB, targetFolder: '/Acorny11' }))
      .rejects.toBeInstanceOf(SyncIndexError)
  })
})

describe('rememberFolders', () => {
  it('keeps the old folder so the lag-free lookup can still reach un-migrated docs', () => {
    expect(rememberFolders([], '/Acorny', '/Acorny2')).toEqual(['/Acorny'])
  })

  it('never records the current folder, and never duplicates', () => {
    expect(rememberFolders(['/Acorny'], '/Acorny', '/Acorny2')).toEqual(['/Acorny'])
    expect(rememberFolders(['/A'], '/Acorny2', '/Acorny2')).toEqual(['/A'])
  })

  it('normalizes spellings so /Acorny, Acorny and /Acorny/ are one entry', () => {
    expect(rememberFolders(['/Acorny'], 'Acorny/', '/New')).toEqual(['/Acorny'])
  })

  it('caps history so repeated folder changes cannot grow the lookup cost without bound', () => {
    let history: string[] = []
    for (let i = 0; i < 12; i++) history = rememberFolders(history, `/F${i}`, '/Current')
    expect(history).toHaveLength(MAX_KNOWN_FOLDERS)
    expect(history).toContain('/F11') // 最近的留着
    expect(history).not.toContain('/F0') // 最老的淘汰
  })
})

describe('planDestinationChange', () => {
  const at = (notebookId: string, docFolderPath: string) => ({ notebookId, docFolderPath })

  it('reports a destination change when only the notebook changed', () => {
    const plan = planDestinationChange(at('nb-a', '/Acorny'), at('nb-b', '/Acorny'))
    expect(plan).toEqual({ destinationChanged: true, folderChanged: false })
  })

  it('reports a folder change', () => {
    expect(planDestinationChange(at('nb-a', '/Acorny'), at('nb-a', '/Acorny2')))
      .toEqual({ destinationChanged: true, folderChanged: true })
  })

  it('reports nothing when the destination is unchanged', () => {
    expect(planDestinationChange(at('nb-a', '/Acorny'), at('nb-a', '/Acorny')))
      .toEqual({ destinationChanged: false, folderChanged: false })
  })

  it('treats equivalent folder spellings as unchanged (no pointless migration or sync)', () => {
    expect(planDestinationChange(at('nb-a', 'Acorny'), at('nb-a', '/Acorny/')))
      .toEqual({ destinationChanged: false, folderChanged: false })
  })

  it('reports a destination change even when no notebook was configured before', () => {
    expect(planDestinationChange(at('', '/Acorny'), at('nb-a', '/Acorny2')))
      .toEqual({ destinationChanged: true, folderChanged: true })
  })
})
