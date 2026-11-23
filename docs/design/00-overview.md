# Iris 总体设计

> 状态：**Current truth**（2026-11-24 更新产品定位、Surface 和路线）。本文是产品与系统的唯一总纲；各模块细节见同目录模块文档，交互规则见[交互设计](01-interaction.md)。
> 标注约定：**已实现** = 代码在主干；**已验证** = 有 Support Matrix 证据；**设计目标** = 尚未实现；**假设** = 待真实环境确认。


## 1. 一句话

**Iris — Agent-native Creative Production Workspace / OS.** 开源、local-first、BYOK，让创作者与可插拔 Personal Agent 共同理解素材和工程，在同一套可编辑工作流中规划、制作、审片、局部修正与交付。

长期目标是让个人借助 Agent 获得过去需要小型制作团队的能力。这是**愿景，不是当前已验证的能力或效率指标**。Iris 的职责是专业创作上下文、受控操作、非破坏性提案、可追溯任务与可复用 Skill；它不重造通用云电脑、模型推理引擎或专业剪辑软件。

核心循环：**读取授权工程上下文 → 提案 / Diff → 人审核 → 安全执行 → 真实 Artifact/Run/版本 → 局部返工 → 经确认的 Skill**。其中部分已实现，未验证能力按 [Support Matrix](../../SUPPORT_MATRIX.md) 标注。

“Your footage. Plus one layer.” 保留为专业宿主叠加层的场景标语，不替代整个产品定位。

## 2. 用户与首个闭环

面向独立视频创作者、小型制作团队和已经使用 Codex/Claude Code 等 Coding Agent 的剪辑师。首批重点场景是参考素材逆向、真实 UI 产品宣传片、从已有编辑工程中精确修改局部镜头。

第一轮目标：在 Canvas 多选真实素材、给 Assistant 提问 → 保存结构化引用并钉下创作结论 → Cut/Canvas 审查产物 → 指定秒数或帧范围修改 → 留下可回放的 Run 和 Artifact。之后才验证 Resolve 真实工程上下文与安全导入，最后将成功流程抽成 Skill 候选。

商业化仍属探索：本地开源 + BYOK 优先；未来可按托管任务/云渲染、团队审片、宿主集成和 Skill/Blueprint 服务定价。没有发布的 Cloud、Marketplace、企业版不得被写成现状。

## 3. 当前三个 Surface 及状态权威

| 入口 | 已有职责 | 边界 |
| --- | --- | --- |
| **Canvas** | 无限画布、生成节点、素材/版本、Workflow；后续承载独立 Context Card | Browser Workflow 是图的权威，`workflow.apply` 带 projectId/revision/mutationId |
| **Cut** | **已实现的视频剪辑器**：轨道、字幕、属性、剪辑、代理、预览和导出；Agent 工具共用 Cut Store | `cutStore` 是 Cut 的权威；不是尚未上线的 Personal Agent |
| **Agent** | Agent/Provider/Runtime/Skill 连接、健康和状态 | 不存第二份对话或 Workflow |
| **Assistant Drawer**（非顶栏） | 内置对话、明确素材引用、工具调用和审核入口 | 借用 Canvas/Cut/Runtime 的真实操作，不建立第四个工作区 |

模型和 Harness 可插拔（Codex/Claude Code/DSH/内置）；外部 Agent 保有自己的会话。Iris 的 Canvas、Cut、Runtime 和 Resolve 工程各自保留单一权威，通过稳定引用和受控操作协作。现状与目标见 [11 Cut / Creative AgentOS](11-iris.md)、交互见 [01](01-interaction.md)，视觉见 [DESIGN.md](DESIGN.md)。

## 4. 设计原则

