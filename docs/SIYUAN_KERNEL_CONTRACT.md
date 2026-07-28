# 思源内核契约速查（踩坑清单）

**最后实测:** 2026-07-28，SiYuan kernel **3.7.3**，Windows
**复验方式:** `npx tsx scripts/kernel-e2e-probe.mts <token>` 与 `scripts/kernel-crossnotebook-probe.mts <token>`（需本机思源运行）

> **改本插件的同步 / 去重 / 迁移逻辑之前，请先读完这一页。**
>
> 下面每一条都不是文档抄来的，而是真机实测、且**至少有一条是我们先按直觉写错、线上出事后才测出来的**。
> v1.1.0 之前的全部事故（最严重的一次把 446 篇文档放大成 6850 篇）都能追溯到这张表里的某一行。
>
> 完整的缺陷复盘见 [`features/SYNC_ENGINE_LOGIC.md`](./features/SYNC_ENGINE_LOGIC.md)。

---

## 1. `/api/query/sql` 无显式 `LIMIT` 时静默截断到 64 行

| | |
|---|---|
| **你可能以为** | 返回全部匹配行；行多了会报错或有截断标记 |
| **实际** | 只返回 **64** 行，`code: 0`，**不报错、不给任何标记**，返回值看起来就是一份完整结果 |
| **实测** | `SELECT id FROM blocks` → 64 行；`SELECT id FROM blocks LIMIT 100000` → 100000 行（库中共 103754 块） |
| **代价** | 已同步索引只认得 446 个 source 里的 64 个，其余每轮同步都被判成「没同步过」→ 重新建档 → **6850 篇重复文档、16409 个重复高亮块** |
| **代码里的约定** | 凡结果集大小不可控的查询**必须显式写 `LIMIT`，并检查 `rows.length >= LIMIT` 视为结果不完整而中止**。见 `siyuanGateway.loadSyncedIndex`（`SEED_ROW_LIMIT`）、`folderMigration.findDocsOutsideFolder`（`LOCATION_SCAN_LIMIT`） |

**这是本项目最贵的一课**：静默的残缺结果比报错危险得多——报错你会去修，残缺结果会被下游当成事实。

## 2. `getBlockAttrs` **不能**用来判断块是否存在

| | |
|---|---|
| **你可能以为** | 块被删除后返回空对象 `{}` |
| **实际** | 已删除文档**仍长期返回完整属性**（实测删除后 +0s / +0.5s / +3s 全都返回原属性） |
| **代价** | 把已删文档当成还在 → 往它 `appendBlock` → 内核报 `parent block not found` → 整轮同步中断并退避 60 秒 |
| **正确做法** | 用 `getBlockKramdown`（见下） |

该方法**已从 `SiyuanClient` 接口移除**，避免再被误用。

## 3. `getBlockKramdown` 是唯一可靠的存在性判据

| 场景 | 返回 |
|---|---|
| 文档已删除 / id 不存在 | **空串**，删除后**立即**生效 |
| 文档存在但没有任何内容 | **非空**——仍含文档根块 IAL |
| 文档有内容 | 非空 |

两者可区分，所以「空串 ⟺ 不存在」成立。而且 kramdown 里带各子块的内联 IAL，**一次读取即可同时拿到：存在性 + 锚定归属 + 已同步高亮集合**（见 `siyuanGateway.readDocOf`）。

## 4. `attributes` SQL 表有 1–2 秒索引延迟，`getIDsByHPath` 零延迟

| 时刻 | `attributes` SQL | `getIDsByHPath` |
|---|---|---|
| 建档后 +415ms | **0 行** | **已返回文档 id** |
| +962ms | **0 行** | 已返回 |
| +2013ms | 1 行 | 已返回 |

删除方向同理：文档删除后 `attributes` 表还会返回该行约 3 秒。

**代价**：只靠 SQL 查找时，「刚建完文档」的那 1–2 秒窗口里若 `docMap` 恰好为空（data.json 丢失 / 刚重载），会重复建档。
**对策**：查找按 `docMap → getIDsByHPath（零延迟）→ SQL 点查（覆盖改名/移动）` 三级下降，且每个候选都过 `readDocOf` 校验。

## 5. `createDocWithMd` **不是** hpath 幂等

同一 hpath 连建两次会得到**两篇独立的同名文档**（思源允许同名）。所以**路径不能当唯一键**——建档前必须先确认该 source 没有文档。按路径查只用来**找候选**，命中后一律用锚定属性校验。

## 6. `getHPathByID` 返回的是**笔记本内**相对路径

