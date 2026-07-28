# 思源 kernel 契约 spike 结论（Task 0）

> ⚠️ **仅存档。** 这是 2026-07-23 首次 spike 的原始记录，后续实测推翻/补充了其中若干条
> （尤其是 `getBlockAttrs` 的存在性语义、`attributes` 表的延迟量级）。
> **以 [`../../SIYUAN_KERNEL_CONTRACT.md`](../../SIYUAN_KERNEL_CONTRACT.md) 为准。**

**Date:** 2026-07-23
**环境:** SiYuan/kernel **3.7.2**（`/api/system/version`），Windows。`minAppVersion` 保持 `3.7.0`（3.7.0–3.7.2 区间未逐一验证，但版本接近，风险低）。
**方法:** 从外部对本机 kernel `http://127.0.0.1:6806` 发 HTTP（带 API token，仅 spike 用；插件运行时用 `fetchSyncPost` 会话鉴权，不需要 token）。草稿文档已清理。
**真实响应已冻结:** `src/__fixtures__/kernel/{createDocWithMd,appendBlock,querySql,forwardProxy}.json`。

## 关键结论

1. **内联 IAL 生效，且落在 `NodeList` 块上。** `appendBlock` 的 `data` 为 `* text\n{: custom-acorny-id="X"}` 时，`custom-acorny-id` 属性写在外层 `data-type="NodeList"` 块上；`data[0].doOperations[0].id` 返回的正是该 NodeList 块 id。带嵌套 note（`* q\n  * note: ...\n{: ...}`）时同样：一个 NodeList 承载 id，note 作为其内部子列表。**每条高亮 = 一个带 `custom-acorny-id` 的 list 块**，符合去重设计。renderer/gateway **无需改**。

2. **`attributes` 表是异步索引（约 1.5s）。** `appendBlock` 内联 IAL 后立即 `SELECT ... FROM attributes` 返回 `[]`；约 +1.5s 后 `custom-acorny-id`（来自 IAL）与 `custom-acorny-check`（来自 `setBlockAttrs`）都出现在表中。`getBlockAttrs`（非 SQL）则立即可见。
   - **影响:** `loadSyncedIndex` 在同步**开始**时查（查的是历史早已索引的属性），且单次 drain 内去重用内存 `syncedHlIds` Set，故延迟无害。
   - **残留风险（已接受，v1 记录）:** 两次同步间隔 < ~1.5s 时，第二次 `loadSyncedIndex` 可能漏看第一次刚写的属性 → 理论上重复追加。`syncing` 单飞门挡住并发；自动同步以分钟计；仅"手动在上次完成后 1.5s 内再点一次"可触发，概率低。

3. **`createDocWithMd` 返回值直接是 docId 字符串**（`data: "2026...-nsoyq1z"`）。与 siyuanClient 假设一致。

4. **`appendBlock` 新块 id 路径 = `data[0].doOperations[0].id`**，与 `extractAppendedBlockId` 一致。

5. **🔴 forwardProxy `headers` 是数组值**：`{"Content-Type":["text/html"],"Date":["..."]}`（`Record<string,string[]>`），非 string。`data.body` 为字符串、`bodyEncoding:"text"`（非 base64）。
   - **已修:** `httpProxy.ts` 的 `normalizeHeaders` 小写化键 + 取数组首值扁平为 `Record<string,string>`，保证 apiClient 读 `retry-after` 拿到字符串。

6. **`createDocWithMd` 非 hpath 幂等（推翻旧假设）**：同一 hpath `/spike3/Same Title Doc` 连建两次得到**两个不同 docId**，`getIDsByHPath` 返回两条，两文档 content 同为标题。思源**允许同名文档**。
   - **影响:** 当初为"防同名 source 串进一篇/覆盖 source-id 属性"加的 path 后缀（Codex #1/#4）**前提不成立、已移除**——`docPath` 用干净标题。同一 source 复用只靠 SQL 查 `custom-acorny-source-id`（我们从不对同一 source 二次 `createDocWithMd`）；两个同名不同 source 各自独立成文档，不串数据。
   - **残留风险（升级记录）:** 结合结论 2 的 ~1.5s 异步索引——若在上次同步刚建完某 source 的文档后 <1.5s 内再次手动同步，第二次 `loadSyncedIndex` 可能漏看该 source 的 source-id → 又 `createDocWithMd` 建**重复文档**（比重复块更重）。`syncing` 单飞门挡并发、自动同步分钟级，仅"手动秒级连点"可触发。二期可加插件 session 内存缓存 source→doc 消除。
