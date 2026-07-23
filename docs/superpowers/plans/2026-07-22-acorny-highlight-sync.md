# Acorny → 思源笔记 高亮同步插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `siyuan-note-sync` 前端插件里，从 Acorny 单向增量同步高亮进思源笔记：一个 source 对应一篇文档，高亮作为带块属性的列表块，幂等可重复运行且保护用户编辑。

**Architecture:** 「纯逻辑 + 网关接口」分层。纯逻辑（types/connection/apiClient/docPath/renderer/scheduler/syncEngine）无思源依赖、可 vitest 单测；思源耦合集中在少数文件（siyuanClient/httpProxy/siyuanGateway/index）。去重与编辑保护用**块自定义属性 + SQL 查询**（思源即真相），高亮块与其 `custom-acorny-id` 通过 `appendBlock` 内联 IAL **一次原子落地**，文档 path 带 `-<sourceId>`（完整 UUID）后缀避免同名串数据。**核心 kernel 契约（IAL 落块、appendBlock 返回、forwardProxy 形状）由前置 Task 0 真机 spike 先行验证并冻结 fixture。**

**Tech Stack:** TypeScript + 思源 `siyuan` SDK（`Plugin`/`Setting`/`fetchSyncPost`）、webpack + esbuild-loader 构建、vitest 单测、pnpm。设计规范见 `docs/superpowers/specs/2026-07-22-acorny-highlight-sync-design.md`。

## 执行状态（2026-07-23）

分支 `feat/acorny-highlight-sync`。**Task 0–13 代码全部实现完毕**，门禁全绿：`lint:check` 0、`typecheck` src 干净、**47 tests passed**、`build` 成功。

- **Task 0 kernel 真机 spike ✅**（kernel 3.7.2，结论见 `docs/superpowers/notes/2026-07-23-kernel-contract-fixtures.md`）：
  - 内联 IAL **生效**，`custom-acorny-id` 落在外层 `NodeList` 块，`appendBlock` 返回该块 id → **去重模型成立，renderer/gateway 未改**。
  - `attributes` 表**异步索引 ~1.5s**（append 后立即查为空）；loadSyncedIndex 在同步开始时查 + 单次 drain 用内存 Set，无害。
  - **修复真机 bug**：forwardProxy `headers` 为数组值 `Record<string,string[]>`，`httpProxy.normalizeHeaders` 取首值扁平化。
  - fixture 已冻结并接入 Task 9/10 回归测试（Step 4b ✅）。
- **执行期偏差**（详见文末 Self-Review §4 / 各任务内注）：加 `scripts/typecheck.mjs` 门禁绕过 siyuan SDK 自带类型 bug；纯逻辑 `siyuanClientCore.ts` 与 `import 'siyuan'` 分离以便 vitest；项目风格统一为 single-quote/no-semi；`docPath` 后缀用完整 sanitized sourceId。
- **唯一待办**：Task 12 Step 5 桌面端端到端真机 QA（需 Acorny export token + 加载插件）。

## Global Constraints

- 包管理器：`pnpm`（禁 npm/yarn）；`node >=24.0.0`；`siyuan` SDK `1.2.2`。
- 唯一新增依赖：`vitest`（devDependency，已批准）。不得引入其它新依赖。
- `plugin.json` `name` 必须为 `"siyuan-note-sync"`（与仓库名一致，bazaar 要求）；`disabledInPublish: true`；`backends: ["all"]`；`frontends` 保留 `desktop/mobile/browser-desktop/browser-mobile/desktop-window/all`。
- 代码风格：单引号、尾逗号、严格 TS 类型、中文 JSDoc。
- 相对导入用**无扩展名**（本仓库 webpack+esbuild / vitest 工具链，不同于 Acorny server 的 `.js` 规则）。
- `tsconfig.json` 必须含 `"lib": ["ES2019","DOM"]`（Task 1 加）；否则 `Object.entries` 等触发 TS2550。
- i18n 文件名用**连字符** `en.json` / `zh-CN.json`（沿用脚手架，勿建 `zh_CN.json`）。
- 去重属性写入必须**原子**：高亮块与 `custom-acorny-id` 一次 `appendBlock`（内联 IAL），不得拆成 append + setBlockAttrs（§5 崩溃窗口）；仅当 Task 0 spike 证明 IAL 不可行才降级并记录代价。
- 文档 path 必须带完整 sourceId 后缀：`/<docFolderPath>/<sanitizedTitle>-<sanitized(sourceId)>`（§4/§5 同名串数据；用完整 UUID，**非** `slice(0,8)` 或哈希）。
- 设置默认：`serverUrl=https://api.acorny.io`、`docFolderPath=/Acorny`、`syncOnStartup=true`、`pollIntervalMinutes=60`。
- 敏感：`exportToken` 用密码框展示，不写入日志。
- 每个任务结束 commit；提交信息中文正文、术语保留英文。

---

## File Structure

```
src/
  types.ts          DTO + Settings + PluginState + SyncedIndex（纯类型）
  connection.ts     connectionId(serverUrl, token) cyrb53（原样复用）
  apiClient.ts      fetchFeedPage + Auth/RateLimit/FeedRequestError（原样复用）
  docPath.ts        buildDocHPath：sanitize 标题 + source-id 短后缀（新增）
  renderer.ts       renderHighlightBlock：思源列表项 + 内联 IAL + note + #标签#（重写）
  scheduler.ts      nextAutoDelayMs（原样复用）
  syncEngine.ts     游标增量 drain（改造：loadSyncedIndex 依赖 / writeSource 新签名）
  siyuanClient.ts   kernel API 薄封装 over fetchSyncPost + 纯响应提取器（思源耦合）
  httpProxy.ts      createForwardProxyHttp：HttpRequest over forwardProxy（思源耦合）
  siyuanGateway.ts  loadSyncedIndex / ensureSourceDoc / writeSource（思源耦合）
  index.ts          Plugin 主体：设置UI / 顶栏+命令 / 调度 / 接线（思源耦合）
  i18n/{en,zh-CN}.json  本插件文案（连字符，改现有文件）
  *.test.ts         co-located vitest（纯逻辑层）
vitest.config.ts    node 环境
```

删除：`src/kernel.ts`、`webpack.kernel.config.js`、`docs/superpowers/{plans,specs}/2026-05-09-kernel-plugin-demo*`。

---

## Task 0: kernel 契约真机 spike（前置，冻结 fixture）

> **为什么先做**：整个去重模型押注「`appendBlock` 内联 IAL 会把 `custom-acorny-id` 落到可被 SQL 查到的高亮块」。这个前提必须在写 renderer/gateway **之前**用真实思源 kernel 验证——押错就得返工（Codex review P1 #7）。

**Files:**
- Create: `docs/superpowers/notes/2026-07-22-kernel-contract-fixtures.md`（记录真实响应）
- Create: `src/__fixtures__/kernel/*.json`（冻结的真实响应样本，供后续任务做回归断言）

**Interfaces:**
- Consumes: 本机运行的思源 kernel HTTP API（`http://127.0.0.1:6806`，需思源「设置 → 关于 → API token」）
- Produces: 已确认的 kernel 契约事实 + fixture 文件，供 Task 6/9/10/11 对齐

> **环境说明**：这是**本机开发环境**的思源，非生产。请在一个**临时草稿笔记本**里操作，避免污染真实笔记。所有请求带 `Authorization: Token <api-token>`。

- [ ] **Step 1: 在草稿笔记本建一篇文档并追加带 IAL 的列表块**

用 HTTP 客户端（curl / REST 工具）对本机 kernel 依次调用（把 `<TOKEN>`/`<NB>` 换成真实值）：

```bash
# 1) createDocWithMd —— 记录返回的 data 是否直接是 docId 字符串
curl -s http://127.0.0.1:6806/api/filetree/createDocWithMd \
  -H "Authorization: Token <TOKEN>" -H "Content-Type: application/json" \
  -d '{"notebook":"<NB>","path":"/spike/probe-doc","markdown":""}'

# 2) appendBlock 内联 IAL —— 记录返回的 data[0].doOperations[0].id
curl -s http://127.0.0.1:6806/api/block/appendBlock \
  -H "Authorization: Token <TOKEN>" -H "Content-Type: application/json" \
  -d '{"parentID":"<DOC_ID>","dataType":"markdown","data":"* hello world\n{: custom-acorny-id=\"probe-1\"}"}'

# 3) 带嵌套 note 的形态
curl -s http://127.0.0.1:6806/api/block/appendBlock \
  -H "Authorization: Token <TOKEN>" -H "Content-Type: application/json" \
  -d '{"parentID":"<DOC_ID>","dataType":"markdown","data":"* quoted text #tag#\n  * note: my note\n{: custom-acorny-id=\"probe-2\"}"}'
```

- [ ] **Step 2: 用 SQL 确认属性落到了可查的块**

```bash
curl -s http://127.0.0.1:6806/api/query/sql \
  -H "Authorization: Token <TOKEN>" -H "Content-Type: application/json" \
  -d '{"stmt":"SELECT block_id, value FROM attributes WHERE name = '"'"'custom-acorny-id'"'"'"}'
```

记录：`custom-acorny-id` 是否查得到；对应 `block_id` 指向的块 `type` 是 `l`(list) 还是 `i`(list item)（再 `SELECT type FROM blocks WHERE id='<block_id>'` 确认）；嵌套 note 形态下 IAL 是否仍生效。

- [ ] **Step 2b: 记录被验证的 kernel/环境版本**

```bash
curl -s http://127.0.0.1:6806/api/system/version -H "Authorization: Token <TOKEN>"
```

记录：思源/kernel 版本号、操作系统。**若该版本高于 `plugin.json` 的 `minAppVersion: 3.7.0`**，spike 只证明了「≥ 实测版本」兼容，不等于 3.7.0 兼容——要么把 `minAppVersion` 提到实测版本，要么在 notes 里显式标注「3.7.0–实测版本区间未验证」。

- [ ] **Step 3: 探 forwardProxy 真实响应形状**

