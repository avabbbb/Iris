# 2026-11-24 · 文档整理归档（docs refresh）

> 历史快照，只读。只解释“当时为什么”，不能推翻 [docs/index.md](../../index.md) 列出的 current truth。文件内的相对链接已按新位置修正。

本批把**问题已修复、结论已并入现行文档**的单轮质量记录与更名前的开发日志移出 active tree。仍列有未分诊问题的现场记录（`2026-11-16-agent-reliability`、`-builtin-agent-sim`、`-meeting-room-field-test`）留在 [docs/quality/](../../quality/)，问题进 [todo.mdx](../../content/docs/progress/todo.mdx) 后再归档。

| 原文（原位置） | 是什么 | 归档原因 | 现行结论所在 |
| --- | --- | --- | --- |
| [quality/2026-11-15-basic-function-eval.md](quality/2026-11-15-basic-function-eval.md)（`docs/quality/`） | 外部 Agent 只经 `iris` CLI 驱动可见 Workflow 的一轮评测（真实 RunningHub），含 trace、定位与修复 | 问题同日修复，“仍未修复”一节写明无代码遗留 | 评测方法 [eval/eval.md](../../../eval/eval.md)；样本口径 [eval/judge/rubrics/agent-run.md](../../../eval/judge/rubrics/agent-run.md) |
| [quality/2026-11-15-dsh-connection-ui.md](quality/2026-11-15-dsh-connection-ui.md)（`docs/quality/`） | DSH ↔ 本机 Agent 链接错误分类、状态卡死与连接面板弹性布局的排障记录 | 修复与验证已完成 | [DSH 工作台计划](../../plans/dsh-workbench.md) §1、[12 Agent](../../design/12-agent.md) |
| [quality/2026-11-16-batch-alternates.md](quality/2026-11-16-batch-alternates.md)（`docs/quality/`） | 多结果改为“首图节点 + 备选”、拖走批次后原位残留的根因与修复 | 已实现并有回归测试（`tests/workflowNodeExit.test.tsx`） | [01 交互设计](../../design/01-interaction.md) 多结果一节、[10 Canvas / Workflow](../../design/10-canvas-workflow.md) |
| [quality/2026-11-16-eval-judge.md](quality/2026-11-16-eval-judge.md)（`docs/quality/`） | eval.md 落地、执行成功率四段、LLM-as-a-Judge 层的建设记录 | 一次性建设日志；“还差什么”已由 eval.md §13 承接 | [eval/eval.md](../../../eval/eval.md) |
| [blog/2026-11-03-extension-web-canvas-bridge.md](blog/2026-11-03-extension-web-canvas-bridge.md)（`docs/blog/`） | 更名前的开发日志：浏览器插件与网页画布的配对、导入、密钥同步与插件内反推 | Flovart 时期一次性日志，`docs/blog/` 无其他内容 | [15 Web, Community & Extension](../../design/15-web-community-extension.md)、[extension/README.md](../../../extension/README.md) |
