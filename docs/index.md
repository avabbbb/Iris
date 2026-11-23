# Iris 文档地图

四类：**current truth**（当前产品与系统的唯一依据）→ **提案 / 计划**（未接受或进行中）→ **指南与记录**（使用、进度、质量记录）→ **归档**（只读历史）。支持等级只看 [SUPPORT_MATRIX](../SUPPORT_MATRIX.md)；AI / 自动化开发约束见 [AGENTS.md](../AGENTS.md)。

产品地图：**Iris** 是开源、本地优先的无限画布 AgentOS（2026-11-20 由 Flovart 更名）。顶栏三个入口 **画布 Canvas｜Cut｜Agent**：Canvas 是无限画布、生成节点与 Workflow；Cut 是已实现的浏览器内视频剪辑器（内部视图 id 仍为 `reverse`）；Agent 是 Runtime / Provider / 外部 Harness / Skill 的连接与状态中心。内置 Agent 对话在 Canvas 右侧的 Assistant Drawer，不是第四个顶栏。详见 [00](design/00-overview.md) §3。

## 1. Current truth（`docs/design/`，上限 12 份，见 AGENTS.md §9）

| 文档 | 内容 |
| --- | --- |
| [00 总体设计](design/00-overview.md) | 一句话定位、三个 surface 与状态权威、设计原则、关键决策（含历史 ADR 摘要）、状态归属、路线图 P0–P5、对外口径、术语、品牌兼容标识 |
| [01 交互设计](design/01-interaction.md) | 交互与行为：三条总规则、状态模型、核心流程、产品地图、当前 Canvas / Cut / Drawer 交互、Spatial Context v1、Proposal / 审片、宿主上下文目标、run / trace、参考先行、交互模式；[可点击原型](design/prototypes/index.html)（原型仍是改名前版本） |
| [DESIGN.md](design/DESIGN.md) | 视觉与动效系统（取自 `styles/`、`components/`）：颜色、字体、间距、圆角、层级与玻璃、组件、奶蛙、Canvas / Cut / Agent 布局、动效、弹性布局 |
| [10 Canvas / Workflow](design/10-canvas-workflow.md) | 可见生产图、mutation、素材语义、分镜 / 锚点 / 拼接等制作机制 |
| [11 Cut 与 Iris Creative AgentOS](design/11-iris.md) | 现有架构（Canvas / Cut / Agent / Drawer / Runtime）与标注清楚的路线：Spatial Context、Creative Proposal、Resolve、Skill Distillation |
| [12 Agent](design/12-agent.md) | Skill + CLI、MCP 投影、Agent 连接与状态中心、内置 Agent、安全边界 |
| [13 Generation & Runtime](design/13-generation-runtime.md) | 一条生成路径、Provider 路由、任务与计划卡、素材版本、流式与媒体用量 |
| [14 Creative Hosts](design/14-creative-hosts.md) | 宿主优先级（Resolve 首发）、Resolve 产品流程、原生效果（AE / PR / PS / OFX）、当前源码与缺口、宿主上下文连接器（设计目标） |
| [15 Web, Community & Extension](design/15-web-community-extension.md) | 网站后端（现为全静态 + 无状态 Worker）、社区、浏览器导入扩展、安装与发行 |
| [20 质量与治理](design/20-quality-and-governance.md) | 证据分级、评测、文档结构与规则 |
| [references.md](design/references.md) | 设计参考登记：哪个部件借了哪件外部作品 |

[16 Agent 视频流水线](design/16-agent-video-pipeline.md) 已是归档存根（代码注释仍引用该路径），全文见 [archive/2026-11-24-agentos-alignment](archive/2026-11-24-agentos-alignment/16-agent-video-pipeline.md)。

架构决策：[ADR · Cut 视频编辑器引擎](adr/cut-editor.md)（Mediabunny + OpenCut classic UX，2026-11-20 accepted）。