```bash
curl -s http://127.0.0.1:6806/api/network/forwardProxy \
  -H "Authorization: Token <TOKEN>" -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/status/429","method":"GET","headers":[{"X-Probe":"1"}],"timeout":15000,"contentType":"application/json"}'
```

记录 `data.status` / `data.body`（是否 base64 / 是否字符串）/ `data.headers`（对象还是数组、键大小写）。

- [ ] **Step 4: 冻结 fixture + 写结论**

把上述真实响应原样存进 `src/__fixtures__/kernel/{appendBlock,createDocWithMd,forwardProxy,querySql}.json`，并在 `docs/superpowers/notes/2026-07-22-kernel-contract-fixtures.md` 记录：
- IAL 落块级别（list vs list-item）→ 决定 Task 6 renderer 的确切 markdown 与 Task 11 `loadSyncedIndex` 的 SQL 是否需过滤块类型。
- `appendBlock` 新块 id 提取路径是否与 `data[0].doOperations[0].id` 一致（若不一致，改 Task 10 `extractAppendedBlockId` + 其测试）。
- `forwardProxy` body/headers 形状（对齐 Task 9 `createForwardProxyHttp`）。
- **若 IAL 无法落到 list-item / 无法被 SQL 查到**：触发降级——renderer 不内联 IAL，gateway 改为 `appendBlock` 后对返回块 id 调 `setBlockAttrs`，并在 spec §5/§7 记录「存在 append↔setAttr 之间的重复窗口」这一已知降级代价。此决策必须在继续 Task 6 前敲定。
- **被验证的思源/kernel 版本 + 操作系统**（Step 2b），及 `minAppVersion` 结论。

- [ ] **Step 4b: 清理临时文档/笔记本**

删除 spike 用的草稿文档/笔记本，避免污染真实库：

```bash
# 删掉 spike 文档（用 Step 1 拿到的 DOC_ID）
curl -s http://127.0.0.1:6806/api/filetree/removeDocByID \
  -H "Authorization: Token <TOKEN>" -H "Content-Type: application/json" \
  -d '{"id":"<DOC_ID>"}'
```

（若整建了草稿笔记本，改用 `/api/notebook/removeNotebook`。）

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/ src/__fixtures__/
git commit -m "spike(kernel): 冻结 appendBlock/IAL/forwardProxy 真实契约 fixture"
```

---

## Task 1: 脚手架清理 + 身份改写 + vitest 引入

**Files:**
- Modify: `package.json`（去 kernel script、加 vitest + test script、改 name/author/url）
- Modify: `plugin.json`（改插件身份）
- Modify: `webpack.config.js:32`（删 `{from: "dist/kernel.js", to: "./dist/"}`）
- Modify: `.gitignore`（删 `kernel.js` 行，若有）
- Modify: `tsconfig.json`（补 `lib`，否则 `Object.entries` 等 ES2017 API 触发 TS2550）
- Create: `vitest.config.ts`
- Delete: `webpack.kernel.config.js`、`src/kernel.ts`
- Delete: `docs/superpowers/plans/2026-05-09-kernel-plugin-demo.md`、`docs/superpowers/specs/2026-05-09-kernel-plugin-demo-design.md`
- Test: `src/smoke.test.ts`（临时冒烟，验证 vitest 通）

**Interfaces:**
- Consumes: 无
- Produces: 可运行的 `pnpm test`、干净的 `pnpm build`。

- [ ] **Step 1: 删除 kernel 相关文件与模板文档**

```bash
git rm webpack.kernel.config.js src/kernel.ts
git rm docs/superpowers/plans/2026-05-09-kernel-plugin-demo.md
git rm docs/superpowers/specs/2026-05-09-kernel-plugin-demo-design.md
```

- [ ] **Step 2: 改写 `package.json`**

把 `name`/`scripts`/`devDependencies` 改为（保留其余字段）：

```json
{
  "name": "siyuan-note-sync",
  "version": "0.1.0",
  "description": "Sync Acorny highlights into SiYuan notes.",
  "main": ".src/index.js",
  "scripts": {
    "format": "dprint fmt",
    "format:check": "dprint check",
    "lint": "eslint . --fix --cache",
    "lint:check": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "webpack --config webpack.config.js --mode development",
    "build": "webpack --config webpack.config.js --mode production"
  },
  "author": "acornyio",
  "license": "MIT",
  "packageManager": "pnpm@11.4.0",
  "engines": { "node": ">=24.0.0" }
}
```

在 `devDependencies` 里**新增** `"vitest": "^3.0.0"`（保留原有全部条目，仅删无用的 `npm-run-all` 若不再被引用——`dev`/`build` 已不用 `run-p`/`run-s`，可删 `npm-run-all`）。

- [ ] **Step 3: 改写 `plugin.json` 身份**

```json
{
  "name": "siyuan-note-sync",
  "author": "acornyio",
  "url": "https://github.com/acornyio/siyuan-note-sync",
  "version": "0.1.0",
  "minAppVersion": "3.7.0",
  "backends": ["all"],
  "frontends": ["desktop", "mobile", "browser-desktop", "browser-mobile", "desktop-window", "all"],
  "disabledInPublish": true,
  "displayName": { "default": "Acorny Sync", "zh-CN": "Acorny 高亮同步" },
  "description": {
    "default": "Sync your Acorny highlights into SiYuan notes.",
    "zh-CN": "将 Acorny 高亮单向同步进思源笔记。"
  },
  "readme": { "default": "README.md", "zh-CN": "README.zh-CN.md" },
  "keywords": ["acorny", "highlight", "sync", "readwise"]
}
```

> 注：删除了 `kernels` 字段（不再是 kernel 插件）。

- [ ] **Step 4: 从 `webpack.config.js` 删除 kernel 拷贝**

删掉生产 `CopyPlugin.patterns` 里的这一行：

```js
{from: "dist/kernel.js", to: "./dist/"},
```

- [ ] **Step 4b: 给 `tsconfig.json` 补 `lib`**

现有 `tsconfig.json` `target:es6` 无 `lib`，默认 lib=ES2015，本计划用到的 `Object.entries`(ES2017) 会让 `tsc --noEmit` 报 TS2550。改为：

```json
{
  "compilerOptions": {
    "noImplicitAny": true,
    "module": "commonjs",
    "target": "es6",
    "lib": ["ES2019", "DOM"],
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "strictNullChecks": false
  },
  "include": ["src/**/*.ts", "src/**/*.json"]
}
```

> 思源运行在 Electron/Chromium，ES2019 API 运行时可用；仅放宽类型检查库，不改 `target`（webpack esbuild 仍产出 es6）。`resolveJsonModule`+`esModuleInterop` 让 Task 9/10 的回归测试能 `import` Task 0 冻结的真实 fixture JSON。

- [ ] **Step 5: 新增 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 6: 写临时冒烟测试 `src/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest'

