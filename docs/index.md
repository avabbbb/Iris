# Iris 文档地图

四类：**current truth**（当前产品与系统的唯一依据）→ **提案**（未接受）→ **指南与记录**（使用、进度、开发日志）→ **归档**（只读历史）。支持等级只看 [SUPPORT_MATRIX](../SUPPORT_MATRIX.md)；AI / 自动化开发约束见 [AGENTS.md](../AGENTS.md)。

产品地图：顶栏 **Canvas｜Cut｜Agent**。Canvas 负责无限画布、素材、生成与审片；**Cut 已是视频剪辑器**；Agent 负责模型/运行时/外部 Harness 连接。内置 Agent 的对话和 Spatial Context 通过现有 Canvas Assistant Drawer 展开。长期产品定位是 Agent-native Creative Production Workspace / OS，见 [00](design/00-overview.md) 与 [11](design/11-iris.md)。

## 1. Current truth（`docs/design/`；以 00、01、DESIGN 与模块文档为准）

| 文档 | 内容 |
| --- | --- |
| [00 总体设计](design/00-overview.md) | 产品一句话、三个 surface 与交接、原则、关键决策、状态归属、路线图、对外口径、术语 |
| [01 交互设计](design/01-interaction.md) | 交互与行为：三条总规则、状态模型、核心流程、产品地图、当前 Canvas/Cut/Drawer 交互、Spatial Context v1、Proposal/审片、宿主上下文目标、Canvas 交互、run / trace、参考先行、交互模式、参考表；[可点击原型](design/prototypes/index.html) |
| [DESIGN.md](design/DESIGN.md) | 视觉与动效 token（Refero 式分层）：mood、颜色、字体、按钮、图标、间距、层级与玻璃、圆角、组件、底层逻辑、Do & Don't、动效（三档弹簧） |
| [10 Canvas / Workflow](design/10-canvas-workflow.md) | 可见生产图、mutation、素材语义、分镜 / 锚点 / 拼接等制作机制 |
| [11 Cut / Creative AgentOS](design/11-iris.md) | Cut 已有视频编辑器、Drawer 统一 Agent 入口、Spatial Context、Creative Proposal、可选宿主与 Skill Distillation |
| [12 Agent](design/12-agent.md) | Skill + CLI、MCP 投影、Agent 连接与状态中心、内置 Agent 的放置、安全边界 |
| [13 Generation & Runtime](design/13-generation-runtime.md) | 一条生成路径、Provider 路由、任务与计划卡、素材版本、流式与媒体用量 |
| [14 Creative Hosts](design/14-creative-hosts.md) | Resolve 首发、叠加层、上轨道、原生效果；Iris 宿主上下文连接器（Resolve → Premiere → 剪映 / CapCut） |
| [15 Web, Community & Extension](design/15-web-community-extension.md) | 网站后端、社区、浏览器导入、发行 |
| [20 质量与治理](design/20-quality-and-governance.md) | 证据分级、评测、文档结构与规则 |

实现附录（在代码目录内）：[Resolve 21.1 Product & UI Spec](../integrations/studio/resolve/PRODUCT_UI_SPEC.md)、[Studio host packages](../integrations/studio/README.md) 与各宿主 `*_REAL_HOST_CHECKLIST.md`、[Workflow CLI](../skills/iris/commands/workflow.md)、[数据存储](content/docs/backend/backend-database.mdx)。

## 2. 提案（PROPOSAL / 进行中的计划，不是 current truth）

| 文档 | 内容 |
| --- | --- |
| [16 旧流水线提案迁移说明](design/16-agent-video-pipeline.md) | 历史流水线提案的迁移说明；原文已归档，实际能力以源码和 Support Matrix 为准 |
| [真实操作录制与剪辑 Hub 计划](plans/recordly-capture-hub.md) | Recordly 连接器 → Rust 录制 + Snipaste 式截图伴生工具 → 视频制作 Hub；录制截图为本体、反推 / 发送到画布 / Agent 为可插拔模块；许可证边界（Recordly AGPL）与分期 H0–H3（草案） |
| [多模态 AIGC 评测平台计划](plans/aigc-eval-platform.md) | 在 `eval/` 内补 L4 题库：条目 / 生成 / 评分 Schema、场景 × 能力 × 难度 × dev/test/holdout、客观轨 grader 与稳定性撤回、可用 / 满意 / 惊喜率、结果库与静态看板、「设为首图」偏好事件（M0 已实现，口径以 eval.md §4.1 为准） |
| [DSH 工作台计划](plans/dsh-workbench.md) | Iris 作为 DeepSeek Harness 工作台、DSH Agent 通过工具操作画布（进行中：主仓库 dsh-plugin 已可用，独立仓库 / 市场未开始） |

