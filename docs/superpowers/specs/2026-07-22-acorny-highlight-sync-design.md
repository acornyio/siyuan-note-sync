# Acorny → 思源笔记 高亮同步插件 — 设计规范

**Date:** 2026-07-22
**Status:** Approved (设计已确认，实现计划见 `docs/superpowers/plans/2026-07-22-acorny-highlight-sync.md`)
**Scope:** `siyuan-note-sync` 前端插件，从 Acorny 单向同步高亮进思源笔记

---

## 1. 目标与范围

把 Acorny 的高亮单向增量同步进思源笔记：一个 Acorny source（文章/书）对应一篇思源文档，高亮作为文档内的列表块。幂等、可重复运行、保护用户在思源里的编辑。

**参考基线**：sibling 仓库 `acorny-obsidian`（Acorny→Obsidian 插件）已验证的分层架构与同步引擎。本插件复用其纯逻辑，替换写入网关与 HTTP 传输层为思源原生实现。

**明确不做（v1 out of scope）**：
- 反向同步（思源 → Acorny）
- 已同步高亮的内容回改（Acorny 端更新不回写，见 §7）
- 删除追踪 / tombstone（见 §7）
- kernel（goja）后台插件形态 —— 采用标准前端插件

---

## 2. 已核实的外部契约

### 2.1 Acorny Feed API（已在 Obsidian 版核实）

```
GET <serverUrl>/api/v1/exports/highlights/feed?limit=100&cursor=<cursor>
Authorization: Token <acornyexp_...>
```

游标分页增量同步。响应：

```ts
interface ExportFeedResponse {
  highlights: ExportFeedHighlight[]
  nextCursor: string
  done: boolean
}
interface ExportFeedHighlight {
  id: string
  quote: string
  quoteMarkdown: string | null
  note: string | null
  tags: string[]
  updatedAt: string
  source: { id: string; title: string; author: string | null; canonicalUrl: string; type: string }
}
```

错误：`401` → 令牌失效；`429` → 读 `Retry-After` 头 / body `retryAfter` 退避。

### 2.2 思源 kernel API（据 SiYuan kernel 官方 API 文档，实现时以真实响应固化）

> 来源：SiYuan 主仓库 `API_zh_CN.md`（`siyuan-note/siyuan`）。本仓库未 vendor 该文档，实现阶段以真实 kernel 响应为准并固化最小回归测试。

插件在前端通过 `fetchPost`/`fetchSyncPost` 调用，会话鉴权，**无需手动传 token**。

| Endpoint | 用途 | 关键点 |
|---|---|---|
| `/api/notebook/lsNotebooks` | 列笔记本 | 设置里下拉选目标笔记本，返回 `data.notebooks[].id/name` |
| `/api/filetree/createDocWithMd` | 建文档 | 参数 `notebook/path/markdown`，返回文档 id。**同 path 重复调用不覆盖**；path 即 hpath，末段为标题 |
| `/api/block/appendBlock` | 追加块 | 参数 `parentID/dataType:"markdown"/data`，返回新块 id 在 `data[0].doOperations[0].id`。`data` 中可内联 IAL `{: custom-acorny-id="..."}` 使块+属性一次落地（见 §5 原子写） |
| `/api/attr/setBlockAttrs` | 设块属性 | 自定义属性必须 `custom-` 前缀。仅作 IAL 不可行时的兜底；优先 IAL 内联以避免非原子窗口 |
| `/api/query/sql` | SQL 查询 | 查 `attributes`/`blocks` 表做去重索引。**发布模式禁用**（正常使用不受影响） |
| `/api/network/forwardProxy` | 正向代理 | 绕 CORS 请求 Acorny。`headers` 为 `[{K:V}]` 数组；响应 `data.status/body/headers` |

---

## 3. 架构与模块划分

沿用「纯逻辑 + 网关接口」分层，思源耦合集中在少数文件，其余为可单测纯逻辑。