describe('vitest wiring', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 7: 安装依赖并运行测试与构建**

```bash
pnpm install
pnpm test
pnpm build
```

Expected: `pnpm test` 1 passed；`pnpm build` 成功产出 `dist/`（无 kernel.js 报错）。

- [ ] **Step 8: 删除临时冒烟测试并 commit**

```bash
git rm src/smoke.test.ts
git add -A
git commit -m "chore(scaffold): 清理 kernel 脚手架并改写为 siyuan-note-sync 身份

- What: 删 kernel 构建/示例文档，plugin.json/package.json 改身份，引入 vitest
- Why: 从 plugin-sample 模板切换到 Acorny 同步插件基线
- Impact/Test: pnpm test / pnpm build 通过"
```

---

## Task 2: 纯类型 `types.ts`

**Files:**
- Create: `src/types.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ExportFeedSource { id: string; title: string; author: string | null; canonicalUrl: string; type: string }`
  - `ExportFeedHighlight { id; quote; quoteMarkdown: string | null; note: string | null; tags: string[]; updatedAt: string; source: ExportFeedSource }`
  - `ExportFeedResponse { highlights: ExportFeedHighlight[]; nextCursor: string; done: boolean }`
  - `AcornySettings { serverUrl; exportToken; notebookId; docFolderPath; syncOnStartup: boolean; pollIntervalMinutes: number }`
  - `PluginState { lastCursor: string | null; connectionId: string | null }`
  - `SyncStatus = 'idle' | 'syncing' | 'backoff' | 'auth_failed'`
  - `SyncedIndex { sourceDocMap: Record<string, string>; syncedHlIds: Set<string> }`

- [ ] **Step 1: 写 `src/types.ts`**

```ts
/** 镜像 Acorny server /exports/highlights/feed 响应。 */
export interface ExportFeedSource {
  id: string
  title: string
  author: string | null
  canonicalUrl: string
  type: string
}

export interface ExportFeedHighlight {
  id: string
  quote: string
  quoteMarkdown: string | null
  note: string | null
  tags: string[]
  updatedAt: string
  source: ExportFeedSource
}

export interface ExportFeedResponse {
  highlights: ExportFeedHighlight[]
  nextCursor: string
  done: boolean
}

/** 用户设置，经思源 saveData 持久化。 */
export interface AcornySettings {
  serverUrl: string
  exportToken: string
  notebookId: string
  docFolderPath: string
  syncOnStartup: boolean
  pollIntervalMinutes: number
}

/**
 * 插件本地状态。仅存游标与连接身份——「已同步什么」以思源块属性为准（思源即真相）。
 * connectionId 变化则弃用 cursor，防跨账号游标重放漏数据。
 */
export interface PluginState {
  lastCursor: string | null
  connectionId: string | null
}

export type SyncStatus = 'idle' | 'syncing' | 'backoff' | 'auth_failed'

/** 一次同步开始时从思源 SQL 拉出的全量已同步索引。 */
export interface SyncedIndex {
  /** sourceId -> 文档根块 id。 */
  sourceDocMap: Record<string, string>
  /** 已同步高亮 id 集合。 */
  syncedHlIds: Set<string>
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无 error。

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): 定义 feed DTO 与插件状态类型"
```

---

## Task 3: `connection.ts`（原样复用 cyrb53）

**Files:**
- Create: `src/connection.ts`
- Test: `src/connection.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `connectionId(serverUrl: string, token: string): string`

- [ ] **Step 1: 写失败测试 `src/connection.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { connectionId } from './connection'

describe('connectionId', () => {
  it('same server+token → same id', () => {
    expect(connectionId('https://api.acorny.io', 't1')).toBe(connectionId('https://api.acorny.io', 't1'))
  })

  it('trailing slash and casing of host normalized to same id', () => {
    expect(connectionId('https://API.acorny.io/', 't1')).toBe(connectionId('https://api.acorny.io', 't1'))
  })

  it('different token → different id', () => {
    expect(connectionId('https://api.acorny.io', 't1')).not.toBe(connectionId('https://api.acorny.io', 't2'))
  })

  it('non-URL input stays stable run-to-run', () => {
    expect(connectionId('not a url', 't1')).toBe(connectionId('not a url', 't1'))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/connection.test.ts`
Expected: FAIL（`Cannot find module './connection'`）。

- [ ] **Step 3: 写 `src/connection.ts`**

从 `../acorny-obsidian/src/connection.ts` 原样移植（逻辑不变，保留全部注释）：

```ts
/**
 * cyrb53 — 快速、同步、非加密的 53 位字符串哈希。够用于判断「连接是否变化」；
 * 不用于任何安全决策。
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * Acorny 连接的稳定身份：归一化 serverUrl + token 的哈希。与游标一起持久化，
 * 保证为某账号生成的游标绝不会被另一账号重放（否则可能静默漏数据）。
 * 只存哈希、不存原文，且只做相等比较。
 */
export function connectionId(serverUrl: string, token: string): string {
  const trimmed = serverUrl.trim()
  let normalizedUrl: string
  try {
    normalizedUrl = new URL(trimmed).toString().replace(/\/+$/, '')
  } catch {
    normalizedUrl = trimmed.replace(/\/+$/, '')
  }
  return cyrb53(`${normalizedUrl} ${token.trim()}`)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/connection.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/connection.ts src/connection.test.ts
git commit -m "feat(connection): 移植 connectionId cyrb53 连接身份哈希"
```

---

## Task 4: `apiClient.ts`（原样复用 feed 拉取）

**Files:**
- Create: `src/apiClient.ts`
- Test: `src/apiClient.test.ts`

**Interfaces:**
- Consumes: `types.ExportFeedResponse`
- Produces:
  - `type HttpResponse = { status: number; json: unknown; headers: Record<string, string> }`
  - `type HttpRequest = (req: { url: string; headers: Record<string, string> }) => Promise<HttpResponse>`
  - `class AuthError`、`class RateLimitError { retryAfterSeconds }`、`class FeedRequestError { status }`
  - `fetchFeedPage(http: HttpRequest, opts: { serverUrl; token; cursor: string | null; limit? }): Promise<ExportFeedResponse>`

- [ ] **Step 1: 写失败测试 `src/apiClient.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { AuthError, fetchFeedPage, FeedRequestError, RateLimitError, type HttpResponse } from './apiClient'

const ok = (json: unknown): HttpResponse => ({ status: 200, json, headers: {} })

describe('fetchFeedPage', () => {
  it('builds feed URL with limit and encoded cursor', async () => {
    const http = vi.fn(async () => ok({ highlights: [], nextCursor: '', done: true }))
    await fetchFeedPage(http, { serverUrl: 'https://api.acorny.io/', token: 'tk', cursor: 'a b/c' })
    expect(http).toHaveBeenCalledWith({
      url: 'https://api.acorny.io/api/v1/exports/highlights/feed?limit=100&cursor=a%20b%2Fc',
      headers: { Authorization: 'Token tk' },
    })
  })

  it('401 → AuthError', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 401, json: null, headers: {} }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null })).rejects.toBeInstanceOf(AuthError)
  })

  it('429 reads Retry-After header', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 429, json: null, headers: { 'retry-after': '42' } }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null }))
      .rejects.toMatchObject({ retryAfterSeconds: 42 })
  })

  it('429 falls back to body.retryAfter then 60', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 429, json: { retryAfter: 7 }, headers: {} }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null }))
      .rejects.toMatchObject({ retryAfterSeconds: 7 })
  })

  it('other non-2xx → FeedRequestError', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 500, json: null, headers: {} }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null })).rejects.toBeInstanceOf(FeedRequestError)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/apiClient.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `src/apiClient.ts`**

从 `../acorny-obsidian/src/apiClient.ts` 移植，仅把 `import ... from './types.js'` 改成无扩展名 `'./types'`：

```ts
import type { ExportFeedResponse } from './types'

export type HttpResponse = { status: number; json: unknown; headers: Record<string, string> }
export type HttpRequest = (req: { url: string; headers: Record<string, string> }) => Promise<HttpResponse>

export class AuthError extends Error {
  constructor() {
    super('Export token rejected (401)')
    this.name = 'AuthError'
  }
}
export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Rate limited (429), retry in ${retryAfterSeconds}s`)
    this.name = 'RateLimitError'
  }
}
export class FeedRequestError extends Error {
  constructor(readonly status: number) {
    super(`Feed request failed (${status})`)
    this.name = 'FeedRequestError'
  }
}

export interface FetchFeedOptions {
  serverUrl: string
  token: string
  cursor: string | null
  limit?: number
}

export async function fetchFeedPage(http: HttpRequest, opts: FetchFeedOptions): Promise<ExportFeedResponse> {
  const base = opts.serverUrl.replace(/\/+$/, '')
  const limit = opts.limit ?? 100
  let url = `${base}/api/v1/exports/highlights/feed?limit=${limit}`
  if (opts.cursor) url += `&cursor=${encodeURIComponent(opts.cursor)}`

  const res = await http({ url, headers: { Authorization: `Token ${opts.token}` } })

  if (res.status === 401) throw new AuthError()
  if (res.status === 429) {
    const header = res.headers['retry-after'] ?? res.headers['Retry-After']
    const body = res.json as { retryAfter?: number } | null
    const retry = Number(header ?? body?.retryAfter ?? 60)
    throw new RateLimitError(Number.isFinite(retry) ? retry : 60)
  }
  if (res.status < 200 || res.status >= 300) throw new FeedRequestError(res.status)

  return res.json as ExportFeedResponse
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/apiClient.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/apiClient.ts src/apiClient.test.ts
git commit -m "feat(apiClient): 移植 feed 分页拉取与 401/429 错误映射"
```

---

## Task 5: `docPath.ts`（sanitize + source-id 去重后缀）

**Files:**
- Create: `src/docPath.ts`
- Test: `src/docPath.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `buildDocHPath(folderPath: string, title: string | null, sourceId: string): string`
  - 返回思源 hpath，形如 `/Acorny/<sanitized>-<sanitized(sourceId)>`；后缀是**完整** sourceId（UUID，本就路径安全，防御性再清一次非法字符），不同 sourceId **一定**得到不同 path（§5 关键；用完整 id 而非哈希，真正唯一、无碰撞）。

- [ ] **Step 1: 写失败测试 `src/docPath.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildDocHPath } from './docPath'

describe('buildDocHPath', () => {
  it('joins folder + sanitized title + full sourceId suffix', () => {
    expect(buildDocHPath('/Acorny', 'Deep Work', 'uuid-1')).toBe('/Acorny/Deep Work-uuid-1')
  })

  it('two distinct sources sharing the SAME title get DISTINCT paths (full id, no truncation collision)', () => {
    // 关键回归：即便前若干位相同，完整 id 后缀也一定区分——slice(0,8) 方案会在此失败（Codex #1）。
    const a = buildDocHPath('/Acorny', 'Atomic Habits', '12345678-aaaa-1111')
    const b = buildDocHPath('/Acorny', 'Atomic Habits', '12345678-bbbb-2222')
    expect(a).toBe('/Acorny/Atomic Habits-12345678-aaaa-1111')
    expect(b).toBe('/Acorny/Atomic Habits-12345678-bbbb-2222')
    expect(a).not.toBe(b)
  })

  it('same sourceId is deterministic run-to-run', () => {
    expect(buildDocHPath('/Acorny', 'X', 'id-1')).toBe(buildDocHPath('/Acorny', 'X', 'id-1'))
  })

  it('replaces path-illegal chars and collapses whitespace in the title part', () => {
    expect(buildDocHPath('/Acorny', 'a/b:c*?  d', 'id-1')).toBe('/Acorny/a-b-c- d-id-1')
  })

  it('sanitizes path-illegal chars in the sourceId suffix too (defensive)', () => {
    expect(buildDocHPath('/Acorny', 'X', 'a/b:c')).toBe('/Acorny/X-a-b-c')
  })

  it('empty/whitespace title falls back to Untitled', () => {
    expect(buildDocHPath('/Acorny', '   ', 'id-1')).toBe('/Acorny/Untitled-id-1')
  })

  it('normalizes folder path (leading slash, no trailing slash)', () => {
    expect(buildDocHPath('Acorny/', 'X', 'id-1')).toBe('/Acorny/X-id-1')
  })

  it('strips control chars / newlines from title', () => {
    expect(buildDocHPath('/Acorny', 'line1\nline2', 'id-1')).toBe('/Acorny/line1 line2-id-1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/docPath.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `src/docPath.ts`**

移植 `../acorny-obsidian/src/fileNaming.ts` 的 sanitize 逻辑，改造为 hpath 段并**始终**追加 `-<sanitized(sourceId)>`（完整 id）后缀：

```ts
// 路径非法字符（Windows/macOS/Linux）。空格不非法，尾部空格单独裁掉。
const ILLEGAL = /[/\\:*?"<>|]/g

const MAX_LEN = 120
// 多数文件系统按字节限长（255 bytes）。120 个中日文 ≈ 360 字节会溢出，
// 用保守字节预算，给 "-<sourceId>" 后缀留余量。
const MAX_BYTES = 180
const encoder = new TextEncoder()

/** 把控制字符（C0 0x00–0x1F 与 DEL 0x7F，含换行/回车/制表）替换为空格。 */
function stripControlChars(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    out += code <= 0x1f || code === 0x7f ? ' ' : ch
  }
  return out
}

/** 不超字节预算、不切断码点地截断。 */
function truncate(input: string, maxChars: number, maxBytes: number): string {
  if (input.length <= maxChars && encoder.encode(input).length <= maxBytes) return input
  let out = ''
  let chars = 0
  let bytes = 0
  for (const ch of input) {
    const chBytes = encoder.encode(ch).length
    if (chars + 1 > maxChars || bytes + chBytes > maxBytes) break
    out += ch
    chars += 1
    bytes += chBytes
  }
  return out
}

/** 标题 → 合法文档段名（无路径、无扩展）。 */
function sanitizeTitle(title: string | null): string {
  const cleaned = stripControlChars((title ?? '').normalize('NFC'))
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-. ]+$/g, '')
    .trim()
  if (cleaned.length === 0) return 'Untitled'
  const truncated = truncate(cleaned, MAX_LEN, MAX_BYTES)
  return truncated.length < cleaned.length ? truncated.replace(/[-. ]+$/g, '') : truncated
}

