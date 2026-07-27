import { describe, expect, it } from 'vitest'
import { MAX_KNOWN_FOLDERS, migrateDocsToFolder, planDestinationChange, rememberFolders } from './folderMigration'
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

  it('flags migration when only the notebook changed (regression: notebook switch was a no-op)', () => {
    // 曾经只在文件夹变更时置 migrationPending，于是"只换笔记本"会触发同步却不迁移；
    // docMap 里的旧文档按 block id 校验照样通过，新高亮继续写进旧笔记本，换笔记本形同无效。
    const plan = planDestinationChange(at('nb-a', '/Acorny'), at('nb-b', '/Acorny'))
    expect(plan).toEqual({ destinationChanged: true, folderChanged: false, needsMigration: true })
  })

  it('flags migration when only the folder changed', () => {
    expect(planDestinationChange(at('nb-a', '/Acorny'), at('nb-a', '/Acorny2')))
      .toEqual({ destinationChanged: true, folderChanged: true, needsMigration: true })
  })

  it('flags nothing when the destination is unchanged', () => {
    expect(planDestinationChange(at('nb-a', '/Acorny'), at('nb-a', '/Acorny')))
      .toEqual({ destinationChanged: false, folderChanged: false, needsMigration: false })
  })

  it('treats equivalent folder spellings as unchanged (no pointless migration or sync)', () => {
    expect(planDestinationChange(at('nb-a', 'Acorny'), at('nb-a', '/Acorny/')))
      .toEqual({ destinationChanged: false, folderChanged: false, needsMigration: false })
  })

  it('still migrates when no notebook was configured before (plugin state can be lost while docs remain)', () => {
    // 曾以「之前没选过笔记本 = 不存在已有文档」为由跳过迁移。反例：用户删掉 data.json
    // 重装插件，库里 446 篇文档原封不动，prev.notebookId 却是空——于是文档永远留在旧
    // 文件夹，无论怎么改设置都搬不走。真正没东西可搬的场景由 migrateDocsToFolder 自己
    // 处理（空列表连目标文件夹都不建），不需要在这里猜。
    expect(planDestinationChange(at('', '/Acorny'), at('nb-a', '/Acorny2')))
      .toEqual({ destinationChanged: true, folderChanged: true, needsMigration: true })
  })
})