实现附录（在代码目录内）：[Resolve 21.1 Product & UI Spec](../integrations/studio/resolve/PRODUCT_UI_SPEC.md)、[Studio host packages](../integrations/studio/README.md) 与各宿主 `*_REAL_HOST_CHECKLIST.md`、[Workflow CLI](../skills/iris/commands/workflow.md)、[数据存储](content/docs/backend/backend-database.mdx)、[DSH 插件](../dsh-plugin/README.md)、[浏览器扩展](../extension/README.md)。

## 2. 提案与进行中的计划（不是 current truth）

| 文档 | 状态 | 内容 |
| --- | --- | --- |
| [多模态 AIGC 评测平台](plans/aigc-eval-platform.md) | 进行中（M0 已在 `eval/aigc/`） | L4 题库、生成 / 评分 Schema、客观轨 grader、结果库；口径以 [eval.md](../eval/eval.md) §4.1 为准 |
| [DSH 工作台](plans/dsh-workbench.md) | 进行中（`dsh-plugin/` 可用，独立仓库 / 市场未开始） | Iris 作为 DeepSeek Harness 工作台，DSH Agent 通过工具操作画布 |
| [真实操作录制与剪辑 Hub](plans/recordly-capture-hub.md) | 草案，未实现 | Recordly 连接器 → Rust 录制 + 截图伴生工具 → 视频制作 Hub；许可证边界（Recordly AGPL） |

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

评测与质量记录：
- [评测体系总说明 eval.md](../eval/eval.md)：五层评测对象、规则 / LLM-as-a-Judge / 实验三层方法、Rubric、归因、上线治理；规则层跑法见 [eval/README](../eval/README.md)
- [真实 API 验收步骤](quality/real-api-acceptance.md)：导入 → 计划卡 → 提交 → 查询 → 保存 → 播放 → 导出 → 刷新重读
- 仍含未分诊问题的现场记录（问题进 todo 后归档）：
  - [2026-11-16 Agent 可靠性](quality/2026-11-16-agent-reliability.md)：流式、重试、插话、中止、按节点 rebase；“未完成 / 后续”一节
  - [2026-11-16 内置 Agent 模拟用户实测](quality/2026-11-16-builtin-agent-sim.md)：只经内置 Agent 面板操作的四个场景与问题分级
  - [2026-11-16 会议室现场评测](quality/2026-11-16-meeting-room-field-test.md)：托管站从配 Key 到出图的现场记录与问题清单

法律：[隐私政策](PRIVACY_POLICY.md) / [中文](PRIVACY_POLICY.zh-CN.md)、[服务条款](TERMS_OF_SERVICE.md) / [中文](TERMS_OF_SERVICE.zh-CN.md)、[安全策略](../SECURITY.md)。

## 4. 归档（只读）

[归档索引 archive/README.md](archive/README.md) 逐份列出每个归档文档是什么、为什么归档、被什么取代。按批次：

- [2026-11-24 文档整理](archive/2026-11-24-docs-refresh/)：已修复的 11-15 / 11-16 质量记录、更名前的插件开发日志。
- [2026-11-24 AgentOS 定位对齐](archive/2026-11-24-agentos-alignment/)：旧 11-iris（Personal Agent tab）、旧 01 交互全文、16 视频流水线能力矩阵。
- [2026-11-17 Iris 定位](archive/2026-11-17-iris/)：README 草稿、远景三条产品线。
- [2026-11-16 评测文档蒸馏](archive/2026-11-16-eval-distill/)：11-11、11-12 两份 Agent / 工具链迭代记录。
- [2026-11-13 设计语言与文档树清理](archive/2026-11-13-design-refresh/)：30 / 31 / 32 号设计、LibTV 对标、计划卡设计稿、0.3.0 内测清单等。
- [2026-10-19](archive/2026-10-19/)：Beta 评估。
- [2026-10-07 重构归档](archive/2026-10-07/)：旧主设计、ADR、开发契约、品牌迁移、维护资料、RC 证据。

历史文档、旧报告与 Git 历史只解释“当时为什么”，不能推翻上面的 current truth。