不同笔记本里的同名文件夹，hpath 完全一样。判断「文档在不在目标位置」**必须笔记本 + hpath 一起比**（笔记本 id 取 `getBlockInfo.box`）。

只比 hpath 会把「旧笔记本的 `/Acorny`」误判成「已经在目标 `/Acorny` 里」→ 换笔记本形同无效。

## 7. `moveDocsByID` 不改变文档 id

跨笔记本移动后 **id 不变**，锚定属性、高亮块、反链、块引全部保留（真机 9/9 验证）。所以迁移对 `docMap` 与去重是安全的。

## 8. `appendBlock` 的内联 IAL 落在 `NodeList` 块上

`data` 为 `* text\n{: custom-acorny-id="X"}` 时，属性写在外层 `data-type="NodeList"` 块上；新块 id 在 `data[0].doOperations[0].id`。
**每条高亮 = 一个带 `custom-acorny-id` 的 list 块**，块与属性一次事务落地，规避「块写成了但属性没写成」的崩溃窗口。

## 9. `forwardProxy` 的 `headers` 是**数组值**

`{"Content-Type":["text/html"]}`（`Record<string, string[]>`），不是 string。`data.body` 是字符串、`bodyEncoding: "text"`（非 base64）。
`httpProxy.normalizeHeaders` 负责小写化键 + 取数组首值扁平化，否则 `retry-after` 读不出来。

超时默认给 **30s**：真机在走本地代理时出现过 TLS 握手都来不及完成（`net/http: TLS handshake timeout`）。

## 10. 卸载插件**不会**删除插件数据

插件目录在 `data/plugins/<name>`，而 `saveData` 的数据在 `data/storage/petal/<name>/`。**集市里卸载只删前者**。

所以「删掉重装」**不会**回到初始状态——`inited`、令牌、笔记本、文件夹全都还在。任何依赖「重装 = 全新安装」的设计都是错的；需要重置就得自己提供入口（设置页的「重置初始化」按钮）。

---

## 通用教训（比具体 API 更重要）

### 一、能漂移的状态必须**对账**，不能靠**事件**

同一个错误犯了两次：

- 同步用增量游标 → **永远发现不了本地删除**（那条高亮 `updatedAt` 没变，服务端不会再发）
- 迁移只在「设置变更」时触发一次 → 设置说 A、文档在 B 之后，再点多少次保存都判定「没变化」，**永久对不上**

凡是「配置声明的目标状态」与「实际状态」可能漂移的地方，都必须**每轮实测并纠正**，不能靠事件触发。

### 二、fake 单测**测不出内核行为假设错误**

`getBlockAttrs` 的删除语义、`attributes` 表的索引延迟——这两个假设写进 fake 之后，单测按错误假设建模，**结构上就不可能证伪它**。出事时 129 个单测全绿。

因此保留两个打真实内核的探针（`scripts/kernel-*-probe.mts`）。**改同步 / 去重 / 迁移逻辑后请手动跑一遍。**

### 三、测试要覆盖**真实数据规模**

事故前 50 个单测全绿，但**没有任何一个测试的 source 数超过 3 个**，而出问题的门槛是 64。测试覆盖了逻辑分支，没覆盖数据规模，属于典型的虚假信心。

### 四、`index.ts` 无法单测 → 判定逻辑一律外提

`index.ts` 因 `import 'siyuan'` 不能进 vitest。凡写在里面的分支判断都成了测试盲区，G/H 系列有三条缺陷正是这么漏的。

现在的约定：**任何判定逻辑都抽成纯函数**放进可测模块（`planDestinationChange`、`mayRunSync`、`pickNotebookValue`、`readInitedFlag`、`rememberFolders`、`isTransientFeedError`…），`index.ts` 只做接线。

### 五、会写用户数据的探针必须有**所有权硬隔离**

早期的探针把 `findDocsOutsideFolder` 的**全库扫描结果**直接喂给了迁移，于是把用户 447 篇真实文档搬进临时文件夹，随清理一并删除（后经思源「数据历史」恢复）。

现在探针强制：只在新建的临时笔记本里操作；自建文档 id 进 `owned` 集合；移动与删除**必须先过 `assertOwned`**；全库扫描的结果**只用于断言**，喂给写操作的永远是 `owned` 子集。最近一次实测中，这层过滤把命中的 447 篇收敛到 1 篇。

### 六、失败要**说出原因**

通用异常兜底一度只把原因交给 `onStatus`，而 `index.ts` 里 `onStatus` 是空函数——用户只看到「同步已延后 60s」，得自己去翻控制台才知道是 TLS 超时。**面向用户的失败提示必须携带原因。**
