# 模块：Agent

> 状态：**Current truth**。总纲见[总体设计](00-overview.md)，交互规则见[交互设计](01-interaction.md) §6.2、§6.5。

## 1. 三个不同的东西

| 概念 | 是什么 | 不是什么 |
| --- | --- | --- |
| **外部 Agent 接入** | Codex、Claude Code、OpenCode、WorkBuddy 等通过 Skill + CLI（或 MCP 投影）调用 Iris | 第二套业务实现 |
| **Agent surface** | 顶栏 Agent 连接与状态中心：runtime、模型 / Provider 路由、外部 Agent（Codex、Claude Code、DSH）的发现、准备、健康、每个 Agent 的状态与切换；向 Canvas / Cut 的 Agent 工作流供应模型与连接 | 对话、run 编辑、Tasks / Artifacts 工作区 |
| **Canvas Assistant Drawer（内置 Agent）** | 实际对话、创作上下文、调用受控工具与审核的当前入口；未来 Spatial Context v1 在此落地（[11](11-iris.md)） | 独立的 Personal Agent 顶栏、第二份 Workflow、跨 Harness 会话库 |
| **Cut（当前视频剪辑器）** | 复用 `cutStore` 的编辑时间线与 `iris_cut_*` 工具、支持 UI/Agent 撤销 | 未来独立 Agent、Resolve 工程的复制品 |

三者不复制彼此的 UI、会话、Host picker 或状态。

## 2. 稳定操作面

- 日常：`status`、`workflow.inspect`、`workflow.selection.get`、`workflow.apply`、`workflow.node.run`。
- 委派：`agent.turn` —— 外部 Agent 让内置 Assistant 跑一轮，默认只读、只回摘要（文本 + 工具清单 + draftVersion），同一 mutationId 幂等、一次只跑一轮。
- 连接准备与诊断：`ensure`、`doctor`。
- 生成与素材（宿主路径）：任务提交、`task.get`、`artifact.locate` 等，只有实现、schema、验证齐备后才写进 Skill。
- 命令注册表 `tools/iris/registry.js` 是唯一来源；文档里出现的命令必须在注册表中（`npm run docs:check` 校验）。

命名：产品与 CLI 统一使用 Iris / `iris`（2026-11-20 由 Flovart 更名）。历史宣传片中的 `iris layer.*` 是 2026-10 前旧代号的概念示意，不是可执行命令；以当前 CLI contract 为准。

## 3. Transport

| Transport | 角色 |
| --- | --- |
| CLI + Skill | 默认外部路径（`skills/iris/` 为 canonical，`.agents/`、`.claude/` 为投影快照，不得手改漂移） |
| stdio MCP | 同一 operation contract 的可选投影（`tools/iris/mcp-server.js`） |
| 内置 Assistant | 同一业务能力的 UI 入口 |
| 宿主 native MCP（Resolve 21.1） | 宿主操作由 Blackmagic 官方 MCP 完成，Iris 不复制 |

Transport 只做参数解码、权限上下文与结果编码；不做 MCP → CLI 子进程转发。

内置 Assistant 的内核由 `BrowserAgentRuntime` 按项目持有（`services/browserAgentRuntime.ts`）；面板只是生命周期所有者与订阅者，不再直接构造内核。后续若让外部 Agent 通过命令面委派一轮内置对话，入口必须是这个运行时，而不是 React state。

内置 Assistant（浏览器内核）的 harness：
- **技能按需读取**：系统提示词只带技能索引（`.agents/skills/*` 的 name + description，排除给外部 CLI 用的 `iris`、`open-iris`，它们仍可按 id 读取）；任务命中技能时模型调用内核自带的只读工具 `iris_skill_read` 读 SKILL.md 或 `references/`、`commands/` 下的文件（分页、拒绝越界、会话内去重）。Production Skill 面板里的手动绑定表示「强制使用」：首轮完整读取一次 SKILL.md，不截断。本机 Agent 服务对应接口 `GET /api/skills/:id/file?path=`。
- **上下文压缩**：用 pi-agent-core 内置压缩；发送前估算超过阈值（窗口减 max(15%, 16384) 预留）先压缩，请求因上下文溢出失败时压缩后重试一次（拒答、限流不重试）；会话菜单可手动「压缩上下文」。压缩只影响发给模型的上下文，面板历史、技能已读列表、项目记忆保留。
- **项目记忆**：内核自带工具 `iris_memory`（add / list / search / delete），按 Iris 项目隔离、存本机 localforage、每项目最多 100 条（满了淘汰最旧），写入前脱敏密钥 / Token / 密码；摘要注入系统提示词，会话菜单可查看与删除。
- 这三个工具只属于内置内核（原任务清单工具已于 2026-11-20 移除，`flovart_todo` 仅为弃用的无操作别名），不进 `tools/iris/agent-tools.js` 的外部工具面。

## 4. 权威与安全

- 修改绑定明确 project / revision；重试使用稳定幂等 ID；未知提交先查询。
- Agent 工具权限 ≠ Provider 费用授权；已确认范围内不重复询问，范围变化重新确认。
- 工具调用先过策略层：沙箱 `read-only` / `workspace-write` / `danger-full-access` 决定能不能写，审批 `never` / `on-request` / `untrusted` 决定要不要问；删除与付费执行始终确认，策略层不重复弹命令面已经发起的确认。手动模式 = `untrusted`，自动模式 = `on-request`。
- Skill、日志、连接状态、项目数据不携带 Provider 原始 Key。
- 外部 Agent 不直接写 React store、localStorage schema 或 Runtime 私有数据库。
- 一个 Agent 连接失败不阻塞其他 transport。
- Workspace Lease 有 TTL、续期、过期与接管（见交互设计 §4.3）。

## 5. 宿主中的 Agent（Resolve 首发）

Skill 教 Agent 组合 **Resolve native MCP（宿主状态）+ Iris CLI（生成与素材）**。面板只显示 Agent 活动条与待确认项；对话留在 Agent 自己的界面。

## 6. 状态语义（面向用户）

已准备 / 需安装 / 需登录 / 离线 / 异常，每个配一个动作。内部 Writer、Projection、URL、Token、协议版本只在高级诊断。

## 6.1 多步制作 / Spatial Context（目标与进展）

Canvas、Cut、Drawer 和外部 Agent 通过真实命令操作共享的素材和工程，并引用相同 Runtime Run/Artifact。工具已分阶段实现，真实支持等级以 `SUPPORT_MATRIX.md` 为准；视频流水线早期方案已移至 [历史归档](../archive/2026-11-24-agentos-alignment/16-agent-video-pipeline.md)。

Spatial Context v1 只补结构化 Turn Context（真实消息 ID/素材版本）及独立的 Context Card；后续 Creative Proposal 在 Canvas/Cut 的现有操作边界构造可审核的目标、Diff 和执行回执。内置 Agent 不额外获得 Shell 或宿主全局写权限；具体参阅 [11](11-iris.md)。

## 7. 不采用

只有聊天的整页；Production Crew / Director / Operator 强制分层；Host 专属 Workflow store；连接中心与 drawer 同时维护 Host picker；跨 Agent 登录态 / 记忆无损迁移。

## 8. 验证

每个 Agent 单独验证：安装 / 发现、登录态、inspect、mutation、node.run、断线恢复、错项目保护、费用与取消。支持等级只看 Support Matrix。
