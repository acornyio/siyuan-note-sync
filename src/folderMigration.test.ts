import { describe, expect, it } from 'vitest'
import { migrateDocsToFolder } from './folderMigration'
import type { SiyuanClient } from './siyuanClientCore'

/** 内存版思源：文档有 hpath、锚定属性；删除即从 map 移除（kramdown 变空串）。 */
function fakeClient() {
  const docs = new Map<string, { hpath: string; sourceId: string | null }>()
  const moves: { fromIDs: string[]; toID: string }[] = []
  const created: string[] = []
  let n = 0
  const add = (hpath: string, sourceId: string | null) => {
    const id = `doc${++n}`
    docs.set(id, { hpath, sourceId })
    return id
  }
  const client = {
    async getIDsByHPath(_nb: string, hpath: string) {
      return [...docs].filter(([, d]) => d.hpath === hpath).map(([id]) => id)
    },
    async getHPathByID(id: string) { return docs.get(id)?.hpath ?? '' },
    async createDocWithMd(_nb: string, hpath: string) { created.push(hpath); return add(hpath, null) },
    async getBlockKramdown(id: string) {
      const d = docs.get(id)
      if (!d) return '' // 已删除
      return `{: ${d.sourceId ? `custom-acorny-source-id="${d.sourceId}" ` : ''}id="${id}" type="doc"}`
    },
    async moveDocsByID(fromIDs: string[], toID: string) {
      moves.push({ fromIDs, toID })
      const target = docs.get(toID)!.hpath
      for (const id of fromIDs) {
        const d = docs.get(id)!
        d.hpath = `${target}/${d.hpath.split('/').pop()}`
      }
    },
  } as unknown as SiyuanClient
  return { client, docs, moves, created, add, remove: (id: string) => docs.delete(id) }
}

const run = (f: ReturnType<typeof fakeClient>, docIds: string[], targetFolder = '/Acorny2') =>
  migrateDocsToFolder(f.client, { notebookId: 'nb', targetFolder, docIds })

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

  it('moves in one batched call rather than one request per doc', async () => {
    const f = fakeClient()
    const ids = ['a', 'b', 'c'].map((t) => f.add(`/Acorny/${t}`, `s-${t}`))
    await run(f, ids)
    expect(f.moves).toHaveLength(1)
    expect(f.moves[0].fromIDs).toEqual(ids)
  })
})
