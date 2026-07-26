// 用法: npx tsx scripts/kernel-e2e-probe.mts <思源 API token>   （需本机思源正在运行）
// 依赖真实内核，不进 CI。改动同步/去重逻辑或怀疑内核契约变了时手动跑一遍。
// 会在第一个笔记本下建 /zz-acorny-e2e 草稿文档并在结束时删除；token 只走 Authorization 头，不打印。
// 端到端：用**真实 siyuanGateway 代码**打真实思源内核，验证「删除文档后再同步」。
// 网关只依赖 siyuanClientCore(纯逻辑) / docPath / renderer，都不 import 'siyuan'，故可直接跑。
import { createSiyuanGateway } from '../src/siyuanGateway'
import { migrateDocsToFolder } from '../src/folderMigration'
import type { SiyuanClient } from '../src/siyuanClientCore'
import { extractAppendedBlockId } from '../src/siyuanClientCore'
import type { ExportFeedHighlight, ExportFeedSource } from '../src/types'

const token = process.argv[2]
const BASE = 'http://127.0.0.1:6806'

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

/**
 * 硬隔离：探针跑在**真实笔记本**上，任何写操作只允许作用于探针自己建的文档。
 * 曾因把 loadSyncedIndex 扫出的全库 docMap 直接喂给迁移，导致 447 篇真实文档被搬走并删除。
 * 现在所有破坏性调用都必须先过 assertOwned()。
 */
const owned = new Set<string>()
const assertOwned = (ids: string[]) => {
  const foreign = ids.filter((id) => !owned.has(id))
  if (foreign.length > 0) {
    throw new Error(`探针拒绝操作非自建文档（${foreign.length} 篇）：${foreign.slice(0, 3).join(', ')}`)
  }
}

const client: SiyuanClient = {
  async lsNotebooks() { return (await post<{ notebooks: { id: string; name: string }[] }>('/api/notebook/lsNotebooks', {})).notebooks },
  async createDocWithMd(notebook, path, markdown) {
    const id = await post<string>('/api/filetree/createDocWithMd', { notebook, path, markdown })
    owned.add(id)
    return id
  },
  async appendBlock(parentID, data) { return extractAppendedBlockId(await post<unknown>('/api/block/appendBlock', { parentID, dataType: 'markdown', data })) },
  async setBlockAttrs(id, attrs) { await post('/api/attr/setBlockAttrs', { id, attrs }) },
  async getIDsByHPath(notebook, path) { return (await post<string[] | null>('/api/filetree/getIDsByHPath', { notebook, path })) ?? [] },
  async getHPathByID(id) { return (await post<string | null>('/api/filetree/getHPathByID', { id })) ?? '' },
  async moveDocsByID(fromIDs, toID) {
    assertOwned([...fromIDs, toID])
    await post('/api/filetree/moveDocsByID', { fromIDs, toID })
  },
  async getBlockKramdown(id) { return (await post<{ kramdown?: string }>('/api/block/getBlockKramdown', { id })).kramdown ?? '' },
  async querySql<T>(stmt: string) { return post<T[]>('/api/query/sql', { stmt }) },
  forwardProxy: async () => ({ status: 200, body: '', headers: {} }),
}

const nb = (await client.lsNotebooks())[0]
const FOLDER = '/zz-acorny-e2e'
const source: ExportFeedSource = { id: 'e2e-src-1', title: 'E2E Doc', author: null, canonicalUrl: '', type: 'article' }
const hl = (id: string): ExportFeedHighlight => ({ id, quote: `quote ${id}`, quoteMarkdown: null, note: null, tags: [], updatedAt: '', source })
const HLS = [hl('e2e-h1'), hl('e2e-h2')]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const docMap: Record<string, string> = {}
let folder = FOLDER
const known: string[] = []
const mk = () => createSiyuanGateway(client, { notebookId: nb.id, docFolderPath: folder, knownFolders: known, docMap })
const countDocs = async () => {
  // 用零延迟的 hpath 通道数"该标题下现存几篇文档"，不查滞后 1-2s 的 attributes 表。
  const ids = await client.getIDsByHPath(nb.id, `${folder}/${source.title}`)
  let alive = 0
  for (const id of ids) if ((await client.getBlockKramdown(id)) !== '') alive++
  return alive
}

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// ── 1. 首次同步
let g = mk()
let r = await g.writeSource(source, HLS, await g.loadSyncedIndex())
const doc1 = r.docId
check('首次同步建文档并写入 2 条', r.added === 2, `added=${r.added}`)
await sleep(0)