1. **原素材不被破坏**：默认新增结果（候选 → Media Pool → 新轨道）；替换必须显式确认、可恢复。
2. **一条生成路径**：面板、CLI、MCP、Canvas 调同一个任务函数；transport 只做参数与结果转换。
3. **单一权威**：每类状态只有一个保存者（见 §6）；其他入口只存引用。
4. **短路径**：只有出现第二个真实复用、独立状态所有权或进程 / 凭据边界时才拆模块；不建只转发的 Manager / Facade / Gateway。
5. **能力驱动、不硬编码**：工具、模型、候选数量、宿主能力、文案全部来自注册表 / 能力发现 / 配置，UI 按 schema 渲染（规则见交互设计 §3）。
6. **永不死锁**：任何状态都有出口，任何等待都可取消或超时，任何锁都会过期（规则见交互设计 §4）。
7. **真实状态优先**：动画不能掩盖失败、未知提交或 Provider 无响应。
8. **宿主原生感**：宿主里的 Iris 是一个窄而克制的 contextual inspector，不是聊天页、后台或缩小版 Canvas。
9. **连接器可选**：Iris 不依赖任何宿主；宿主连接器只读起步、按需同步上下文，没有连接器时不阻塞。

## 5. 关键决策（保留自历史 ADR）

| 决策 | 内容 | 来源 |
| --- | --- | --- |
| 第一宿主 | DaVinci Resolve Studio 21.1；Agent 宿主操作用 Blackmagic native MCP；不做第二套 Resolve MCP | 用户 2026-09-25 |
| 首个输出形态 | **叠加层（Layer）优先**：带 Alpha、与源片段对齐；整段“新版本”保留为第二种输出 | 用户 2026-10-07；**假设**：所选 Provider 能产出可用 Alpha |
| 写入分级 | P0 导入 Media Pool；P1 上新轨道；P2 Replace / Commit | 风险分级 |
| 本地优先 | 个人任务与素材由本机管理；网站后端不做生成中转 | ADR 0002 |
| 稳定素材 | Artifact 用稳定 ID + 校验和；临时 URL / Blob / base64 不是长期素材 | ADR 0010 |
| 共用任务实现 | 所有入口调同一任务函数；提交不明先查询 | ADR 0023 / 0069 |
| Schema 驱动路由 | 模型能力由 Route Capability Schema 描述，PromptBar 与 Preflight 用同一 schema | ADR 0027 |
| Contract-first 投影 | CLI / MCP / Native SDK 是同一 operation contract 的投影 | ADR 0070 |
| Workflow 修改 | 必带 projectId + expectedRevision + mutationId；幂等 | ADR 0065 |
| 费用授权 | 执行代码校验费用；Agent 工具权限 ≠ 费用授权 | ADR 0068 |
| 本地文件夹 | 显式授权目录用引用语义，不复制字节 | ADR 0071 |
| 浏览器扩展 | 桌面权威的受限导入桥，分块 + 内容寻址 | ADR 0060 |
| 平台 | Windows 优先；macOS 后续单独验证 | 用户确认 |

旧 ADR 原文见 [archive/2026-10-07/adr](../archive/2026-10-07/adr/)。

## 6. 状态归属

| 数据 | 唯一保存者 | 其他入口保存什么 |
| --- | --- | --- |
| 图层、轨道、效果参数、关键帧、撤销 | 宿主工程（Resolve / AE / PR / PS） | 目标引用与必要上下文；Iris 连接器只读同步，不另存一份工程 |
| 生成输入、任务状态、Provider 任务 ID、结果版本 | 本地生成服务 | taskId、进度、结果引用 |
| 已生成媒体 | 持久素材目录（内容寻址） | 素材 ID、相对路径、校验和 |
| Workflow 图 | Browser Workflow（当前权威） | 引用；修改走 mutation |
| 逆向工程（Script、证据、对齐、变体） | 既有逆向拆解工具（`useReverseStore`） | 子画布节点上的 reverseProjectId 与镜头 key |
| run / trace / 评审轮次 | 本地 Runtime（以实际已实现命令为准） | Canvas/Cut/会话只存 runId / version 引用 |
| Agent 会话 | 内置 BrowserAgentRuntime 或各外部 Harness | 非秘密会话/消息引用，不另建统一 Session 库 |
| Provider Key | 本机安全存储 | 永不进入宿主工程、Skill、日志、素材元数据 |

## 7. 系统主路径

~~~text
生成：宿主面板 / Canvas / CLI / MCP → 同一任务函数 → Provider 适配 → 持久素材版本 → 宿主 / Workflow / Iris 消费
渲染：宿主效果 → 读取固定素材版本 → 混合 → 输出当前帧（不联网、不等待模型、不依赖 Agent 在线）
~~~