```
src/
  index.ts          Plugin 类：设置UI（思源 Setting API）、顶栏图标+命令、调度器、
                    依赖接线（思源耦合）。设置面板与主体强耦合、无法 headless 单测，
                    故不拆独立 settings.ts，直接内建于 index.ts
  siyuanClient.ts   kernel API 薄封装：lsNotebooks/createDocWithMd/appendBlock/
                    setBlockAttrs/querySql/forwardProxy（思源耦合，fetchPost）
  siyuanGateway.ts  写入网关：ensureSourceDoc / appendHighlight / loadSyncedIndex
  httpProxy.ts      HttpRequest 实现，底层走 forwardProxy（思源耦合）
  ── 以下为可单测纯逻辑 ──
  apiClient.ts      【原样复用】fetchFeedPage + AuthError/RateLimitError/FeedRequestError
  connection.ts     【原样复用】connectionId(serverUrl, token) cyrb53 哈希
  scheduler.ts      【原样复用】定时轮询（interval）
  renderer.ts       【重写】高亮 → 思源 Markdown（列表项 + IAL 属性/嵌套 note/#标签#）；
                    Obsidian 版依赖 frontmatter/YAML/^blockId/sourceHref，与思源无一复用
  syncEngine.ts     【改造】游标增量 drain 循环，按 source 分组，防跨账号，可中止。
                    与 Obsidian 版差异（非原样搬）：
                      - PluginState 去掉 sourceIndex（§9 思源即真相）
                      - 新增 loadSyncedIndex 依赖，drain 前先拉 SQL 索引
                      - writeSource 签名改为携带 sourceDocMap + syncedHlIds(Set)
  types.ts          DTO + Settings + State（State 仅 {lastCursor, connectionId}）
```

**脚手架清理**（当前是思源官方 `plugin-sample` 原样拷贝）：
- 删除 kernel 构建：`webpack.kernel.config.js`、`src/kernel.ts`、package `dev:kernel`/`build:kernel`、gitignore 的 `kernel.js`。
- 删除模板遗留：`docs/superpowers/plans/2026-05-09-kernel-plugin-demo.md`、`docs/superpowers/specs/2026-05-09-kernel-plugin-demo-design.md`。
- `plugin.json` 改身份：`name: "siyuan-note-sync"`（与仓库名一致，bazaar 要求）、`displayName: { default:"Acorny Sync", "zh-CN":"Acorny 高亮同步" }`、`backends:["all"]`、`frontends` 保留 desktop/mobile 等前端、`disabledInPublish:true`、`author/url` 更新为 acornyio。
- **i18n 文件名**：沿用脚手架现有的 `src/i18n/en.json` 与 `src/i18n/zh-CN.json`（**连字符**，与 `plugin.json` 一致），**直接改这两个文件**，不要新建 `zh_CN.json`（下划线）——否则会两份并存且中文 key 不被加载。
- **tsconfig**：现有 `tsconfig.json` `target:es6` 且无 `lib` 字段，默认 lib 为 ES2015，代码里的 `Object.entries` 等 ES2017 API 会让 `tsc --noEmit` 报 TS2550。清理时给 `compilerOptions` 补 `"lib": ["ES2019", "DOM"]`（思源运行在 Electron/Chromium，运行时无碍）。

---

## 4. 数据流

```
手动/启动/定时 触发
      ↓
SyncEngine.sync()
  1. snapshot 连接：{serverUrl, token} → connectionId
  2. loadState() → {lastCursor, connectionId}；连接不同则弃用 cursor（防跨账号串数据）
  3. gateway.loadSyncedIndex()：一次 SQL 查全库已同步索引
       sourceDocMap:  custom-acorny-source-id → docId
       syncedHlIds:   custom-acorny-id 集合
  4. drain 循环：fetchPage(cursor) → groupBySource → 每组 writeSource(...)
       cursor = page.nextCursor；done 则停
  5. 未中止则 saveState({lastCursor, connectionId})
```

`writeSource(source, highlights, index)`：
1. `docId = sourceDocMap[source.id]`；无 → `ensureSourceDoc(source)`：
   - **建于干净 path** `/<docFolderPath>/<sanitizedTitle>`（无后缀）。`createDocWithMd` 实测**非** hpath 幂等，同名不同 source 各自独立成文档；复用靠 SQL source-id，不靠 path 唯一（见 §5）。
   - `setBlockAttrs(docId, {custom-acorny-source-id: source.id})`，写入 sourceDocMap。
   - 优化（可选）：新建文档时对该 source 的当页高亮，直接把带 IAL 的完整 markdown 交给 `createDocWithMd` 一次落地，避免「建空文档 + N 次 append」的 N+1 往返（一本大书数百高亮尤其明显）。落地后这些高亮 id 已随 IAL 写入，同样计入 syncedHlIds。
