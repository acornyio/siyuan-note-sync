[English](./README.md)

# Acorny 高亮同步（思源笔记）

将 [Acorny](https://acorny.io) 的高亮**单向、增量、非破坏性**地同步进思源笔记。

一个 Acorny source（文章/书）对应一篇思源文档，每条高亮是一个列表块。重复运行同步是幂等的；你对已同步块和文档的手动编辑会被完整保留。

## 功能

- **单向对账同步**：每次同步都读取完整的 Acorny 高亮 feed,让思源与之对齐——新高亮会新增,你在思源里删掉的会被重建。
- **思源原生去重**：用块自定义属性（文档根块 `custom-acorny-source-id`、高亮块 `custom-acorny-id`）+ SQL 查询,替代脆弱的文本标记。移动或重命名文档都不影响匹配,已同步的高亮会被跳过（不重复）。
- **编辑保护**：已同步的高亮块永不改动、不重复追加。
- **原子写入**：高亮块与其去重属性通过一次 `appendBlock`（内联 IAL）落地，同步中断也不会留下无属性的孤块。
- **触发方式**：顶栏图标、命令面板、启动时、可选定时轮询。

## 安装

1. 在思源集市安装 **Acorny Sync**（设置 → 集市 → 插件），或从源码构建：`pnpm install && pnpm build`（产出 `dist/` 与 `package.zip`）。
2. 启用插件。
3. 打开插件设置并填写：
   - **服务地址**（默认 `https://api.acorny.io`）
   - **导出令牌**（`acornyexp_...`，来自 Acorny 账号）
   - **目标笔记本**（下拉选择）
   - **文档文件夹**（hpath，默认 `/Acorny`）
   - **启动时同步** / **自动同步间隔（分钟）**

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| 服务地址 | `https://api.acorny.io` | Acorny API 基址 |
| 导出令牌 | — | `acornyexp_...`（本地存储，密码框） |
| 目标笔记本 | — | **仅决定新建 source 文档的落点。** 已同步 source 会继续贴着它现有的文档（无论现在在哪个笔记本），改此项不迁移旧文档。 |
| 文档文件夹 | `/Acorny` | 新建 source 文档所在 hpath 文件夹 |
| 启动时同步 | `true` | 插件加载时同步一次 |
| 自动同步间隔 | `60` | 自动同步的分钟数；`0` 表示关闭 |

## v1 限制

- **编辑仅追加**：Acorny 端改了 note/quote 不会回写到已同步块。(但你在思源里的删除会在下次同步时重建——见「功能」。)
- **全量 feed 对账**:每次同步读取完整 feed,而非从游标续拉。这正是删除能自愈的原因,代价是每次都重读整个 feed;对个人高亮库很廉价(去重会跳过已存在的块)。
- **单实例串行幂等**：去重在单个运行实例内成立；两个窗口/设备**同时**同步不保证不产生重复（块属性无唯一约束）。
- 发布模式下插件被禁用（`disabledInPublish: true`），因为依赖 `query/sql`。

## 隐私与安全

- **单向、非破坏性**:插件只从 Acorny 读取、向思源写入,绝不把你的笔记回传给 Acorny。
- **导出令牌明文存在本地**:保存在本插件的思源数据(`data.json`)中,为明文——与所有思源插件一样(内核未提供安全存储 API)。能访问你 workspace 文件的人即可读到它。请像对待密码一样对待它,泄露后到 Acorny 账号吊销重置。
- **令牌只发往你配置的服务地址**,作为 `Authorization` 头,经思源内核的网络代理发送。请保留默认的 `https://` 端点;若配成 `http://`,令牌将以明文传输。
- **不涉及第三方**:插件只与你的 Acorny 服务器和本地思源内核通信,不含任何遥测或分析。

## 开发

```bash
pnpm install
pnpm dev            # watch 构建
pnpm test           # vitest（纯逻辑单测）
pnpm typecheck      # tsc，仅对 src/ 报错（容忍 siyuan SDK 已知类型问题）
pnpm lint:check     # eslint，不自动修复
pnpm build          # 生产构建 + package.zip
```

架构：纯逻辑（`types`/`apiClient`/`docPath`/`renderer`/`scheduler`/`syncEngine`）不依赖 siyuan、可单测；思源耦合集中在 `siyuanClient`/`httpProxy`/`siyuanGateway`/`index`。
