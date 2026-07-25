# Changelog

## v0.1.0

- 初版 Acorny → 思源笔记 高亮同步插件。
- 单向增量同步（游标分页）；一个 source 对应一篇文档。
- 思源原生去重：块自定义属性（`custom-acorny-source-id` / `custom-acorny-id`）+ SQL 查询；编辑保护；原子 IAL 写入。
- 触发：顶栏图标、命令面板、启动时、定时轮询。
- v1 限制：仅追加不回改、不追踪删除、单实例串行幂等、发布模式禁用。
