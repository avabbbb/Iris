# 模块：Cut 与 Iris Creative AgentOS

> **Current truth + explicitly labeled roadmap**（2026-11-24）。此前将第二个 tab 定义为「Iris Personal Agent / 逆向工作台」的方案已归档：[原稿](../archive/2026-11-24-agentos-alignment/11-iris.md)。实现与认证范围见 [SUPPORT_MATRIX](../../SUPPORT_MATRIX.md)。总纲见 [00](00-overview.md)，交互见 [01](01-interaction.md)。

## 1. 北极星

Iris 是开源、本地优先、模型无关的 **Agent-native Creative Production Workspace / OS**。人保留创作意图、审美判断与最终编辑权；Personal Agent 利用工具、代码、多模态模型和专业宿主做繁琐工作。核心不是“一句话生成最终 MP4”，而是理解已有工程、审查修改范围、输出可编辑版本、精确返工，之后复用经过验证的创作方法。

面向的体验是 **Creative Context → Proposal → Review → Execute → Artifact / Trace → Skill**。阶段性实现不得写成产品已上线能力；目标与实测必须区分。

## 2. 当前架构（已经存在）

**Canvas**：Browser Workflow 是图、节点、媒体、生成候选和连线的权威；`workflow.inspect`、`workflow.apply` 等是 Agent 的统一修改面。Canvas 与外部 Agent 操作同一份真实可见状态。

**Cut**：顶栏第二入口目前是**实际的视频剪辑器**，代码在 `components/cut/` 与 `services/cut/`，有素材箱、时间线、字幕、基础属性、预览、代理与导出。UI 与 `iris_cut_*` Agent Tools 经 `cutStore` 的同一批操作修改工程、撤销和重做。Cut 页面未打开，headless store 仍可处理不需要交互播放器的编辑。不要把 Cut 称作“即将实现的 Personal Agent”。

**Agent**：顶栏连接和状态管理中心，管理 Provider、Runtime、Skill 和外部 Harness。它不持有第二套对话界面或创作工程。

**Canvas Assistant Drawer**：当前内置 Agent 的对话、引用、工具调用、审批与结果入口；后续的空间化上下文与提案先在这里落地。外部 Codex/Claude Code/DSH 保持各自会话，Iris 只引用可访问的会话/操作/产物，不同步复制其历史。

**Runtime**：持久任务、Provider 结果、Run/Trace 与 Artifact；已有生产流水线用 `tools/iris/pipeline/`、Rust Runtime 和既有命令，不另建第二套调度。

## 3. Spatial Context v1（下一轮 P0 + P1）

P0：复用现有 `@`、Chip、画布多选、图片预览和会话分支。**发送消息时**由真实持久化会话 ID / 消息 ID 绑定本轮显式来源，记录稳定 node/asset ID、内容指纹（不包含 x/y 坐标变化）、当时实际送进模型的媒体范围。发送文本中的「引用上下文」不是可靠的结构化权威；旧消息只兼容读取。

P1：用户在助手回复上点「钉到画布」，可审查标题、正文和引用 Chip，明确 **Commit** 后创建独立 Node Plugin `plugin:context-card`，不复用备注 `text` 节点。卡片是创作决策，不是聊天消息副本；不自动更新正文或批量增添未选择的来源。Context 关联默认隐藏，选择/悬停才高亮；Workflow 执行连线继续常驻。

**讨论用实时授权来源，执行自动冻结素材版本和目标。** 删除卡片不删除会话，删除会话不删除卡片。原会话可访问时“继续讨论”打开它；外部/丢失会话则以定稿内容 + 有效来源开启新会话，不假定跨 Harness 原生 Fork。相同消息重复 Commit 必须幂等。卡片的来源变化仅比较内容版本，不能因拖动画布误报。

## 4. Creative Proposal / 电影后期审片（后续）

Agent 先 inspect 目标与版本，提出受控范围的操作列表（片段、轨道、帧段、待修改字段）。UI 展示预览、对比 Diff、模型费用、风险与确认；执行前重查目标/版本，写入由 Workflow Executor、Cut Store 或真实宿主官方 API 完成，最后验证结果、保留回执。

优先只改用户指出的第 14–18 秒，不重拍其余已通过镜头。现有 Cut 的 `iris_cut_edit` 支持一批动作原子提交并形成撤销历史，可作为首个 Proposal 执行后端；但 Cut Undo 不等于跨宿主的全局事务。未知提交必须查询，不允许凭猜测重试昂贵任务。

## 5. 专业宿主（Resolve 优先，Experimental）

专业宿主是**可选**上下文连接器。读取项目、时间线、选择、素材及已明确暴露的 Inspector/Fusion/Color 信息时，按当前真实 API 能力发现；不能预设所有 Magic Mask、OFX、调色轮、节点参数都可读。不得通过未经核实的 .drp / .drx / 活动 Project.db 解析能力宣称完整工程理解，更不得直接改写宿主私有数据库。

写回分级：只读探测 → 可编辑的 Iris 候选 → 用户审查 → Media Pool 导入 → 确认能力后新轨道/时间线分支 → 最后才考虑显式 Replace。任何写入都固定原工程、时间线、片段、目标版本，不能采用“当前选择”作为执行时的隐式目标。关闭重开仍在线、帧率对齐和原素材不变是验收条件。见 [Resolve real-host checklist](../../integrations/studio/RESOLVE_REAL_HOST_CHECKLIST.md)。

## 6. 历史工程 → Editing Skill（Project Archaeology，目标）

从**用户授权**的若干成熟工程中提取可以直接量化的数据：切镜时长分布、轨道结构、字幕/音频配置、节拍对齐、导出的可用模板和稳定素材引用。视频语义理解按需抽帧给模型，模型推断的审美偏好不得当作数据事实。

延伸现有 `services/canvasSkillRecipe.ts` 与 Skill Registry：产出 `SKILL.md`（什么时候使用、步骤、约束）和可选 `fingerprint.json`（统计、样本数、来源、适用范围）；可携带用户许可的相对路径资产引用。经过人工确认、脱敏和新素材的 Dry Run / E2E 回放验证后才登记为可复用 Skill。不要把私有素材、绝对路径、登录凭据或用户未经确认的偏好打包进去。

## 7. 首批验收与非目标

- P0/P1：发送三个素材 → 真实 Turn Context 持久化 → 钉卡片 → 刷新 / 改名 / 位置变化 → 引用高亮与继续讨论。
- Proposal：只修改指定时间片段，其余已批准内容保持不变，冲突时拒绝旧提案。
- Resolve：真实连接、只读读取、持久结果 → Media Pool，保存重开验证；之前只标 Experimental。
- Skill：从有证据的工程提炼候选，在新素材上复跑且由用户决定采用。

不新建第四个顶栏、第二个 Canvas、统一多 Agent 会话数据库、全量自动导入上下文、通用云 VM 或“大而全”的模型节点编排器。产品、证据和实现状态以 [00](00-overview.md) 与 [SUPPORT_MATRIX](../../SUPPORT_MATRIX.md) 为准。