2. 对每条高亮（未走上面批量优化的）：`syncedHlIds.has(id)` → **跳过**；否则 **一次** `appendBlock(docId, renderHighlightItem(h))`，`data` 内联 IAL `{: custom-acorny-id="<h.id>"}` 使块与去重属性**原子落地** → 加入 syncedHlIds，`added++`。不再单独调 `setBlockAttrs`（消除 append 与 setAttr 之间的崩溃窗口，见 §5）。

---

## 5. 思源原生去重与编辑保护（核心差异点）

思源是块数据库，用**块自定义属性 + SQL 查询**替代 Obsidian 的 `^block-id` 文本标记，更可靠。

- **来源锚定**：文档根块 `custom-acorny-source-id = <sourceId>`。以此 SQL 查找复用文档，**与标题/位置解耦**——用户改文档名、移动文档都不影响匹配。
- **高亮去重**：每个高亮块 `custom-acorny-id = <highlightId>`。同步前一次 SQL 拉全量索引：
  ```sql
  SELECT block_id, value FROM attributes WHERE name = 'custom-acorny-source-id';
  SELECT block_id, value FROM attributes WHERE name = 'custom-acorny-id';
  ```
- **原子写去重属性**：高亮块与其 `custom-acorny-id` 必须**一次 API 调用**落地（`appendBlock` 的 markdown 内联 IAL）。若拆成 `appendBlock` + `setBlockAttrs` 两步，两步之间失败会留下**无属性的孤块**——下次同步的 SQL 快照看不到它 → 重复追加。IAL 内联关闭这个窗口。
- **文档标题干净、复用靠 source-id**：实测 `createDocWithMd` **非** hpath 幂等（同 path 每次新建文档，思源允许同名，见 notes）。故文档用**干净标题** `/<folder>/<sanitizedTitle>`、**不加后缀**。同一 source 的复用只靠 SQL 查 `custom-acorny-source-id`（与标题/位置解耦）；两个同名但不同 source 各自独立成文档，不串数据。（旧设计的 source-id 后缀基于"同 path 幂等会覆盖属性"的**错误假设**，已移除，见 §11。）
- **编辑保护**：已存在的高亮块**永不改动/追加**。用户对已同步块及文档的编辑完整保留。
- **思源即真相 + 单实例串行幂等**：「已同步什么」由思源块属性决定，插件本地状态只存 `{lastCursor, connectionId}`。去重在**单实例串行**下成立（`SyncEngine` 有 `running` 单飞门）。**注意**：块属性无唯一约束，两个桌面窗口/两台设备**同时**同步理论上可能各写一份重复块——v1 明确只承诺单实例串行幂等，不承诺跨实例/跨设备并发天然一致（二期可加跨实例写入协调）。
- **目标笔记本语义**：`loadSyncedIndex` 的 SQL **全库**查询（不按 `blocks.box` 收窄），这是「用户手动移动文档不影响匹配」的必要前提。由此，「目标笔记本」设置的含义是**新建 source 文档的落点**；已同步过的 source 会继续贴着它现有的那篇文档（无论现在在哪个笔记本），改设置不会把旧 source 迁到新笔记本。这是刻意取舍，需在设置说明里讲清楚。

---

## 6. HTTP 传输（forwardProxy 适配器）

`httpProxy.ts` 实现 Obsidian 版同款 `HttpRequest` 接口，底层走思源 `forwardProxy`，全平台绕 CORS：

```ts
type HttpResponse = { status: number; json: unknown; headers: Record<string,string> }

// 映射：
//   请求 headers {Authorization:"Token ..."} → forwardProxy headers:[{Authorization:"Token ..."}]
//   响应 data.status → status；JSON.parse(data.body) → json；data.headers → headers
```

Acorny 的 401/429 由 `data.status` 透传（kernel 层 `code:0`），交给 `apiClient` 统一转 `AuthError`/`RateLimitError`。