## 3. 指南与记录

使用指南：
- [快速开始](overview/quick-start.md) / [Getting Started](overview/quick-start.en.md)
- [Windows 安装](overview/installation.zh-CN.md)
- [Agent Skill 使用](overview/skill-guide.md)
- [新用户操作手册](overview/user-manual.zh-CN.md)

进度（对外页面）：
- [当前功能](content/docs/overview/features.mdx) / [Features](content/docs/overview/features.en.mdx)
- [后续待办](content/docs/progress/todo.mdx)
- [待测试确认](content/docs/progress/pending-test.mdx)

质量与开发日志：
- [评测体系总说明 eval.md](../eval/eval.md)：五层评测对象、规则 / LLM-as-a-Judge / 实验三层方法、六层漏斗 Rubric、Auto Rubrics、四步归因、三阶段上线治理；规则层跑法见 [eval/README](../eval/README.md)
- [真实 API 验收步骤](quality/real-api-acceptance.md)：导入 → 计划卡 → 提交 → 查询 → 保存 → 播放 → 导出 → 刷新重读
- [2026-11-16 Agent 可靠性](quality/2026-11-16-agent-reliability.md)：中止文案、流式 start、卡住检测与重试、系统提示词、DeepSeek 缓存计数、运行中插话、按节点 rebase、`--title` 简写、无文本线路凭据卡；mock / real 前后基准
- [2026-11-16 会议室现场评测](quality/2026-11-16-meeting-room-field-test.md)：网页端从配 Key 到出图的完整现场记录与问题清单
- [2026-11-16 评测体系与 LLM-as-a-Judge](quality/2026-11-16-eval-judge.md)：eval.md 落地、执行成功率四段、Judge 层、`node.run --wait-seconds`、DSH / Skill 清理
- [2026-11-16 多结果改为首图节点 + 备选](quality/2026-11-16-batch-alternates.md)：拖走批次后原位残留（退出动画继承无限循环）的根因与修复、旧叠放批次迁移、斜叠卡片 / 网格 / 画廊
- [2026-11-15 DSH 链接错误与连接面板 UI](quality/2026-11-15-dsh-connection-ui.md)：链接错误分类、状态卡死、连接指引 / 状态 / 运行日志弹性布局
- [2026-11-15 基础功能评测](quality/2026-11-15-basic-function-eval.md)：Agent 经 CLI 驱动画布，trace、定位与修复记录
- [2026-11-03 浏览器插件 × 网页画布](blog/2026-11-03-extension-web-canvas-bridge.md)

法律：[隐私政策](PRIVACY_POLICY.md) / [中文](PRIVACY_POLICY.zh-CN.md)、[服务条款](TERMS_OF_SERVICE.md) / [中文](TERMS_OF_SERVICE.zh-CN.md)。

## 4. 归档（只读）

- [2026-11-24 AgentOS 定位清理](archive/2026-11-24-agentos-alignment/)：归档旧 Iris 个人 Agent tab、旧交互稿和视频流水线阶段提案，更新实际 Cut 与 Spatial Context/Proposal 的文档权威。

- [2026-11-17 Iris 定位](archive/2026-11-17-iris/)：README 草稿（2026-11-03）、远景三条产品线（线 B / C 并入 Iris，蒸馏进 00 / 11-iris / 14）。逐份原因见该目录 README。
- [2026-11-16 评测文档蒸馏](archive/2026-11-16-eval-distill/)：2026-11-11、11-12 两份 Agent / 工具链迭代记录；评测方法并入 eval/eval.md，遗留项并入 todo。
- [2026-11-13 设计语言与文档树清理](archive/2026-11-13-design-refresh/)：原 30 竞品机制复刻、31 Notion 式紧凑 UI、32 流式用量（蒸馏进 10 / DESIGN.md / 13）；LibTV 对标两份、计划卡设计稿（已实施）、0.3.0 内测清单、DSH 表单文案、沉浸式翻译调研、面试演示场景。逐份原因见该目录 README。
- [2026-10-19](archive/2026-10-19/)：Beta 评估。
- [2026-10-07 重构归档](archive/2026-10-07/)：旧主设计、ADR、开发契约、品牌迁移、维护资料、RC 证据。
- [更早的归档](archive/)

历史文档、旧报告与 Git 历史只解释“当时为什么”，不能推翻上面的 current truth。
