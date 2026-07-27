// 用法: npx tsx scripts/kernel-crossnotebook-probe.mts <思源 API token>   （需本机思源正在运行）
// 验证「换笔记本」这条真机路径：跨笔记本 moveDocsByID 是否保住文档 id、锚定属性与高亮。
// 依赖真实内核，不进 CI。
//
// ⚠️ 安全设计（此前有过探针误删用户 447 篇文档的事故，以下约束由代码强制，不靠自觉）：
//   1. 只在**本探针新建的临时笔记本**里操作；笔记本 id 进白名单，清理时逐个校验
//   2. 探针自建的每个文档 id 进 owned 集合；moveDocsByID / removeDocByID 必须先过 assertOwned
//   3. findDocsOutsideFolder 会扫全库（含用户真实文档）——其结果**只用于断言**，
//      喂给迁移的永远是 owned 子集
//   4. source id 带唯一前缀，不可能与真实数据相撞
import { migrateDocsToFolder, findDocsOutsideFolder } from '../src/folderMigration'
import { extractAppendedBlockId, type SiyuanClient } from '../src/siyuanClientCore'

const token = process.argv[2]
const BASE = 'http://127.0.0.1:6806'
if (!token) { console.error('缺少 token 参数'); process.exit(2) }

async function post<T>(path: string, payload: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
    body: JSON.stringify(payload),
  })
  const j = (await r.json()) as { code: number; msg: string; data: T }
  if (j.code !== 0) throw new Error(`${path} failed (code ${j.code}): ${j.msg}`)
  return j.data
}

const ownedDocs = new Set<string>()
const ownedNotebooks = new Set<string>()
const assertOwnedDocs = (ids: string[]) => {
  const foreign = ids.filter((id) => !ownedDocs.has(id))
  if (foreign.length > 0) throw new Error(`拒绝操作非自建文档（${foreign.length} 篇）: ${foreign.slice(0, 3)}`)
}
const assertOwnedNotebook = (id: string) => {
  if (!ownedNotebooks.has(id)) throw new Error(`拒绝操作非自建笔记本: ${id}`)
}

const client: SiyuanClient = {
  async lsNotebooks() {
    return (await post<{ notebooks: { id: string; name: string }[] }>('/api/notebook/lsNotebooks', {})).notebooks
  },
  async createDocWithMd(notebook, path, markdown) {
    assertOwnedNotebook(notebook)
    const id = await post<string>('/api/filetree/createDocWithMd', { notebook, path, markdown })
    ownedDocs.add(id)
    return id
  },
  async getIDsByHPath(notebook, path) {
    return (await post<string[] | null>('/api/filetree/getIDsByHPath', { notebook, path })) ?? []
  },
  async getHPathByID(id) { return (await post<string | null>('/api/filetree/getHPathByID', { id })) ?? '' },
  async getDocNotebookId(id) { return (await post<{ box?: string }>('/api/block/getBlockInfo', { id })).box ?? '' },
  async moveDocsByID(fromIDs, toID) {
    assertOwnedDocs([...fromIDs, toID])
    await post('/api/filetree/moveDocsByID', { fromIDs, toID })
  },
  async removeDocByID(id) { assertOwnedDocs([id]); await post('/api/filetree/removeDocByID', { id }) },
  async appendBlock(parentID, data) {
    assertOwnedDocs([parentID])
    return extractAppendedBlockId(await post<unknown>('/api/block/appendBlock', { parentID, dataType: 'markdown', data }))
  },
  async setBlockAttrs(id, attrs) { assertOwnedDocs([id]); await post('/api/attr/setBlockAttrs', { id, attrs }) },
  async getBlockKramdown(id) {
    return (await post<{ kramdown?: string }>('/api/block/getBlockKramdown', { id })).kramdown ?? ''
  },
  async querySql<T>(stmt: string) { return post<T[]>('/api/query/sql', { stmt }) },
  forwardProxy: async () => ({ status: 200, body: '', headers: {} }),
}

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const STAMP = Date.now()
const SOURCE_ID = `zz-probe-src-${STAMP}` // 唯一前缀，不可能撞上真实数据
const HL_ID = `zz-probe-hl-${STAMP}`
const FOLDER = '/Acorny'
const TITLE = 'CrossNotebook Probe Doc'

async function createNotebook(name: string): Promise<string> {
  const nb = await post<{ notebook: { id: string } }>('/api/notebook/createNotebook', { name })
  ownedNotebooks.add(nb.notebook.id)
  return nb.notebook.id
}

const nbA = await createNotebook(`zz-acorny-probe-A-${STAMP}`)
const nbB = await createNotebook(`zz-acorny-probe-B-${STAMP}`)
console.log(`临时笔记本 A=${nbA} B=${nbB}\n`)

try {
  // 在 A 里造一篇「已同步」文档：锚定属性 + 一条高亮
  const docId = await client.createDocWithMd(nbA, `${FOLDER}/${TITLE}`, '')
  await client.setBlockAttrs(docId, { 'custom-acorny-source-id': SOURCE_ID })
  await client.appendBlock(docId, `* probe quote\n{: custom-acorny-id="${HL_ID}"}`)
  await sleep(2500) // 等 attributes 表索引 settle（实测 1–2s）

  const beforeKramdown = await client.getBlockKramdown(docId)
  check('前置：文档在笔记本 A、含锚定与高亮',
    (await client.getDocNotebookId(docId)) === nbA && beforeKramdown.includes(HL_ID))

  // 位置对账：目标是笔记本 B 的同名文件夹 /Acorny —— hpath 完全一样，只有笔记本不同。
  const strayAll = await findDocsOutsideFolder(client, { notebookId: nbB, targetFolder: FOLDER })
  check('findDocsOutsideFolder 认出「同路径但在别的笔记本」', strayAll.includes(docId))

  // ★ 关键：喂给迁移的只有 owned 子集，绝不把全库扫描结果直接传下去
  const stray = strayAll.filter((id) => ownedDocs.has(id))
  check('迁移输入已收敛到自建文档', stray.length === 1, `${stray.length} 篇（全库扫描命中 ${strayAll.length} 篇）`)

  const res = await migrateDocsToFolder(client, { notebookId: nbB, targetFolder: FOLDER, docIds: stray })
  check('跨笔记本迁移执行', res.moved === 1, JSON.stringify(res))

  await sleep(2000)
  const afterNb = await client.getDocNotebookId(docId)
  const afterPath = await client.getHPathByID(docId)
  const afterKramdown = await client.getBlockKramdown(docId)
  check('文档 id 不变且已落在笔记本 B', afterNb === nbB, `box=${afterNb}`)
  check('hpath 仍是 /Acorny/<title>', afterPath === `${FOLDER}/${TITLE}`, afterPath)
  check('锚定属性保留', afterKramdown.includes(SOURCE_ID))
  check('高亮内容保留', afterKramdown.includes(HL_ID))

  // 迁移后再对账：应认为已在位
  const strayAfter = (await findDocsOutsideFolder(client, { notebookId: nbB, targetFolder: FOLDER }))
    .filter((id) => ownedDocs.has(id))
  check('迁移后位置对账认为已在位', strayAfter.length === 0, JSON.stringify(strayAfter))
} finally {
  for (const id of ownedNotebooks) {
    assertOwnedNotebook(id)
    await post('/api/notebook/removeNotebook', { notebook: id }).catch((e) => console.error('清理失败', id, e))
  }
  console.log(`\n清理临时笔记本: ${[...ownedNotebooks].join(', ')}`)
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