> **实现待固化**：`data.headers` 的键大小写（`apiClient` 同时读 `retry-after`/`Retry-After`，httpProxy 应统一小写化）与 `data.body` 编码（是否 base64 / responseEncoding）以真实 forwardProxy 响应为准，固化进最小回归测试（见 §11）。

---

## 7. v1 行为取舍

| 取舍 | v1 行为 | 理由 / 二期 |
|---|---|---|
| 更新策略 | **仅追加、不回改**：Acorny 端改了 note/quote 不回写已同步块 | 彻底避免覆盖用户编辑；与 Obsidian v1 一致。二期按 `updatedAt` 增量更新 |
| 删除追踪 | **不追踪单块删除**：删个别同步块后，因增量游标不回头，下次增量同步不会重新追加该块（除非它在 Acorny 侧更新）。**但整库清空会自愈**：若本地有游标却查不到任何 `custom-acorny-id`（文档全删/换库），`SyncEngine` 自动弃用游标做全量重建。想找回**部分**删除的块，用命令「重新完整同步」强制全量。 | 平衡「删了别老回来」与「删光了要能重建」；二期用 tombstone 做精确删除追踪 |
| note 渲染 | 高亮为列表项块；有 note 时嵌套子项 `note: ...` | 对齐 Obsidian |
| tags | 附在高亮末尾为思源 `#标签#` | 思源标签语法 |
| 发布模式 | `disabledInPublish:true` | `query/sql` 在发布模式被禁 |

---

## 8. 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `serverUrl` | `https://api.acorny.io` | Acorny 服务地址 |
| `exportToken` | — | `acornyexp_...` 导出令牌（敏感，密码框） |
| `notebookId` | — | 从 `lsNotebooks` 下拉选目标笔记本。**语义 = 新建 source 文档的落点**；已同步 source 继续贴其现有文档，改此项不迁移旧文档（见 §5 目标笔记本语义） |
| `docFolderPath` | `/Acorny` | 文档所在 hpath 文件夹（同上，仅影响新建 source） |
| `syncOnStartup` | `true` | 插件加载时自动同步一次 |
| `pollIntervalMinutes` | `60` | 定时轮询分钟数，0=禁用（默认每小时一次） |

触发方式：手动（顶栏图标含同步中旋转动效 + 命令面板「立即同步」，弹「同步中…/新增 N 条」）、启动时、定时轮询。另有命令「重新完整同步」（重置游标全量重建，带确认弹窗）。

---

## 9. 状态与存储

- 插件状态 `{ lastCursor, connectionId }`：思源 `plugin.saveData/loadData`。
- `connectionId = cyrb53(serverUrl + '\n' + token)`：连接变化则弃用 cursor，防止一个账号的游标被另一个账号重放导致漏数据。
- 设置项同样经 `saveData` 持久化。

---

## 10. 测试策略

- **纯逻辑单测（vitest，新增 devDependency）**：`apiClient`（401/429/游标）、`connection`、`renderer`（quote/note/tags/转义）、`syncEngine`（用 fake gateway 覆盖分组/幂等/中止/跨账号丢弃）。
- **思源耦合层**：`siyuanClient`/`siyuanGateway`/`index`/`settings` 无法 headless，靠真实思源桌面端 QA（建文档、追加块、属性回填、重复同步幂等、令牌错误反馈）。
- 边界覆盖：空 feed、单页/多页、同一 source 跨页、标题含非法字符（sanitize path）、**两个不同 source 同名（path 去重后不串数据）**、note 为 null、tags 为空、429 退避、令牌失效。
- 幂等/原子：**append 后、attr 前中断的重跑不产生重复块**（IAL 原子写下天然满足；用 fake gateway 断言单条高亮只落一个块，且携带 `custom-acorny-id`）。

---

## 11. 已知风险 / 待验证