## 8. 路线图（能力与证据门槛）

| 阶段 | 改动 | 必须观察到的证据 |
| --- | --- | --- |
| P0 · Turn Context | 结构化消息 ↔ 素材引用和内容指纹持久化，标记实际送达媒体 | 刷新、节点改名/删除/移动后准确，不夸大视频理解范围 |
| P1 · Context Card | 用户 Commit 后创建独立 `plugin:context-card`；来源高亮、继续讨论 | 可编辑、可撤销、可续接；默认无常驻 Context 连线 |
| P2 · Creative Proposal | 在 Cut/Canvas 展示修改范围、Diff、费用、审批、冲突检测 | 只改指定片段/帧段，其他已锁定内容不变 |
| P3 · Resolve Read | 通过真机探测的官方 API / MCP 读取工程和选定片段 | 明确可读与未知的效果/调色参数，不虚称完整私有上下文 |
| P4 · Resolve Write | 候选生成后先导入 Media Pool，再验证新轨道/时间线分支 | 保存并重开后媒体在线，原工程不变，未知结果不重复写入 |
| P5 · Skill Distillation | 从已确认的真实工程和 Run 提炼方法与统计指纹 | 有来源、人工确认、在新素材上重放通过 |

前两项仅在现有 Drawer + Canvas 内完成，不依赖 Resolve。先复用 `tools/iris/pipeline/`、`src-tauri/src/runtime/`、`services/cut/`，不另写一套任务编排。旧版视频流水线能力矩阵见 [历史提案](../archive/2026-11-24-agentos-alignment/16-agent-video-pipeline.md)。

## 9. 对外口径

当前已经有 Canvas、Cut、内置 Assistant、CLI/Skill 与部分多媒体 pipeline/Runtime。Resolve、AE、Premiere、Photoshop 的深层读取和工程写回仍需真实宿主认证；只有 [Support Matrix](../../SUPPORT_MATRIX.md) 能升级发布支持等级。禁止把设计目标、假设、Mock 或编译通过写成生产验证。

## 10. 术语

| 术语 | 定义 |
| --- | --- |
| Iris | 整个产品，不是旧“个人 Agent tab” |
| Canvas / Cut / Agent | 真实顶栏三入口；**Cut 是剪辑器** |
| Assistant Drawer | 现有内置 Agent 对话与受控操作入口 |
| Context Binding | 经真实消息 ID 保存的明确素材引用，不是从聊天正文猜测的节点列表 |
| Context Card | 用户 Commit 的创作结论，独立节点插件；不复用 `text` 备注 |
| Creative Proposal | 目标、范围、输入快照、版本前置条件、Diff、风险和审批记录 |
| Skill Distillation | 从已有作品与成功 Run 提炼候选规则，经用户确认和回放验证 |
| Artifact / Run | 稳定的产物与执行记录，独立于 UI 布局、会话文本 |
| Creative Host | Resolve/AE/PR 等用户实际使用的专业软件；只有探测验证后开放对应能力 |

## 11. 品牌与兼容标识

对外产品名统一用 **Iris**（2026-11-20 由 Flovart 更名，标签 `flovart-final` 是更名前最后一版）。顶栏为 画布 Canvas｜Cut｜Agent；本文与其他设计文档中把第二个 surface 称作 “Iris” 的段落写于更名前，指的是现在的 Cut。兼容：`flovart_*` 工具名是 `iris_*` 的弃用别名；`FLOVART_*` / `VITE_FLOVART_*` 环境变量作为回退；浏览器存储与 `~/.flovart` 首次启动复制到新名字且不删旧数据；`flovart.avabbbb.com` 过渡期仍受信。线上协议 / 持久化格式标识（`flovart:` 模型 id 与事件、`flovart.*/N` schema 标签、`flovart.skill.yaml`、`x-flovart-*`、`data-flovart-*`、`__FLOVART_*__`、`com.flovart.*`、`flovart://`、npm `@flovart/*`）暂时保留，改它们是独立迁移。