// ── 2. 立即再同步（幂等）
g = mk()
r = await g.writeSource(source, HLS, await g.loadSyncedIndex())
check('重复同步不新增', r.added === 0 && r.docId === doc1, `added=${r.added} sameDoc=${r.docId === doc1}`)
check('仍然只有 1 篇文档', (await countDocs()) === 1, `count=${await countDocs()}`)

// ── 3. 模拟"重启"：docMap 清空 + SQL 种子
for (const k of Object.keys(docMap)) delete docMap[k]
g = mk()
r = await g.writeSource(source, HLS, await g.loadSyncedIndex())
check('冷启动(docMap 清空)后复用同一篇', r.added === 0 && r.docId === doc1, `added=${r.added} sameDoc=${r.docId === doc1}`)

// ── 4. 模拟"docMap 和种子全丢"：只靠点查
for (const k of Object.keys(docMap)) delete docMap[k]
g = mk()
r = await g.writeSource(source, HLS, { sourceDocMap: {} }) // 不调 loadSyncedIndex，逼它走点查
check('仅靠点查也复用同一篇（不重复建档）', r.added === 0 && r.docId === doc1, `added=${r.added} sameDoc=${r.docId === doc1}`)
check('依然只有 1 篇文档', (await countDocs()) === 1, `count=${await countDocs()}`)

// ── 5. ★ 用户删掉文档后再同步（本次报错的场景）
await post('/api/filetree/removeDocByID', { id: doc1 })
g = mk()
try {
  r = await g.writeSource(source, HLS, await g.loadSyncedIndex())
  check('删除后同步：重建文档且补齐 2 条', r.added === 2 && r.docId !== doc1, `added=${r.added} newDoc=${r.docId !== doc1}`)
} catch (e) {
  check('删除后同步不报错', false, String(e))
}
await sleep(0)


// ── 6. ★ 换文件夹：迁移已有文档 → 删一篇 → 再同步（用户报的场景）
const FOLDER2 = FOLDER + '2'
const before = (await client.getIDsByHPath(nb.id, `${FOLDER}/${source.title}`))[0]
// 只喂探针自己的那篇；用 Object.values(docMap) 会把全库真实文档一起搬走。
const mig = await migrateDocsToFolder(client, { notebookId: nb.id, targetFolder: FOLDER2, docIds: [before] })
folder = FOLDER2
check('换文件夹后迁移了 1 篇', mig.moved === 1, JSON.stringify(mig))
check('文档 id 不变, 已在新文件夹', (await client.getHPathByID(before)) === `${FOLDER2}/${source.title}`, await client.getHPathByID(before))
g = mk()
r = await g.writeSource(source, HLS, await g.loadSyncedIndex())
check('迁移后同步不新增、不重建', r.added === 0 && r.docId === before, `added=${r.added} sameDoc=${r.docId === before}`)
check('旧文件夹已无该文档', (await client.getIDsByHPath(nb.id, `${FOLDER}/${source.title}`)).length === 0)

await post('/api/filetree/removeDocByID', { id: before })
g = mk()
r = await g.writeSource(source, HLS, await g.loadSyncedIndex())
check('删除后重建落在新文件夹', (await client.getHPathByID(r.docId)) === `${FOLDER2}/${source.title}`, await client.getHPathByID(r.docId))
check('新旧文件夹合计只有 1 篇活文档',
  (await countDocs()) === 1 && (await client.getIDsByHPath(nb.id, `${FOLDER}/${source.title}`)).length === 0)

// cleanup
// 只删探针自建的文档；按文件夹删会连同被误移进来的真实文档一起删掉。
const ids = [...owned]
for (const id of ids) {
  assertOwned([id])
  await post('/api/filetree/removeDocByID', { id }).catch(() => {})
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}  (cleanup: ${JSON.stringify(ids)})`)
process.exit(failures === 0 ? 0 : 1)