- **[必须先做] kernel 契约真机 spike（前置）**：整个去重模型押注「列表 markdown 末尾 IAL 落到高亮块」，此前提在实现 renderer/gateway **之前**就要用真实思源 kernel 验证，避免押错后返工。spike 需固化的 fixture：①`appendBlock` 内联 IAL 后，`custom-acorny-id` 落在哪个块（list / list-item）、有嵌套 note 时是否仍生效；②`appendBlock` 返回的新块 id 路径（`data[0].doOperations[0].id`）；③`createDocWithMd` 返回值形状（是否直接是 docId 字符串）；④`forwardProxy` 响应 `data.{status,body,headers}` 的真实形状（body 是否 base64、headers 键大小写）。对应实现计划 **Task 0**。
- `forwardProxy` 对 Acorny 非 2xx 是否稳定透传 `data.status`，以及 `data.headers` 键大小写、`data.body` 编码（设计假设成立，实现时以真实响应固化最小回归测试）。
- `appendBlock` 内联 IAL 是否被 kernel 正确解析为块自定义属性（`{: custom-acorny-id="..."}`）——这是原子去重的前提，实现时以真实响应验证并固化回归测试；若 kernel 不支持内联 IAL，退回 append+setBlockAttrs 并显式接受重复窗口（需在 §5/§7 记录降级）。
- ~~不同 source 同名 hpath 冲突串数据~~ **已实测解除**：`createDocWithMd` 非 hpath 幂等、思源允许同名文档，同名不同 source 各自独立成文档（见 notes）。故用干净标题、无后缀。
- **自愈的异步索引竞态 —— 已修**：自愈（游标在 SQL 索引为空时弃用）若直接触发，会与 `attributes` 表 ~1.5s 异步索引撞车——刚同步完就再同步一次时，索引尚空**不是**因为清库、而是因为滞后，自愈会误弃游标 + 因索引仍空无法去重 → **整库重复重建**。已修：自愈前先 `sleep(2s)` 再查一次，真清空才弃游标，滞后则用补齐后的索引、保留游标走正常增量（`syncEngine.ts` `SELF_HEAL_SETTLE_MS`，含 lagged/真清空两个回归测试）。
- **残留风险（二期修）**：手动「重新完整同步」在插件层直接把游标置 null（绕过上面的 settle），若紧接在一次同步后触发，仍可能因索引滞后建**重复文档**。属显式用户操作、窗口窄；二期加 session 内存缓存 source→doc 彻底消除（本期评估：缓存会引入"缓存了被用户删掉的 docId → append 到不存在父块"及干扰自愈判空的新风险，故延后）。
- **source 锚定非原子（二期修）**：`createDocWithMd` 成功但 `setBlockAttrs(custom-acorny-source-id)` 失败时，留下无 SQL 锚定的孤儿文档，下次同步会再建一篇。已缓解：建文档后**先把 docId 记进内存索引**再写属性（同一 run 不重复建）；跨 run 孤儿罕见，二期加"识别并修复未锚定文档"的恢复逻辑。
- **卸载中止粒度**：`SyncEngine` 在每页 fetch、每个 source 分组前查 `isAborted`；网关 `writeSource` 在**每条高亮 append 前**也查，卸载后不再发起下一次写请求（在途请求会自然结束）。
- `createDocWithMd` 同 path 不覆盖的语义与我们「先 SQL 查 source-id 再决定建不建」是否有竞态（单机顺序执行，风险低）。
- 移动端 `forwardProxy` / `fetchPost` 可用性需真机 QA。
- bazaar 上架要求（`plugin.json` 字段、icon 160×160、preview 1024×768、README 双语）留发布阶段处理。

---

## 12. 变更文件一览（实现阶段）

| 文件 | 变更 |
|---|---|
| `src/index.ts` | 重写为同步插件主体（**含设置面板**/命令/调度/接线；不拆独立 settings.ts） |
| `src/{siyuanClient,siyuanGateway,httpProxy}.ts` | 新增（思源耦合） |
| `src/{apiClient,connection,scheduler,types}.ts` | 新增（apiClient/connection/scheduler 原样复用，types 新写） |
| `src/{renderer,syncEngine}.ts` | 新增（renderer 重写、syncEngine 改造，非原样搬，见 §3） |
| `src/kernel.ts`, `webpack.kernel.config.js` | 删除 |
| `plugin.json` | 改插件身份 |
| `package.json` | 去 kernel script、加 vitest + test script |
| `docs/superpowers/**/2026-05-09-kernel-plugin-demo*` | 删除模板遗留 |
| `src/i18n/{en,zh-CN}.json` | 替换为本插件文案 |