/**
 * 构造文档 hpath：`/<folder>/<sanitizedTitle>-<sanitized(sourceId)>`。
 * source-id 后缀是硬要求——`createDocWithMd` 按 hpath 幂等，两个不同 source
 * 若同名会串进同一文档且 custom-acorny-source-id 被覆盖（见 spec §5）。
 * 用**完整** sourceId（Acorny source id 是 UUID，本就路径安全）而非 `slice(0,8)`
 * 或哈希：完整 id 真正唯一、无碰撞（哈希只是概率极低）。对 id 也做一次防御性
 * 非法字符清理，防将来 id 格式变化引入路径问题（Codex review #1/#4）。
 */
export function buildDocHPath(folderPath: string, title: string | null, sourceId: string): string {
  const folder = `/${folderPath.replace(/^\/+/, '').replace(/\/+$/, '')}`
  const idSuffix = sourceId.replace(ILLEGAL, '-')
  return `${folder}/${sanitizeTitle(title)}-${idSuffix}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/docPath.test.ts`
Expected: PASS（8 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/docPath.ts src/docPath.test.ts
git commit -m "feat(docPath): sanitize 标题并强制 source-id 后缀避免同名串数据"
```

---

## Task 6: `renderer.ts`（重写为思源 Markdown + 内联 IAL）

**Files:**
- Create: `src/renderer.ts`
- Test: `src/renderer.test.ts`

**Interfaces:**
- Consumes: `types.ExportFeedHighlight`
- Produces:
  - `ialLine(id: string): string` → `{: custom-acorny-id="<escaped>"}`
  - `renderHighlightContent(h): string` → 列表项内容（quote + #标签# + 嵌套 note），**不含 id**
  - `renderHighlightBlock(h): string` → `renderHighlightContent(h)` 末尾追加一行 `ialLine(h.id)`，供 `appendBlock` 原子落地

- [ ] **Step 1: 写失败测试 `src/renderer.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { ialLine, renderHighlightBlock, renderHighlightContent } from './renderer'
import type { ExportFeedHighlight } from './types'

const base: ExportFeedHighlight = {
  id: 'hl1',
  quote: 'the quote',
  quoteMarkdown: null,
  note: null,
  tags: [],
  updatedAt: '2026-07-22T00:00:00Z',
  source: { id: 's1', title: 'T', author: null, canonicalUrl: '', type: 'article' },
}

describe('renderer', () => {
  it('renders a list item from quote', () => {
    expect(renderHighlightContent(base)).toBe('* the quote')
  })

  it('prefers quoteMarkdown and collapses internal newlines', () => {
    expect(renderHighlightContent({ ...base, quote: 'x', quoteMarkdown: 'a\n  b' })).toBe('* a b')
  })

  it('appends tags as #tag#', () => {
    expect(renderHighlightContent({ ...base, tags: ['foo', 'bar baz'] })).toBe('* the quote #foo# #bar baz#')
  })

  it('nests note as a sub-item', () => {
    expect(renderHighlightContent({ ...base, note: 'my note' })).toBe('* the quote\n  * note: my note')
  })

  it('ialLine escapes embedded quotes', () => {
    expect(ialLine('a"b')).toBe('{: custom-acorny-id="a&quot;b"}')
  })

  it('renderHighlightBlock appends the IAL line last', () => {
    expect(renderHighlightBlock(base)).toBe('* the quote\n{: custom-acorny-id="hl1"}')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `src/renderer.ts`**

```ts
import type { ExportFeedHighlight } from './types'

/** 把多行折叠为单行（列表项内容需单行）。 */
function oneLine(input: string): string {
  return input.replace(/\s*\n\s*/g, ' ').trim()
}

/** IAL 属性值转义（避免引号截断属性）。 */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;')
}

/** 单条高亮的去重属性 IAL 行。 */
export function ialLine(id: string): string {
  return `{: custom-acorny-id="${escapeAttr(id)}"}`
}

/**
 * 渲染高亮列表项内容（不含 id）：`* <quote> <#tag#...>`，有 note 时嵌套子项。
 * quoteMarkdown 优先，缺失回退 quote。
 */
export function renderHighlightContent(h: ExportFeedHighlight): string {
  const text = oneLine(h.quoteMarkdown ?? h.quote)
  const tags = h.tags.length > 0 ? ' ' + h.tags.map((t) => `#${t}#`).join(' ') : ''
  let item = `* ${text}${tags}`
  if (h.note && h.note.trim().length > 0) {
    item += `\n  * note: ${oneLine(h.note)}`
  }
  return item
}

/**
 * 渲染可直接交给 appendBlock 的块 markdown：内容 + 末行 IAL，使块与 custom-acorny-id
 * 一次原子落地（见 spec §5，规避 append/setAttr 之间的崩溃窗口）。
 */
export function renderHighlightBlock(h: ExportFeedHighlight): string {
  return `${renderHighlightContent(h)}\n${ialLine(h.id)}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/renderer.test.ts`
Expected: PASS（6 passed）。

> **对齐 Task 0 spike**：`appendBlock` 收到「列表项 + 末行 IAL」时 `custom-acorny-id` 落在哪个块（list / list-item）、嵌套 note 下 IAL 是否仍生效——**已在 Task 0 用真实 kernel 冻结 fixture**。若 spike 结论要求调整 markdown 语法（或触发降级到 setBlockAttrs），据此改本文件与测试。

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts src/renderer.test.ts
git commit -m "feat(renderer): 思源列表项 + 内联 IAL + note/标签渲染"
```

---

## Task 7: `scheduler.ts`（原样复用自动重排）

**Files:**
- Create: `src/scheduler.ts`
- Test: `src/scheduler.test.ts`

**Interfaces:**
- Consumes: `syncEngine.SyncResult`（见 Task 8；本任务先用最小内联类型占位，Task 8 落地后类型自然对齐）
- Produces: `nextAutoDelayMs(result: SyncResult, pollIntervalMinutes: number): number | null`

> **排序注意**：`scheduler.ts` 从 `./syncEngine` import `SyncResult` 类型。为保持 TDD 顺序，本任务先在 `scheduler.ts` 内 `import type { SyncResult } from './syncEngine'`，并在 Task 8 之前用一个**临时** `src/syncEngine.ts` 存根仅导出 `SyncResult` 类型即可通过类型检查；Task 8 会补全实现。若执行顺序为「先 Task 8 后 Task 7」，则无需存根。推荐先做 Task 8 再做 Task 7。

- [ ] **Step 1: 写失败测试 `src/scheduler.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { nextAutoDelayMs } from './scheduler'

describe('nextAutoDelayMs', () => {
  it('auth_failed → null (pause auto)', () => {
    expect(nextAutoDelayMs({ status: 'auth_failed' }, 5)).toBeNull()
  })

  it('backoff → retryAfterSeconds in ms', () => {
    expect(nextAutoDelayMs({ status: 'backoff', retryAfterSeconds: 30 }, 5)).toBe(30_000)
  })

  it('completed → interval in ms when polling enabled', () => {
    expect(nextAutoDelayMs({ status: 'completed', pages: 1, added: 2 }, 5)).toBe(300_000)
  })

  it('completed → null when polling disabled', () => {
    expect(nextAutoDelayMs({ status: 'completed', pages: 1, added: 2 }, 0)).toBeNull()
  })

  it('skipped → interval (or null)', () => {
    expect(nextAutoDelayMs({ status: 'skipped' }, 0)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/scheduler.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 `src/scheduler.ts`**（移植，改无扩展名 import）

```ts
import type { SyncResult } from './syncEngine'

/**
 * 决定下次「自动」同步的延迟：
 * - auth_failed → null（暂停自动，直到一次手动同步重新启用）
 * - backoff     → retryAfterSeconds（近端重试；成功后恢复常规节奏）
 * - completed/skipped → 常规 interval（interval 关闭则 null）
 */
export function nextAutoDelayMs(result: SyncResult, pollIntervalMinutes: number): number | null {
  const interval = pollIntervalMinutes > 0 ? pollIntervalMinutes * 60_000 : null
  switch (result.status) {
    case 'auth_failed':
      return null
    case 'backoff':
      return result.retryAfterSeconds * 1000
    case 'completed':
    case 'skipped':
      return interval
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/scheduler.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts src/scheduler.test.ts
git commit -m "feat(scheduler): 移植自动同步延迟决策"
```

---

## Task 8: `syncEngine.ts`（改造：SQL 索引依赖 + 新 writeSource 签名）

**Files:**
- Create: `src/syncEngine.ts`
- Test: `src/syncEngine.test.ts`

**Interfaces:**
- Consumes: `types.{AcornySettings, ExportFeedResponse, ExportFeedSource, ExportFeedHighlight, PluginState, SyncStatus, SyncedIndex}`、`apiClient.{AuthError, RateLimitError}`、`connection.connectionId`
- Produces:
  - `type SyncResult = { status: 'completed'; pages; added } | { status: 'skipped' } | { status: 'auth_failed' } | { status: 'backoff'; retryAfterSeconds }`
  - `interface SyncEngineDeps { getSettings; loadState; saveState; loadSyncedIndex: () => Promise<SyncedIndex>; fetchPage; writeSource: (source, highlights, index: SyncedIndex) => Promise<{ docId: string; added: number }>; onStatus; isAborted? }`
  - `class SyncEngine { constructor(deps); sync(): Promise<SyncResult> }`

- [ ] **Step 1: 写失败测试 `src/syncEngine.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { SyncEngine, type SyncEngineDeps } from './syncEngine'
import type { ExportFeedHighlight, ExportFeedResponse, ExportFeedSource, PluginState, SyncedIndex } from './types'
import { AuthError, RateLimitError } from './apiClient'

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

  it('discards a foreign cursor when connection changed', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const fetchPage = vi.fn(async () => pages[0])
    const { deps } = makeDeps(pages, { fetchPage, loadState: async () => ({ lastCursor: '999', connectionId: 'OTHER' }) })
    await new SyncEngine(deps).sync()
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }))
  })

  it('aborted mid-drain → skipped and no state persisted', async () => {
    const s1 = src('s1')
    const pages: ExportFeedResponse[] = [{ highlights: [hl('h1', s1)], nextCursor: '', done: true }]
    const { deps, getSaved } = makeDeps(pages, { isAborted: () => true })
    const res = await new SyncEngine(deps).sync()
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/syncEngine.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `src/syncEngine.ts`**

在 Obsidian 版基础上改造：`index` 来自 `deps.loadSyncedIndex()`（不再来自持久化 state）；`writeSource` 新签名返回 `{docId, added}`；`saveState` 只存 `{lastCursor, connectionId}`。

```ts
import type {
  AcornySettings, ExportFeedHighlight, ExportFeedResponse, ExportFeedSource, PluginState, SyncedIndex, SyncStatus,
} from './types'
import { AuthError, RateLimitError } from './apiClient'
import { connectionId } from './connection'

export type SyncResult =
  | { status: 'completed'; pages: number; added: number }
  | { status: 'skipped' }
  | { status: 'auth_failed' }
  | { status: 'backoff'; retryAfterSeconds: number }

export interface SyncEngineDeps {
  getSettings: () => AcornySettings
  loadState: () => Promise<PluginState>
  saveState: (state: PluginState) => Promise<void>
  /** 一次同步开始时拉取思源 SQL 的全量已同步索引（思源即真相）。 */
  loadSyncedIndex: () => Promise<SyncedIndex>
  fetchPage: (req: { serverUrl: string; token: string; cursor: string | null }) => Promise<ExportFeedResponse>
  writeSource: (
    source: ExportFeedSource,
    highlights: ExportFeedHighlight[],
    index: SyncedIndex,
  ) => Promise<{ docId: string; added: number }>
  onStatus: (status: SyncStatus, detail?: string) => void
  /** 返回 true（插件被禁用/重载）时，drain 在下次 fetch/write 前停止且不持久化状态。 */
  isAborted?: () => boolean
}

const MAX_PAGES = 10_000 // 防服务端 bug 无限翻页的安全阀

export class SyncEngine {
  private running = false
  constructor(private readonly deps: SyncEngineDeps) {}

  async sync(): Promise<SyncResult> {
    if (this.running) return { status: 'skipped' }
    this.running = true
    this.deps.onStatus('syncing')
    try {
      // 同步开始时快照连接，保证本次 drain 每页都用同一 server/token，
      // 即使用户中途改了设置。
      const settings = this.deps.getSettings()
      const { serverUrl, exportToken: token } = settings
      const conn = connectionId(serverUrl, token)

      const aborted = this.deps.isAborted ?? (() => false)

      const state = await this.deps.loadState()
      // 持久化游标属于另一 server/账号时弃用——重放外来游标可能静默漏数据。
      const sameConnection = state.connectionId === conn
      let cursor = sameConnection ? state.lastCursor : null

      // 去重索引一律来自思源 SQL（不依赖本地缓存）：跨账号也安全，因为块属性即真相。
      const index = await this.deps.loadSyncedIndex()
      let pages = 0
      let added = 0

      for (;;) {
        if (aborted()) return { status: 'skipped' }
        const page = await this.deps.fetchPage({ serverUrl, token, cursor })
        pages += 1
        for (const [, group] of groupBySource(page.highlights)) {
          if (aborted()) return { status: 'skipped' }
          const result = await this.deps.writeSource(group.source, group.highlights, index)
          added += result.added
        }
        cursor = page.nextCursor
        if (page.done) break
        if (pages >= MAX_PAGES) break
      }

      // 绝不代表已废弃实例持久化——那会用陈旧快照覆盖活实例的状态。
      if (aborted()) return { status: 'skipped' }
      await this.deps.saveState({ lastCursor: cursor, connectionId: conn })
      this.deps.onStatus('idle')
      return { status: 'completed', pages, added }
    } catch (error) {
      if (error instanceof AuthError) {
        this.deps.onStatus('auth_failed', 'Export token rejected — check Settings.')
        return { status: 'auth_failed' }
      }
      if (error instanceof RateLimitError) {
        this.deps.onStatus('backoff', `Rate limited, retry in ${error.retryAfterSeconds}s`)
        return { status: 'backoff', retryAfterSeconds: error.retryAfterSeconds }
      }
      console.error('[Acorny] Unexpected sync error:', error)
      this.deps.onStatus('backoff', error instanceof Error ? error.message : 'Sync failed')
      return { status: 'backoff', retryAfterSeconds: 60 }
    } finally {
      this.running = false
    }
  }
}

function groupBySource(
  highlights: ExportFeedHighlight[],
): Map<string, { source: ExportFeedSource; highlights: ExportFeedHighlight[] }> {
  const groups = new Map<string, { source: ExportFeedSource; highlights: ExportFeedHighlight[] }>()
  for (const h of highlights) {
    const existing = groups.get(h.source.id)
    if (existing) existing.highlights.push(h)
    else groups.set(h.source.id, { source: h.source, highlights: [h] })
  }
  return groups
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/syncEngine.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/syncEngine.ts src/syncEngine.test.ts
git commit -m "feat(syncEngine): 游标增量 drain，索引来自 SQL、writeSource 返回 docId"
```

---

## Task 9: `httpProxy.ts`（forwardProxy → HttpRequest 适配）

**Files:**
- Create: `src/httpProxy.ts`
- Test: `src/httpProxy.test.ts`

**Interfaces:**
- Consumes: `apiClient.{HttpRequest, HttpResponse}`
- Produces:
  - `interface ForwardProxyResponse { status: number; body: string; headers: Record<string, string> }`
  - `type ForwardProxyFn = (req: { url: string; method: string; headers: { [k: string]: string }[]; timeout?: number }) => Promise<ForwardProxyResponse>`
  - `createForwardProxyHttp(forwardProxy: ForwardProxyFn): HttpRequest`

- [ ] **Step 1: 写失败测试 `src/httpProxy.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createForwardProxyHttp, type ForwardProxyResponse } from './httpProxy'

describe('createForwardProxyHttp', () => {
  it('maps request headers to forwardProxy [{K:V}] array and GET method', async () => {
    const fp = vi.fn(async (): Promise<ForwardProxyResponse> => ({ status: 200, body: '{}', headers: {} }))
    const http = createForwardProxyHttp(fp)
    await http({ url: 'https://api.acorny.io/x', headers: { Authorization: 'Token tk' } })
    expect(fp).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.acorny.io/x',
      method: 'GET',
      headers: [{ Authorization: 'Token tk' }],
    }))
  })

  it('parses JSON body and lowercases response header keys', async () => {
    const fp = async (): Promise<ForwardProxyResponse> => ({ status: 200, body: '{"a":1}', headers: { 'Retry-After': '9' } })
    const res = await createForwardProxyHttp(fp)({ url: 'u', headers: {} })
    expect(res).toEqual({ status: 200, json: { a: 1 }, headers: { 'retry-after': '9' } })
  })

  it('passes non-2xx status through with json=null on unparseable body', async () => {
    const fp = async (): Promise<ForwardProxyResponse> => ({ status: 429, body: 'rate limited', headers: {} })
    const res = await createForwardProxyHttp(fp)({ url: 'u', headers: {} })
    expect(res).toEqual({ status: 429, json: null, headers: {} })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/httpProxy.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 `src/httpProxy.ts`**

```ts
import type { HttpRequest, HttpResponse } from './apiClient'

/** 思源 forwardProxy 响应（data 字段）。 */
export interface ForwardProxyResponse {
  status: number
  body: string
  headers: Record<string, string>
}

export type ForwardProxyFn = (req: {
  url: string
  method: string
  headers: { [k: string]: string }[]
  timeout?: number
}) => Promise<ForwardProxyResponse>

/** header 键统一小写，供 apiClient 一致读取（如 retry-after）。 */
function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
  return out
}

/**
 * 用思源 forwardProxy 实现 apiClient 的 HttpRequest（全平台绕 CORS）。
 * - 请求 headers {K:V} → forwardProxy 的 [{K:V}] 数组
 * - 响应 data.status 透传；JSON.parse(data.body) → json（失败则 null）；headers 小写化
 */
export function createForwardProxyHttp(forwardProxy: ForwardProxyFn): HttpRequest {
  return async ({ url, headers }): Promise<HttpResponse> => {
    const headerArray = Object.entries(headers).map(([k, v]) => ({ [k]: v }))
    const resp = await forwardProxy({ url, method: 'GET', headers: headerArray })
    let json: unknown = null
    try {
      json = resp.body ? JSON.parse(resp.body) : null
    } catch {
      json = null
    }
    return { status: resp.status, json, headers: lowerKeys(resp.headers ?? {}) }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/httpProxy.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 4b: 追加基于 Task 0 真实 fixture 的回归断言**

追加进 `src/httpProxy.test.ts`，用 Task 0 冻结的真实 forwardProxy 响应验证映射（`data.status` 透传、header 小写化在真实形状下成立）：

```ts
import forwardProxyFixture from './__fixtures__/kernel/forwardProxy.json'

describe('createForwardProxyHttp (real Task 0 fixture)', () => {
  it('maps the REAL forwardProxy data shape: status passthrough + lowercased header keys', async () => {
    const data = (forwardProxyFixture as { data: { status: number; body: string; headers: Record<string, string> } }).data
    const res = await createForwardProxyHttp(async () => data)({ url: 'u', headers: {} })
    expect(res.status).toBe(data.status)
    for (const k of Object.keys(res.headers)) expect(k).toBe(k.toLowerCase())
  })
})
```

Run: `pnpm exec vitest run src/httpProxy.test.ts`
Expected: PASS。若字段名/形状与假设不符（如 body 为 base64、headers 是数组），据 fixture 修 `createForwardProxyHttp` 与 synthetic 测试。

- [ ] **Step 5: Commit**

```bash
git add src/httpProxy.ts src/httpProxy.test.ts
git commit -m "feat(httpProxy): forwardProxy 适配 HttpRequest，header 小写化（含真实 fixture 回归）"
```

---

## Task 10: `siyuanClient.ts`（kernel API 薄封装 + 纯提取器）

**Files:**
- Create: `src/siyuanClient.ts`
- Test: `src/siyuanClient.test.ts`（仅测纯提取器）

**Interfaces:**
- Consumes: `siyuan` SDK 的 `fetchSyncPost`、`httpProxy.{ForwardProxyFn, ForwardProxyResponse}`
- Produces:
  - `interface Notebook { id: string; name: string }`
  - `extractAppendedBlockId(data: unknown): string`（纯，从 `data[0].doOperations[0].id` 取新块 id；缺失抛错）
  - `interface SiyuanClient { lsNotebooks(): Promise<Notebook[]>; createDocWithMd(notebookId, hpath, markdown): Promise<string>; appendBlock(parentId, markdown): Promise<string>; setBlockAttrs(blockId, attrs): Promise<void>; querySql<T>(sql): Promise<T[]>; forwardProxy: ForwardProxyFn }`
  - `createSiyuanClient(): SiyuanClient`

- [ ] **Step 1: 写失败测试 `src/siyuanClient.test.ts`**（只测无 kernel 依赖的纯提取器）

```ts
import { describe, expect, it } from 'vitest'
import { extractAppendedBlockId } from './siyuanClient'

describe('extractAppendedBlockId', () => {
  it('reads data[0].doOperations[0].id', () => {
    expect(extractAppendedBlockId([{ doOperations: [{ id: '20260722-abc' }] }])).toBe('20260722-abc')
  })

  it('throws on unexpected shape', () => {
    expect(() => extractAppendedBlockId([])).toThrow()
    expect(() => extractAppendedBlockId(null)).toThrow()
    expect(() => extractAppendedBlockId([{ doOperations: [] }])).toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/siyuanClient.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 `src/siyuanClient.ts`**

`fetchSyncPost` 返回 `{ code, msg, data }`；`code !== 0` 抛错。所有 endpoint 走前端会话鉴权，无需手动 token。

```ts
import { fetchSyncPost } from 'siyuan'
import type { ForwardProxyFn, ForwardProxyResponse } from './httpProxy'

export interface Notebook {
  id: string
  name: string
}

export interface SiyuanClient {
  lsNotebooks(): Promise<Notebook[]>
  /** 建文档，返回文档（根块）id。同 hpath 幂等，不覆盖已有内容。 */
  createDocWithMd(notebookId: string, hpath: string, markdown: string): Promise<string>
  /** 追加块（markdown 可含内联 IAL），返回新块 id。 */
  appendBlock(parentId: string, markdown: string): Promise<string>
  setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void>
  querySql<T>(sql: string): Promise<T[]>
  forwardProxy: ForwardProxyFn
}

interface KernelResponse<T> {
  code: number
  msg: string
  data: T
}

/** 从 appendBlock 事务响应中取新块 id：data[0].doOperations[0].id。 */
export function extractAppendedBlockId(data: unknown): string {
  const op = Array.isArray(data)
    ? (data[0] as { doOperations?: Array<{ id?: string }> } | undefined)?.doOperations?.[0]
    : undefined
  const id = op?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`appendBlock: 无法从响应解析新块 id: ${JSON.stringify(data)}`)
  }
  return id
}

async function post<T>(url: string, payload: unknown): Promise<T> {
  const res = (await fetchSyncPost(url, payload)) as KernelResponse<T>
  if (res.code !== 0) throw new Error(`${url} failed (code ${res.code}): ${res.msg}`)
  return res.data
}

export function createSiyuanClient(): SiyuanClient {
  return {
    async lsNotebooks() {
      const data = await post<{ notebooks: Notebook[] }>('/api/notebook/lsNotebooks', {})
      return data.notebooks.map((n) => ({ id: n.id, name: n.name }))
    },
    async createDocWithMd(notebook, path, markdown) {
      return post<string>('/api/filetree/createDocWithMd', { notebook, path, markdown })
    },
    async appendBlock(parentID, data) {
      const opData = await post<unknown>('/api/block/appendBlock', { parentID, dataType: 'markdown', data })
      return extractAppendedBlockId(opData)
    },
    async setBlockAttrs(id, attrs) {
      await post<unknown>('/api/attr/setBlockAttrs', { id, attrs })
    },
    async querySql<T>(stmt: string) {
      return post<T[]>('/api/query/sql', { stmt })
    },
    async forwardProxy(req): Promise<ForwardProxyResponse> {
      return post<ForwardProxyResponse>('/api/network/forwardProxy', {
        url: req.url,
        method: req.method,
        headers: req.headers,
        timeout: req.timeout ?? 15000,
        contentType: 'application/json',
      })
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/siyuanClient.test.ts`
Expected: PASS（2 passed）。

> **对齐 Task 0 spike**：`createDocWithMd` 返回值是否直接是 doc id 字符串、`appendBlock` 新块 id 路径、`forwardProxy` 响应 `data` 形状（body 是否 base64、`data.headers` 键大小写）——**已在 Task 0 冻结 fixture**；本文件按 fixture 对齐，必要时用 fixture 补最小回归测试（spec §11）。

- [ ] **Step 4b: 追加基于 Task 0 真实 fixture 的回归断言**

把手写 synthetic 之外，加一条**对真实 kernel 响应形状**的断言（满足 AGENTS §6.2「固化真实 response shape」），追加进 `src/siyuanClient.test.ts`：

```ts
import appendBlockFixture from './__fixtures__/kernel/appendBlock.json'

describe('extractAppendedBlockId (real Task 0 fixture)', () => {
  it('extracts a non-empty block id from the REAL appendBlock response', () => {
    // fixture 是 Task 0 冻结的 kernel 原始响应 { code, msg, data }
    const data = (appendBlockFixture as { data: unknown }).data
    const id = extractAppendedBlockId(data)
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })
})
```

Run: `pnpm exec vitest run src/siyuanClient.test.ts`
Expected: PASS（含真实 fixture 断言）。若失败，说明真实响应路径与 `data[0].doOperations[0].id` 不符 → 据 fixture 修 `extractAppendedBlockId` 与其 synthetic 测试。

- [ ] **Step 5: Commit**

```bash
git add src/siyuanClient.ts src/siyuanClient.test.ts
git commit -m "feat(siyuanClient): kernel API 薄封装与新块 id 提取器（含真实 fixture 回归）"
```

---

## Task 11: `siyuanGateway.ts`（loadSyncedIndex / ensureSourceDoc / writeSource）

**Files:**
- Create: `src/siyuanGateway.ts`
- Test: `src/siyuanGateway.test.ts`（用 fake SiyuanClient）

**Interfaces:**
- Consumes: `siyuanClient.SiyuanClient`、`types.{ExportFeedSource, ExportFeedHighlight, SyncedIndex}`、`docPath.buildDocHPath`、`renderer.renderHighlightBlock`
- Produces:
  - `loadSyncedIndex(client: SiyuanClient): Promise<SyncedIndex>`
  - `createSiyuanGateway(client, opts: { notebookId; docFolderPath }): { loadSyncedIndex; writeSource(source, highlights, index): Promise<{ docId; added }> }`

- [ ] **Step 1: 写失败测试 `src/siyuanGateway.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { createSiyuanGateway } from './siyuanGateway'
import type { SiyuanClient } from './siyuanClient'
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/siyuanGateway.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 `src/siyuanGateway.ts`**

```ts
import type { SiyuanClient } from './siyuanClient'
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
    const hpath = buildDocHPath(opts.docFolderPath, source.title, source.id)
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/siyuanGateway.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/siyuanGateway.ts src/siyuanGateway.test.ts
git commit -m "feat(siyuanGateway): SQL 索引加载与原子 IAL 写入的 writeSource"
```

---

## Task 12: `index.ts` + 设置面板 + i18n（Plugin 接线，QA 验证）

**Files:**
- Modify: `src/i18n/en.json`、`src/i18n/zh-CN.json`（覆盖模板内容；**沿用脚手架现有的连字符文件名**，不新建 `zh_CN.json`——Codex #4）
- Modify/Rewrite: `src/index.ts`（重写为同步插件主体）
- Modify: `src/index.scss`（可留空/最小样式）
- Test: 手动 QA（思源桌面端），无 headless 单测

> 说明：设置面板用思源 `Setting` API，与主体强耦合、无法 headless 单测，故与 `index.ts` 合并为一个任务；纯逻辑已在 Task 2–11 覆盖。

**Interfaces:**
- Consumes: `types`、`connection`、`apiClient.fetchFeedPage`、`httpProxy.createForwardProxyHttp`、`siyuanClient.createSiyuanClient`、`siyuanGateway.createSiyuanGateway`、`syncEngine.SyncEngine`、`scheduler.nextAutoDelayMs`
- Produces: 默认导出 `class AcornySyncPlugin extends Plugin`

- [ ] **Step 1: 写 i18n 文案**

`src/i18n/en.json`：

```json
{
  "syncNow": "Acorny: Sync now",
  "syncing": "Acorny: syncing…",
  "syncedCount": "Acorny: synced ${count} new highlight(s).",
  "authFailed": "Acorny: export token rejected — update it in Settings.",
  "backoff": "Acorny: sync deferred (${seconds}s).",
  "setTokenFirst": "Acorny: set your export token in Settings first.",
  "selectNotebookFirst": "Acorny: choose a target notebook in Settings first.",
  "settingServerUrl": "Server URL",
  "settingExportToken": "Export token",
  "settingNotebook": "Target notebook",
  "settingFolder": "Document folder (hpath)",
  "settingSyncOnStartup": "Sync on startup",
  "settingPollInterval": "Auto-sync interval (minutes, 0 = off)",
  "save": "Save"
}
```

`src/i18n/zh-CN.json`（**改现有文件，连字符**）：

```json
{
  "syncNow": "Acorny：立即同步",
  "syncing": "Acorny：同步中…",
  "syncedCount": "Acorny：新增 ${count} 条高亮。",
  "authFailed": "Acorny：导出令牌被拒——请在设置里更新。",
  "backoff": "Acorny：同步已延后（${seconds}s）。",
  "setTokenFirst": "Acorny：请先在设置里填写导出令牌。",
  "selectNotebookFirst": "Acorny：请先在设置里选择目标笔记本。",
  "settingServerUrl": "服务地址",
  "settingExportToken": "导出令牌",
  "settingNotebook": "目标笔记本",
  "settingFolder": "文档文件夹（hpath）",
  "settingSyncOnStartup": "启动时同步",
  "settingPollInterval": "自动同步间隔（分钟，0=关闭）",
  "save": "保存"
}
```

> 思源 i18n 文件名沿用脚手架现有的 `en.json` / `zh-CN.json`（**连字符**，与 `plugin.json` 的 `readme.zh-CN` 一致），随 `src/i18n/` 被 webpack 拷贝。**不要**新建 `zh_CN.json`（下划线）——两份并存会导致中文 key 不被加载（Codex #4）。

- [ ] **Step 2: 重写 `src/index.ts`**

```ts
import { Plugin, Setting, showMessage } from 'siyuan'
import type { AcornySettings, PluginState, SyncStatus } from './types'
import { fetchFeedPage } from './apiClient'
import { createForwardProxyHttp } from './httpProxy'
import { createSiyuanClient, type Notebook } from './siyuanClient'
import { createSiyuanGateway, type SiyuanGateway } from './siyuanGateway'
import { SyncEngine } from './syncEngine'
import { nextAutoDelayMs } from './scheduler'

const STORAGE = 'acorny-sync.json'

const DEFAULT_SETTINGS: AcornySettings = {
  serverUrl: 'https://api.acorny.io',
  exportToken: '',
  notebookId: '',
  docFolderPath: '/Acorny',
  syncOnStartup: true,
  pollIntervalMinutes: 0,
}
const DEFAULT_STATE: PluginState = { lastCursor: null, connectionId: null }

interface PersistShape {
  settings?: Partial<AcornySettings>
  state?: PluginState
}

export default class AcornySyncPlugin extends Plugin {
  private settings: AcornySettings = { ...DEFAULT_SETTINGS }
  private state: PluginState = { ...DEFAULT_STATE }
  private engine!: SyncEngine
  private client = createSiyuanClient()
  private autoTimer: number | null = null
  private disposed = false
  private ready = false
  /** 插件级同步单飞门：在设置 activeGateway 之前就拦截并发触发，防止第二次运行覆盖第一次的目的地快照。 */
  private syncing = false
  private notebooks: Notebook[] = []
  /** 当前同步运行期的网关快照（notebook/folder 在 runSync 起点冻结）。 */
  private activeGateway: SiyuanGateway | null = null

  async onload(): Promise<void> {
    // 先「同步」注册 UI：siyuan 的 onload 是同步 void 生命周期，宿主不保证 await 完成；
    // 在首个 await 之后再 addTopBar/addCommand 会有卸载/布局竞态（Codex 次要项）。
    // this.i18n 在 onload 前已由框架加载，可安全使用。
    this.addTopBar({
      icon: 'iconRefresh',
      title: this.i18n.syncNow,
      position: 'right',
      callback: () => void this.runSync(),
    })
    this.addCommand({ langKey: 'syncNow', hotkey: '', callback: () => void this.runSync() })

    await this.loadPersisted()
    // 卸载竞态：插件可能在 loadPersisted 期间已被禁用/卸载，别再继续建 engine/设置面板/启动同步。
    if (this.disposed) return

    const http = createForwardProxyHttp(this.client.forwardProxy)
    this.engine = new SyncEngine({
      getSettings: () => this.settings,
      loadState: async () => this.state,
      saveState: async (s) => { this.state = s; await this.persist() },
      // 网关在每次同步开始时快照（notebook/folder），见 runSync。
      loadSyncedIndex: () => this.requireGateway().loadSyncedIndex(),
      fetchPage: ({ serverUrl, token, cursor }) => fetchFeedPage(http, { serverUrl, token, cursor }),
      writeSource: (source, highlights, index) => this.requireGateway().writeSource(source, highlights, index),
      onStatus: (status, detail) => this.setStatus(status, detail),
      isAborted: () => this.disposed,
    })
    this.ready = true

    void this.buildSettingPanel()

    if (this.settings.syncOnStartup) void this.runSync()
    this.scheduleAuto(this.settings.pollIntervalMinutes > 0 ? this.settings.pollIntervalMinutes * 60_000 : null)
  }

  onunload(): void {
    this.disposed = true
    this.clearAuto()
  }

  /** SyncEngine 运行期取当前已冻结的网关；未冻结说明调用时序有误。 */
  private requireGateway(): SiyuanGateway {
    if (!this.activeGateway) throw new Error('gateway not initialized for this sync run')
    return this.activeGateway
  }

  private scheduleAuto(delayMs: number | null): void {
    this.clearAuto()
    if (this.disposed || delayMs === null || delayMs <= 0) return
    this.autoTimer = window.setTimeout(() => { void this.runSync() }, delayMs)
  }

  private clearAuto(): void {
    if (this.autoTimer !== null) {
      window.clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
  }

  private async runSync(): Promise<void> {
    if (this.disposed || !this.ready) return
    // 插件级单飞门：必须在设置 activeGateway 之前拦截并发触发（双击 / 启动同步与定时器重叠），
    // 否则第二次 runSync 会先把 activeGateway 改成新目的地，正在进行的第一次同步后续页面
    // 就会写到新目的地——重新引入「同步中途切换 notebook/folder」的问题（Codex #1）。
    if (this.syncing) return
    if (!this.settings.exportToken) { showMessage(this.i18n.setTokenFirst); return }
    if (!this.settings.notebookId) { showMessage(this.i18n.selectNotebookFirst); return }
    this.syncing = true
    // 在本次运行起点冻结目的地（notebook/folder），避免 drain 期间用户改设置写错地方。
    this.activeGateway = createSiyuanGateway(this.client, {
      notebookId: this.settings.notebookId,
      docFolderPath: this.settings.docFolderPath,
    })
    try {
      const res = await this.engine.sync()
      if (this.disposed) return
      if (res.status === 'completed') {
        showMessage(this.i18n.syncedCount.replace('${count}', String(res.added)))
      } else if (res.status === 'auth_failed') {
        showMessage(this.i18n.authFailed)
      } else if (res.status === 'backoff') {
        showMessage(this.i18n.backoff.replace('${seconds}', String(res.retryAfterSeconds)))
      }
      if (res.status !== 'skipped') {
        this.scheduleAuto(nextAutoDelayMs(res, this.settings.pollIntervalMinutes))
      }
    } finally {
      this.syncing = false
      this.activeGateway = null
    }
  }

  private setStatus(_status: SyncStatus, _detail?: string): void {
    // 顶栏图标无常驻文本；状态通过 showMessage 反馈。保留钩子以便后续加状态条。
  }

  private async buildSettingPanel(): Promise<void> {
    try {
      this.notebooks = await this.client.lsNotebooks()
    } catch {
      this.notebooks = []
    }
    const draft: AcornySettings = { ...this.settings }
    this.setting = new Setting({
      confirmCallback: () => {
        this.settings = { ...draft }
        void this.persist()
        // 保存后立即按新 interval 重排自动同步：0→正数要能启动，正数→0 要能停（Codex 次要项）。
        this.scheduleAuto(this.settings.pollIntervalMinutes > 0 ? this.settings.pollIntervalMinutes * 60_000 : null)
      },
    })

    const textInput = (key: 'serverUrl' | 'docFolderPath', type = 'text') => {
      const el = document.createElement('input')
      el.className = 'b3-text-field fn__block'
      el.type = type
      el.value = draft[key]
      el.addEventListener('input', () => { draft[key] = el.value })
      return el
    }

    this.setting.addItem({
      title: this.i18n.settingServerUrl,
      createActionElement: () => textInput('serverUrl'),
    })
    this.setting.addItem({
      title: this.i18n.settingExportToken,
      createActionElement: () => {
        const el = document.createElement('input')
        el.className = 'b3-text-field fn__block'
        el.type = 'password'
        el.value = draft.exportToken
        el.addEventListener('input', () => { draft.exportToken = el.value })
        return el
      },
    })
    this.setting.addItem({
      title: this.i18n.settingNotebook,
      createActionElement: () => {
        const el = document.createElement('select')
        el.className = 'b3-select fn__block'
        for (const nb of this.notebooks) {
          const opt = document.createElement('option')
          opt.value = nb.id
          opt.textContent = nb.name
          if (nb.id === draft.notebookId) opt.selected = true
          el.append(opt)
        }
        el.addEventListener('change', () => { draft.notebookId = el.value })
        return el
      },
    })
    this.setting.addItem({
      title: this.i18n.settingFolder,
      createActionElement: () => textInput('docFolderPath'),
    })
    this.setting.addItem({
      title: this.i18n.settingSyncOnStartup,
      createActionElement: () => {
        const el = document.createElement('input')
        el.className = 'b3-switch fn__flex-center'
        el.type = 'checkbox'
        el.checked = draft.syncOnStartup
        el.addEventListener('change', () => { draft.syncOnStartup = el.checked })
        return el
      },
    })
    this.setting.addItem({
      title: this.i18n.settingPollInterval,
      createActionElement: () => {
        const el = document.createElement('input')
        el.className = 'b3-text-field fn__block'
        el.type = 'number'
        el.min = '0'
        el.value = String(draft.pollIntervalMinutes)
        el.addEventListener('input', () => { draft.pollIntervalMinutes = Number(el.value) || 0 })
        return el
      },
    })
  }

  private async loadPersisted(): Promise<void> {
    const data = ((await this.loadData(STORAGE)) as PersistShape | null) ?? {}
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) }
    this.state = { ...DEFAULT_STATE, ...(data.state ?? {}) }
  }

  private async persist(): Promise<void> {
    const payload: PersistShape = { settings: this.settings, state: this.state }
    await this.saveData(STORAGE, payload)
  }
}
```

> **实现期核对**（`siyuan` 1.2.2 类型）：`addTopBar` 的参数字段、`addCommand` 的 `langKey`/`hotkey` 必填项、`Setting.addItem` 的 `createActionElement` 签名、`loadData/saveData` 是否需 STORAGE 参数——以 `node_modules/siyuan` 的 `.d.ts` 为准，若签名不符按真实类型微调（不改变行为）。

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: 无 error；产出 `dist/`。

- [ ] **Step 4: 全量单测回归**

Run: `pnpm test`
Expected: 全部 PASS（Task 3–11 的用例）。

- [ ] **Step 5: 思源桌面端真机 QA（headed，记录结果）**

在思源桌面端加载 `dev` 构建，逐项验证并记录：

1. 设置面板：笔记本下拉能列出、令牌密码框、各字段保存后重载仍在。
2. 首次同步：`/Acorny/<title>-<hash>` 文档被创建；文档根块有 `custom-acorny-source-id`（用 `属性面板` 或 `SELECT * FROM attributes WHERE block_id=...` 核对）。
3. **原子 IAL 校验**（对齐 Task 6/10 待验证项）：每个高亮块查得 `custom-acorny-id`；确认是 `appendBlock` 一次落地（非二次 setBlockAttrs）。若 IAL 未生效，回到 Task 6 调整 markdown 语法并更新其单测。
4. 重复同步：再次触发，新增 0 条、无重复块（幂等）。
5. 编辑保护：手改一个已同步块内容 + 改文档名，再同步——改动保留、不重建、不追加。
6. 同名不同 source：构造两个同名 source，确认落到两篇不同文档、不串数据。
7. 令牌错误：填错令牌→`authFailed` 提示；`429`（如可复现）→backoff 提示。
8. forwardProxy：确认请求到达 Acorny 且 `data.status/body/headers` 形状与 `httpProxy`/`siyuanClient` 假设一致；如不符，回改对应文件 + 补最小回归测试。
9. 移动端（如可测）：`forwardProxy`/`fetchSyncPost` 可用性冒烟。
10. **并发触发（Codex #1 回归）**：一次同步进行中，再次点击顶栏/命令，或在同步中途改 notebook/folder——确认第二次触发被 `syncing` 门挡下（无效果、不改目的地），第一次同步全程只写最初冻结的目的地，不出现写到新笔记本的块。

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/i18n/ src/index.scss
git commit -m "feat(index): Plugin 接线、设置面板与 i18n，完成端到端同步

- What: 顶栏/命令触发、Setting 面板、依赖注入 SyncEngine+网关、启动/定时同步
- Why: 打通纯逻辑与思源耦合层，形成可用插件
- Impact/Test: pnpm test 全绿；思源桌面端 QA 覆盖建档/幂等/编辑保护/同名去重/令牌错误"
```

---

## Task 13: README 双语 + 收尾检查

**Files:**
- Modify: `README.md`、`README.zh-CN.md`（替换模板内容为本插件说明）
- Modify: `CHANGELOG.md`（首版条目）

**Interfaces:**
- Consumes: 无
- Produces: 面向用户的安装/配置/使用说明；bazaar 上架素材清单（icon 160×160、preview 1024×768）留占位说明。

- [ ] **Step 1: 重写 `README.md` / `README.zh-CN.md`**

覆盖模板内容，至少包含：功能概述（单向增量同步、块属性去重、编辑保护）、安装、设置项说明（对齐 spec §8 表）、v1 限制（不回改/不追踪删除，spec §7）、`disabledInPublish` 说明。

- [ ] **Step 2: 更新 `CHANGELOG.md`**

新增 `0.1.0` 条目：初版 Acorny→思源高亮同步。

- [ ] **Step 3: 全量检查**

Run: `pnpm lint:check && pnpm exec tsc --noEmit && pnpm test && pnpm build`
Expected: 全部通过。

> 顺序刻意为 **lint(非改动) → typecheck → test → build**：用非改动型 `lint:check`（不带 `--fix`），避免最后一步 `--fix` 改了运行时代码却让前面已跑的 test/build 失效、或把未 staged 的改动遗留在工作区（Codex #3）。想自动修复时单独跑 `pnpm lint`，修完再重跑本命令。

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs(readme): 改写为 Acorny 高亮同步插件说明与首版 changelog"
```

---

## Self-Review

**1. Spec coverage（逐节核对）：**
- §1 目标/范围 → Task 8/11 单向增量、Task 13 记录 v1 out-of-scope。✅
- §2.1 Acorny feed 契约 → Task 4。✅ §2.2 kernel API → Task 10（+ Task 11/12 真机固化）。✅
- §3 模块划分 → Task 2–12 一一对应（apiClient/connection/scheduler 复用，renderer 重写，syncEngine 改造，client/httpProxy/gateway/index 新增）。✅
- §3 脚手架清理 → Task 1（删 kernel、改 plugin.json/package.json/webpack）。✅
- §4 数据流（loadSyncedIndex→drain→writeSource）→ Task 8 + Task 11。✅
- §5 去重/编辑保护/原子 IAL/path 去重 → Task 5（path 去重）+ Task 6（IAL）+ Task 11（SQL 索引 + 原子写 + 复用）。✅
- §6 forwardProxy 适配 + header 大小写 → Task 9。✅
- §7 v1 行为取舍（仅追加、note 嵌套、#标签#、disabledInPublish）→ Task 6（渲染）+ Task 1（disabledInPublish）+ Task 13（文档）。✅
- §8 设置项 → Task 12 设置面板 + DEFAULT_SETTINGS。✅
- §9 状态存储（saveData/loadData、connectionId）→ Task 8（saveState 形状）+ Task 12（persist）。✅
- §10 测试策略（纯逻辑单测 + 真机 QA + 边界）→ Task 3–11 单测 + Task 12 QA；边界：空 feed/多页/跨页/同名/note null/tags 空/429/令牌失效 均有对应用例。✅
- §11 风险（forwardProxy 透传、IAL 解析、同名冲突、createDocWithMd 语义）→ Task 6/9/10/11 标注真机固化。✅
- §12 变更文件一览 → 与本计划 File Structure 一致。✅

**2. Placeholder scan：** 未使用 “TBD/TODO/适当处理/类似 Task N” 等占位；每个代码步骤含完整代码。真机 QA 待验证项均为「实现期以真实响应固化」的显式验证步骤，非占位。✅

**3. Type consistency：**
- `SyncedIndex { sourceDocMap: Record<string,string>; syncedHlIds: Set<string> }` 在 types/syncEngine/gateway/测试中一致。✅
- `writeSource(source, highlights, index) → { docId, added }` 在 syncEngine 接口、gateway 实现、两处测试中签名一致。✅
- `HttpRequest`/`HttpResponse` 由 apiClient 定义，httpProxy 消费；`ForwardProxyFn`/`ForwardProxyResponse` 由 httpProxy 定义，siyuanClient 消费。✅
- `nextAutoDelayMs(SyncResult, number)` 的 `SyncResult` 来自 syncEngine（Task 7 排序说明已处理循环依赖）。✅
- `PluginState { lastCursor; connectionId }`（无 sourceIndex）在 types/syncEngine/index 一致。✅
- docPath（Task 5）用**完整 sanitized sourceId** 作 path 后缀；gateway 实现（Task 11）与其测试期望（`Deep Work-s1`）一致。`cyrb53` 仅 connection 内部使用、不导出。✅

**4. Codex review 收口（2026-07-22，两轮）：** 独立 Codex review 的发现已按核实结论处理——

第一轮：
- 必修已折进计划：i18n 连字符文件名（Task 12/#4）、tsconfig `lib` 修正（Task 1/#5）、feed 增量删除语义（spec §7/#3）、IAL 前置真机 spike（**新增 Task 0**/#7）、docPath 后缀去重（Task 5/#1）、index.ts（同步注册 UI、保存后重排 timer、同步起点冻结 notebook/folder 网关、未选笔记本用独立文案）。
- 判为设计决策/如实记录（非 bug，已写入 spec）：全库 SQL 索引 = 「移动文档不失配」的前提 + 「目标笔记本 = 新建落点」语义（#2）；v1 只承诺**单实例串行幂等**、不承诺跨设备并发一致（#6）。
- Codex 经 Context7 反向确认成立：`fetchSyncPost`/`loadData/saveData(storageName)`/`addTopBar`/`addCommand` 用法。

第二轮（全部采纳）：
- #1 `activeGateway` 并发覆盖：runSync 加**插件级 `syncing` 单飞门**，在改 activeGateway 前拦截并发触发；try/finally 复位并清空网关（Task 12）。
- #2 Task 0 fixture 未被消费：Task 9/10 增加**读取真实 fixture** 的回归断言（forwardProxy 形状 / appendBlock 新块 id），tsconfig 开 `resolveJsonModule`。
- #3 lint --fix 放最后会改文件：Task 1 加非改动型 `lint:check`，Task 13 重排为 **lint→typecheck→test→build**。
- #4 哈希非「一定唯一」：docPath 后缀改用**完整 sanitized sourceId**（UUID，真正唯一），撤回 cyrb53 方案。
- #5 Task 0 未记录版本：新增 `/api/system/version` 探测 + `minAppVersion` 结论 + 清理临时文档步骤。
- #6 spec/plan 漂移：spec §3/§12 去掉独立 settings.ts（并入 index.ts）；spec §4 数据流改完整 id；Task 5 Expected 改 8 passed；onload `await loadPersisted` 后补 `disposed` 检查。
