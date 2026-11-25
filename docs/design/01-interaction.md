# Iris 交互设计

> 状态：**Current truth**（2026-11-13 重构）。本文只管**交互与行为**：状态、流程、出口、谁能做什么、动效在什么时候发生。视觉与动效 token（颜色、字号、圆角、阴影、玻璃、弹簧数值）只在 [DESIGN.md](DESIGN.md)，本文引用不重复。
> 标注约定沿用[总体设计](00-overview.md)：**已实现** = 代码在主干；**设计目标** = 尚未实现；**假设** = 待真实环境确认。§1–§10 编号保持稳定，供其他文档引用。
> **Current truth（2026-11-24）**：§11 为 Canvas/Cut/Agent 当前入口与 Drawer；§12 为 Spatial Context/Creative Review 阶段目标；§16 为共享 Run / Trace。旧版独立 Iris Personal Agent 页面已归档，实际能力等级以 SUPPORT_MATRIX 为准。

## 1. 三条总规则

1. **简单直接**：每个界面只有一个主动作；用户在 3 步内完成最常见任务；高级设置默认折叠。
2. **不硬编码**：界面上出现的选项、能力、数量、文案都来自数据源（§3）。
3. **不死锁**：任何状态都能离开，任何等待都能取消或会超时，任何锁都会过期（§4）。

## 2. 交互原则

| 原则 | 具体要求 |
| --- | --- |
| 当前上下文优先 | 面板打开即显示当前选择（片段 / 节点 / 素材），不让用户先“选择项目” |
| 一个主 CTA | 每个状态只有一个强调按钮；次要动作用文字按钮或菜单 |
| 默认安全 | 默认动作永远不破坏原素材（新增、导入、上新轨道），破坏性动作需二次确认 |
| 先计划后花钱 | 会产生费用、改动多处或影响他人的动作，先显示 Plan（做什么、复用什么、用哪个模型、预计费用），再执行 |
| 真实状态 | 进度、失败、未知提交如实显示；不用假进度、不把 fixture 结果伪装成真生成 |
| 可撤销 | 每个写入都能撤销或有明确的恢复路径；撤销入口与动作在同一位置 |
| 人和 Agent 平等 | 同一动作，人从面板点、Agent 从 CLI 调，效果和权限一致；任何一方的操作对另一方立即可见 |
| 就近反馈 | 反馈出现在被操作的对象旁边（候选卡上、轨道上、节点上），不只弹全局 toast |
| 内容优先于界面 | 画布与素材是主角；浮动 chrome 可收起、不遮挡正在编辑的对象（[DESIGN.md](DESIGN.md) §9） |
| 动效服务于理解 | 动效只表达因果、位置与状态变化；高频交互少动、可被打断、可关闭（[DESIGN.md](DESIGN.md) §14） |
| 过程可见 | Agent 对画布的每次写入都以光标动作可见地发生，并能在 trace 中找到来源（§12.3、§12.5） |

## 3. 不硬编码规则

| 对象 | 数据来源 | 禁止 |
| --- | --- | --- |
| 工具列表（Layer、Draw、Restyle…） | 工具注册表 + 当前宿主能力发现；不可用的工具显示原因或隐藏 | 在组件里写死按钮数组和顺序 |
| 模型 / Provider 选项 | Route Capability Schema 与用户已配置的路由 | 写死模型名、默认 Provider、价格 |
| 候选数量、时长、分辨率等参数 | Schema 中的范围与默认值；用户上次选择可记忆 | 写死 “4 个”“5 秒” |
| 宿主能力（能否上轨道、能否开关轨道） | 运行时探测宿主版本与 API，结果缓存并可刷新 | 用版本号 if/else 猜能力 |
| Output 目标（Media Pool / 新轨道） | 由能力探测结果生成选项；P1 能力未验证时不出现 | 静态下拉选项 |
| 文案与语言 | i18n 资源；错误文案来自错误码映射 | 组件内中英文硬编码 |
| 命令 / 工具的显示名、光标角色名 | 命令注册表元数据（`tools/iris/registry.js`）与 run Step 的 caller | 组件内维护第二份命令名映射（现状见 §19.4 问题 D7） |
| 颜色、圆角、阴影、时长、曲线 | [DESIGN.md](DESIGN.md) 的 CSS 变量与 motion token | 组件内写 hex、`rounded-2xl`、`140ms ease`、自定义 cubic-bezier |
| 尺寸与布局 | 容器宽度驱动（§8） | 固定像素栏宽、按设备型号分支 |
| 端口、路径、Token、协议版本 | 只在高级诊断里显示，来自连接状态 | 出现在普通 UI |
| 快捷键 | 快捷键注册表，可冲突检测，跟随宿主约定 | 写死并覆盖宿主快捷键 |

新增一个工具 / 模型 / 宿主时，只增加注册项和能力声明，不改界面代码。这是验收条件。

## 4. 不死锁规则

### 4.1 每个状态都有出口

每个界面状态必须至少提供一个：**返回 / 取消 / 重试 / 在别处打开（Open in Iris）**。状态表（§5、§16、§19）中出口列不能为空，否则不允许合入。

### 4.2 等待都有上限

| 等待 | 规则 |
| --- | --- |
| 连接宿主 / Agent | 有超时；超时后显示“重试”和“诊断”，不无限转圈 |
| 生成任务 | 可随时取消；UI 关闭不取消任务，重开后从任务状态恢复 |
| Provider 无法取消 | 显示“已请求取消，供应商可能仍计费”，任务进入终态 `canceled`，界面立即解锁 |
| 回执丢失（unknown-after-submit） | 进入“待核实”，后台查询原任务；界面不锁，用户可继续做别的 |
| 用户确认 | 确认请求不阻塞其他目标；超时后自动作废并要求重新计划，而不是一直挂起 |

### 4.3 没有互相等待

- **人和 Agent 不互等**：Agent 发起的付费动作进入“待确认”队列；面板和 Agent 任一处确认即生效，另一处立即刷新为已确认。Agent 不因等确认而阻塞其他只读工作。
- **面板和宿主不互等**：面板读取宿主状态失败时降级为只读提示，不阻塞面板其他区域。
- **两个入口改同一目标**：Workflow 用 `expectedRevision` 乐观并发，冲突时提示“内容已变化，重新读取”，不加长期锁。
- **必须加锁时**（例如 Workspace Lease）：锁有 TTL 和续期；持有方断开后自动过期；界面显示谁持有、何时过期，并提供“接管”入口（需确认）。
- **模态框**：同一时刻最多一个；模态内必须能关闭；不允许模态内再弹需要外部操作才能关闭的模态。能就地完成的编辑不开模态（§13.3）。

### 4.4 冻结目标，不冻结界面

生成任务提交时冻结 project / timeline / clip / 帧范围；之后用户继续切换选择，不改变正在执行的目标，也不阻止用户发起针对新选择的新任务。

## 5. 通用状态模型

所有长任务使用同一套状态与视觉：

~~~text
idle → planning → awaiting_approval → queued → running → completed
                                   ↘ canceled         ↘ failed
                       running → unknown_submit（后台查询）→ running | completed | failed
~~~

| 状态 | 用户看到 | 主动作 | 出口 |
| --- | --- | --- | --- |
| idle | 当前选择 + 输入框 | Generate / Plan | — |
| planning | 计划摘要逐项出现 | — | 取消 |
| awaiting_approval | Plan 卡：内容、模型、预计费用 | Approve & Run | 修改 / 取消；超时作废 |
| queued / running | 真实进度或“等待供应商” | — | 取消；关闭面板（任务继续） |
| unknown_submit | “正在确认是否已提交”，不锁界面 | — | 继续其他工作；查看详情 |
| completed | 候选结果 | 下一步（导入 / 应用） | 重新生成；丢弃 |
| failed | 可读原因 + 建议 | 重试 / 修改 | 诊断；Open in Iris |
| canceled | “已取消”及计费提示 | 重新开始 | — |

视觉映射（每个状态的颜色、图标、动效）见 §14.3；生成过程的细分状态（streaming / partial preview / late result）见 §19.6。

## 6. 核心流程

### 6.1 宿主叠加层（Resolve 首发）

~~~text
选中片段 → 面板显示 Current Clip
→ 选工具（Layer；可选 Draw 在当前帧圈区域）
→ 输入意图 / 参考
→ Plan（候选数、模型、预计费用）→ Approve & Run
→ 候选生成中（各自进度）→ 候选网格比较 → 选定一个
→ Add to Media Pool（P0）
→ Add to new track（P1，能力探测通过才出现）→ 轨道开关对比 / 删除即撤销
~~~

| 步骤 | 状态 | 主动作 | 出口 |
| --- | --- | --- | --- |
| 无项目 / 无选择 | 一句话说明 + 示意 | 无（等待选择，不阻塞） | Open in Iris |
| 有选择 | Current Clip 卡 | Generate | 切换工具 |
| Draw | 当前帧上画区域；可清除、可撤销笔画 | 完成 | 取消（不影响已有输入） |
| 候选生成 | 网格中每格独立进度 | — | 单格取消 / 全部取消 |
| 候选就绪 | 网格；悬停预览为叠加在当前帧上 | 选定 | 重新生成某一格 |
| 已选定 | 选中格高亮 | Add to Media Pool / Add to new track | 换一个 |
| 已上轨道 | 轨道上显示 Iris 片段 | — | 开关；删除；替换为另一候选 |

规则：
- 预览永远是“叠加在原帧上”，原片在任何步骤都不被写入。
- 未选中的候选留在 Media Pool 的 Iris bin，不自动删除；清理是用户显式动作。
- 能力探测失败时，P1 入口退化为“已导入 Media Pool，可拖到时间线”，不出现无法完成的按钮。
- 宿主面板跟随宿主主题与密度，不套用玻璃材质（[DESIGN.md](DESIGN.md) §9.2）。

### 6.2 Agent 发起

~~~text
外部 Agent 读取上下文 → 准备任务 → 面板顶部出现 Agent 活动条（头像 + 当前步骤）
→ 付费动作进入待确认 → 用户在面板或 Agent 中确认 → 执行 → 结果同样进入候选
~~~

- 活动条只显示状态，不是聊天。对话留在 Agent 自己的界面。
- 已确认范围内的后续调用不重复询问；输入、费用或目标变化时重新确认。
- Agent 断线：活动条显示“Agent 已断开”，已提交任务继续，结果照常进入候选；用户可继续手动操作。
- Canvas 抽屉与 Iris 中的活动条、run 状态岛是同一组件的不同尺寸（§16.2）。

### 6.3 Canvas 编辑与运行

- 节点就地编辑；运行单个节点或其下游；只重跑受影响的节点，已接受结果不被静默替换。
- 运行中改参数：当前运行继续，修改标记为“下次运行生效”，不中断也不丢弃。
- 晚到结果作为新版本出现，不覆盖用户已选定的版本（§19.6）。
- 多步制作交给 Iris（§11 交接）；交互模型细节见 §13。


### 6.4 Canvas Drawer / Cut 的创作请求

用户在现有 Assistant Drawer 中明确引用 Canvas 素材，Agent 调用统一业务工具，改动与结果落在 Canvas/Cut 的真实工程中；只需要问答时不强制创建画布节点。多步骤任务以 Run ID、Artifact 和审查卡关联，不重复开发一张“个人 Agent 主页”。

可选宿主上下文必须在用户授权下按范围读取。真实工程修改先提出可审核的目标、范围和 Diff，批准后执行，再读取结果验证。见 [11](11-iris.md)。

### 6.5 Agent 连接中心

- 只显示可行动状态：已准备 / 需安装 / 需登录 / 离线 / 异常，每个状态配一个动作按钮。
- “已准备”只表示本地准备完成，不代表第三方登录或自然语言任务已验证。
- 一个 Agent 连接失败不影响其他 Agent 与 Canvas 使用。
- Agent 页不放对话、不放 run 编辑；最多放只读的“最近 run”跳转（与 [16](16-agent-video-pipeline.md) §6 一致）。
- Agent 页是 Iris 的“供应方”：Iris 输入框的 Agent / 模型 chip 只读 Agent 页的结果，配置入口跳回 Agent 页。

### 6.6 首次使用

需要时才配置：先让用户看到并编辑内容，第一次生成或第一次在 Iris 发送时才要求配置 AI 服务（Provider + Key），配置完成后回到原操作继续，不丢输入、不丢附件。空态设计见 §17。

## 7. 文案与反馈

- 用动词开头的按钮：Generate、Add to Media Pool、Add to new track、Open in Iris。
- 错误文案 = 发生了什么 + 用户能做什么，例如“供应商限流，30 秒后可重试”。不暴露端口、Lease、MCP JSON、Token、内部 bridge 名称；工具调用详情默认是人话摘要，原始参数只在“诊断”折叠里。
- 进度描述要具体（“正在渲染 v3 · 第 212/360 帧”），避免“加载中”“处理中”这类空词。
- 只对重要完成给确认反馈（导入成功、run 完成、归档完成）；常规成功不打断。
- 未上线能力在演示 / 宣传中标注 **Coming soon**；产品界面里不显示无法使用的入口。
- 中英文同步；文案长度变化不得造成布局溢出。

## 8. 布局（容器驱动）

~~~text
app-shell
├─ top bar（画布 Canvas | Cut | Agent）
└─ workspace
   └─ studio-layout
      ├─ studio surface
      │   ├─ Canvas：无限画布 + 浮动 chrome（工具条、小地图、快捷开关）
      │   ├─ Iris：对话栏 + 画布产出面（同一 Workflow）+ 浮动 chrome（run 状态岛、Agent 光标）；首次进入是对话首页
      │   └─ Agent：页面
      ├─ Iris 对话栏（对话为主，计划 / 运行 / 逆向拆解为对话内卡片与子面板；顶栏玻璃、正文实底）
      └─ Canvas Assistant drawer（轻量上下文入口，多步制作交给 Iris）
~~~

- 布局由容器宽度决定，不由全局 viewport 状态驱动；断点只表达“容器能否容纳当前组合”。
- Canvas 自己拥有二维 pan / zoom；外围 chrome 才参与 reflow。侧栏 / drawer 宽容器并排（docked），窄容器 overlay。
- 每个 surface 只有一个主滚动容器：Canvas / Iris 画布为二维画布（Iris 对话首页与对话栏为页面），Agent 为页面，侧栏 / Drawer 为当前分区，Modal 为 body。
- 宿主面板：单列，280–480 px 宽度可用，跟随宿主主题、密度、键盘与焦点约定。
- 禁止回归：JS 计算的 `rightPanelInset`、为固定 drawer 宽度打的补丁 class、结构列 absolute 定位、每像素 resize 写全局状态、不可收缩的固定像素结构列、多个争抢的页面级滚动。
- 验证：320–2560 CSS px、短高窗口、resize 压力、drawer 开关；无横向溢出、主操作可达、resize 不丢输入、不触发网络请求或保存。

## 9. 可访问性

- 所有操作可用键盘完成，焦点顺序与视觉顺序一致；宿主快捷键优先。焦点环用 2px `--isl-mint` + 2px 外偏移，不被 `overflow:hidden` 裁掉。
- 状态不只靠颜色区分（同时有图标或文字）；运行中 / 失败 / 已锁定 / 待确认四种状态必须各有独立图标。
- 动效可减弱：`prefers-reduced-motion: reduce` 时，位移 / 缩放 / 弹簧全部变为 ≤ 120ms 的透明度过渡，无限循环动画（呼吸、扫光、旋转）停止，改为静态图标 + 文本（[DESIGN.md](DESIGN.md) §12、§14）。动效不承载唯一信息。
- 透明度可减弱：`prefers-reduced-transparency: reduce` 或 `prefers-contrast: more` 时，玻璃材质退化为实底（[DESIGN.md](DESIGN.md) §9.2）。
- 正文对比度 ≥ 4.5:1，次要文字 ≥ 3:1（在玻璃上按最坏背景估算）；`--isl-ink-ghost` 只用于占位与禁用，不用于需要阅读的信息。
- 进度与状态变化通过 `role="status"` / `aria-live="polite"` 播报；失败用 `role="alert"`，只播报一次。
- Agent 光标与标签对读屏隐藏，其动作以 trace 行的 `aria-live` 播报（“字体 Agent 修改了文字层 curiosity.”），每 5 秒最多合并播报一次。
- 点击目标 ≥ 24×24 CSS px（画布节点手柄在 hover / focus 时扩大命中区，不改变视觉尺寸）。

## 10. 验收清单（每个新交互必须过）

- [ ] 状态表完整，每个状态出口非空。
- [ ] 所有选项来自注册表 / schema / 能力探测；新增一个选项不改组件代码。
- [ ] 所有等待有取消或超时；断网、断 Agent、关面板后可恢复。
- [ ] 人与 Agent 同时操作同一目标时有冲突提示，没有挂起。
- [ ] 默认动作不破坏原素材；破坏性动作有确认与撤销。
- [ ] 中英文、窄 / 宽容器、键盘操作通过。
- [ ] 只用 [DESIGN.md](DESIGN.md) token：组件内无新增 hex、无 `rounded-2xl/3xl`、无 `border-[1.5px]`、无自定义 cubic-bezier。
- [ ] 动效使用 DESIGN.md §14.3 的三档弹簧之一或退出曲线；可被打断；reduced-motion 下无位移与无限循环。
- [ ] 玻璃只出现在 DESIGN.md §9.2 允许的位置；reduced-transparency 下退化为实底且对比度达标。
- [ ] Agent 对画布的写入可见（光标）且可追溯（trace），用户抓取元素时 Agent 让路（§12.3）。
- [ ] PR 含参考小节与一致性检查表（§18）。
- [ ] 亮 / 暗主题各截图核对一次（画布、抽屉、弹层、节点生成态）。


## 11. 产品地图：三个当前入口与 Drawer

| 入口 | 当前职责 | 交接 |
| --- | --- | --- |
| **Canvas** | 无限画布、素材与生成节点、Workflow、候选与版本 | 选中媒体可交给现有 Assistant Drawer |
| **Cut** | 已实现视频编辑器：时间线、字幕、基础属性、代理、导出 | 与 Canvas 引用相同素材；Agent 经 `iris_cut_*` 操作同一 Cut Store |
| **Agent** | 模型、Provider、外部 Harness、Runtime、Skill、连接状态 | 供应工具和连接，不提供第二份聊天或工程 |
| **Assistant Drawer**（非顶栏） | 内置 Agent 对话、明确素材引用、执行反馈与审批 | 复用 BrowserAgentRuntime、Workflow、Cut 与 Runtime |

## 12. Spatial Context + Creative Review（阶段目标）

### 12.0 Agent 嵌在画布里（2026-11-24）

以画布为主：**Canvas 管空间，Agent 管执行，Cut 管时间**。画布上可以有 Agent 会话卡（`plugin:agent-session`）和轮次卡，它们是 Session 的投影：只存 sessionId / entryId 和一段摘录，正文从会话里读；不建第二套会话库，工具调用不单独成卡。

- **就地问**：双击空白，新建菜单第一项是「问 Agent」，光标直接在输入框；打字回车即在双击位置创建会话卡并发送。快捷键 `A`（无修饰键，焦点不在输入框时）：有选区 = 与 Agent 讨论，无选区 = 在视口中心问 Agent。
- **选中素材讨论**：选区浮动工具条「与 Agent 讨论」在选区旁的空位创建会话卡，选中素材以 Chip 绑定为这一轮的引用（`iris.turn_context`）。同一选区重复点击只定位已有的未发送卡片。
- **流式**：卡片只显示进度点和前几行；完整 markdown、工具日志和审批在 Drawer。点卡片头部或「展开」打开 Drawer 并切到这个会话。
- **就近布局**：新卡片和产物只放进来源旁的空位（右 → 下 → 左 → 上，逐圈外扩）；放不下时放到所有内容右侧，绝不移动用户已摆放的节点。
- **最少上下文**：默认不把整张画布交给模型，只给绑定的素材和最少的信息。
- **外部 Agent**：画布上只存引用、摘要、回执和产物关系，不投影外部会话正文。

### 12.1 引用素材发起讨论

复用已有 Canvas 多选、`@` Chip、缩略图、消息分叉和节点定位；画布上的入口见 §12.0。发送 Turn 时结构化保存真正的 session/message ID、node/asset ID、内容版本/指纹和实际发给模型的媒体范围；历史文本解析仅用于旧会话兼容。没有用户显式选择，不读取整张画布或整个专业工程。

### 12.2 Commit 结论到画布

助手回复可「钉到画布」：确认标题、结论与来源 Chip 后创建**独立** `plugin:context-card`，不复用备注 `text`。用户点 Commit 后卡片正文定稿，后续聊天不自动更改；再次更新须显式保存且保留版本。

### 12.3 Context 关系可视化

Workflow 执行流保留常驻连线；Context 关系默认隐藏，卡片显示来源数量和缺失/更新提示，仅悬停或选中时高亮关联节点。移动、缩放不触发“来源已更新”；内容指纹改变才触发。

### 12.4 继续讨论与跨 Agent

原会话可访问则回到现有 Drawer；外部会话失效或用户要新分支时，以卡片定稿 + 已授权、可访问的当前来源开启新会话，不假定跨宿主 Session Fork。删除卡片不删除会话，删除会话不应抹掉卡片。

### 12.5 Proposal / 审批（下一阶段）

Agent 先读取目标与版本，提出按 clip/帧段限定的操作提案，显示 Diff、预览、费用与风险。批准后再检查目标指纹，提交到 Canvas Workflow、Cut Store 或经官方能力发现的宿主 API；冲突直接提示，不静默重算或覆盖原片。

### 12.6 预览与版本对比

Canvas 对比生成节点的真实 take / 版本，Cut 检查时间线上的目标帧段、字幕和音轨。只展开当前任务需要的审片 UI，完成后收拢成结果与回执；不让聊天日志淹没素材。

### 12.7 Run / Artifact

讨论实时引用最新素材；真正运行或渲染时冻结输入版本、目标、素材指纹。任务状态持久化到 Runtime，Canvas、Cut、Drawer 只持有真实引用。

### 12.8 宿主上下文（可选，Experimental）

先通过已验证的接口只读读取工程、时间线、选择、素材和暴露的效果摘要。无法读取的 OFX/Color/Fusion/Magic Mask 内部参数需明确标未知，不推断完整可见性。写回先导入 Media Pool，经真实宿主保存重开测试后再增加新轨道/时间线分支。

### 12.9 临时界面

只在选角、卡点、差异审查和审批等任务需要时展示对应组件。状态必须可退出、重试或取消；成功后收拢，不新增第四个常驻工作区。

### 12.10 v1 验收

三个素材发给 Agent → 实际引用持久化 → 钉卡片 → 刷新与节点变更 → 重新讨论。画布：双击空白问 Agent → 会话卡流式 → 选中素材讨论 → 打开 Drawer 切到同一会话。默认不需 Resolve，不创建第二个 Agent 会话库。

### 12.11 历史原稿

2026-11-17 的独立 Iris Personal Agent tab、Hark 式对话首页、多 Agent 光标飞入与独立逆向工作台是此前设计探索。原稿保存在 [2026-11-24 归档](../archive/2026-11-24-agentos-alignment/01-interaction.md)，不能据此重新开发旧导航。

## 13. Canvas 交互模型

### 13.1 空间与视角（已实现）

- 同一张画布在 Canvas 与 Iris 中打开：Canvas 显示全部节点与工具；Iris 额外叠加 Agent 光标、run 分组与 trace 高亮（§12）。
- 画布自己拥有 pan / zoom（`components/workflow/InfiniteWorkflow.tsx`）；外围 chrome 不参与画布坐标计算。
- 左下角快捷开关（小地图 / 磁吸 / 连线 / 网格，`WorkflowQuickToggles.tsx`）与工具条“画布控制”菜单共享同一状态。
- Agent 操作视角（`workflow.viewport.set`）时，视角平移用 smooth 弹簧（DESIGN.md §14.6），并在目标节点上短暂显示 Agent presence 标记（`workflow-node__presence`，已实现）。

### 13.2 选择、连接与布局

- 单击选中；Shift / 框选（`WorkflowNodeLasso.tsx`）多选；Esc 清空。
- 连接：从源手柄拖到目标手柄；键盘可用（手柄按钮支持 `detail === 0` 的键盘激活，已实现）。连线默认显示，可在快捷开关中隐藏。
- 自动整理（`arrange.ts`、`layoutAlgorithm.ts`）：节点移动用 smooth 弹簧过渡，整理可撤销。

### 13.3 编辑原则（设计目标）

- **就地优先**：能在节点上完成的编辑（标题、参数、裁剪框、蒙版笔刷）在节点上完成，不开 antd `Modal`。模态只用于跨对象或破坏性确认。
- **一个节点一个主动作**：运行 / 停止 / 重试在同一位置切换。
- **版本在节点上**：同一节点的多次结果（take）以版本条显示在节点底部，晚到结果标“有新版本”，不自动切换（已实现：`OperationVersionStrip` 挂在带生成记录的 image / video / audio 结果节点左上角）。
- **输入直连结果**（2026-11-18）：不再有 operation 中间节点。生成与后处理（局部变换、剪辑、分离、放大等）直接建结果节点并从输入连线；能力、参数、模型、takes 与选中记在结果节点 `metadata.operation` 上，在结果节点上即可改参数重跑、停止、切换版本（同 LibTV“节点即结果”）。多输出能力（宫格切分、拆图层、音视频 / 人声分离）的其余结果是兄弟节点，同样从输入直连。旧画布在加载时迁移（持久化 v6，`components/workflow/directOutputMigration.ts`）。
- **多结果挂在首图节点上**（已实现，2026-11-16）：一次生成多张图片 / 多条视频时，首图就是原节点（普通节点：PromptBar、工具条、连线、prompt / 模型 / Take 都在它身上，单击选中它本身，不是“打组”）；其余结果是它的备选（`metadata.alternates`），不是画布节点，图片与视频可混合。
  - 结果总数 ≤4（首图 + ≤3 个备选，阈值 `ALTERNATE_STACK_MAX_TOTAL`）：沿用原来的斜叠卡片——备选是首图节点**后面**的视觉卡片（节点 DOM 的子元素，不是画布节点、不是分组），左右斜出，悬停散开（`ImageFan` 同一套姿态和弹簧）；右上角“N 张”展开：以首图为左上角铺成 2 列网格，每格从叠放位置弹出，带 下载 / 设为首图，点格子进画廊，首图标“首图”，同一按钮变“收起”反向飞回。图片与视频一样（视频用封面）。拖首图或任一卡片 / 格子 = 拖这一个节点，整摞跟着走。
  - 总数 >4：节点下方停靠网格（宽度 = 节点宽度，最多露 2 行半，内部滚动，不铺到画布上），复选框多选；表头批量 对比预览 / 导出 / 拆成独立节点 / 删除，可收起。
  - “设为首图”只交换媒体（含类型），节点 ID、位置中心、连线、prompt、配方不动，旧首图换进同一槽位；一步撤销。Agent 的 `set_batch_primary` 指向备选 ID 时走同一交换。
  - 画廊预览：大图 + 缩略条，←/→ 切换、显示 n / N、视频带原生控件、非首图可“设为首图”；单节点预览不变。
  - 旧项目里同位叠放的批次在加载时折叠成备选；连了线的成员改成普通节点（排查与迁移规则见 [quality/2026-11-16-batch-alternates](../quality/2026-11-16-batch-alternates.md)）。分镜 / 批量命令建的分组（多个不同内容的节点，`group_nodes source: auto`）仍是可折叠的堆叠，与多结果无关。

### 13.4 拖放

- 从素材库 / 文件系统 / 浏览器扩展拖入：画布显示落点预览（虚线框 + 吸附网格），松手后节点以 expressive 弹簧落定；导入（转码、入库）进度显示在新节点内，不另开对话框（转码路径见 [10](10-canvas-workflow.md) §3）。
- 拖到已有节点上 = “替换素材”需显式确认，默认是新建。

## 14. 交互状态与反馈映射

### 14.1 通用交互状态

视觉数值（颜色、边框、圆角、时长）只在 [DESIGN.md](DESIGN.md) §6、§11、§14；这里只规定行为。

| 状态 | 行为 |
| --- | --- |
| hover | 只改变外观，不改变布局、不位移；不触发数据请求 |
| pressed | 即时反馈；不缩放（缩放只留给拖拽落点） |
| focus-visible | 键盘焦点必须可见且不被裁切；焦点顺序 = 视觉顺序 |
| selected / active | 选中态必须同时有非颜色线索（勾、描边或文字） |
| disabled | 悬停给出“为什么不可用”与可行动的下一步；不隐藏真实存在但暂不可用的能力（除非宿主不支持，§3） |
| loading | 控件原位显示进行中，宽度不跳；可取消的给取消 |
| error | 错误就近显示，说明原因与动作；不抖动、不只靠颜色 |

### 14.2 主要组件的行为

| 组件 | 行为 |
| --- | --- |
| 主按钮 | 一个视图一个；生成 / 发送中原位变为“停止” |
| chip | 切换即生效，不需要“应用”；计数随筛选实时更新 |
| 分段 / 标签 | 切换不丢失各分区的滚动与输入 |
| 卡片 / 节点 | 单击选中、双击就地编辑主字段；右键菜单与工具条动作一致 |
| 弹层 / 菜单 | Esc 关闭并把焦点还给触发者；点击外部关闭；同一时刻一个 |
| 输入 / composer | Enter 发送、Shift+Enter 换行；发送失败保留输入与附件 |
| 确认卡 | 不阻塞画布；超时作废并说明；任一入口确认即同步（§4.3） |

### 14.3 任务状态的视觉映射

| 状态 | 图标（lucide） | 颜色 | 动效 |
| --- | --- | --- | --- |
| queued | `Clock` | ink-soft | 无 |
| running（进度已知） | 环形 / 线性进度 | mint | 数值变化用 smooth 插值 |
| running（等待供应商） | `LoaderCircle` | ink-soft | 旋转 1.2s；减弱动效时静态 |
| streaming | 文字光标 / 逐行显现 | ink | 新行 snappy 淡入 |
| awaiting_approval | `ShieldQuestion` / `BadgeDollarSign` | sun | 岛内出现时 expressive 一次 |
| unknown_submit | `CircleHelp` | sun | 无 |
| succeeded | `CheckCircle2` | mint | 打勾一次（≤ 300ms），不放彩纸 |
| failed | `XCircle` | coral | 无抖动；就近显示原因 |
| canceled | `CircleSlash` | ink-ghost | 无 |
| locked | `Lock` | ink | 无 |
| rejected（废片） | `Archive` | ink-ghost | 无 |

## 15. 主题行为（亮 / 暗 / 跟随系统）

- 三态：`light | dark | system`（`ThemeMode`），切换写根节点 `data-theme`；`color-scheme` 同步，表单控件跟随。
- 色值见 [DESIGN.md](DESIGN.md) §4；所有新色值必须同时给亮 / 暗两套。
- 切换过渡：根背景与文字 `--motion-base` 颜色过渡（已实现于 `html, body`）；主题菜单中的开关拇指用 snappy 滑动、图标在日 / 月之间交叉淡化（参考 Inspora *day/night toggle*、*dark/light mode toggle*，只取“拇指滑动 + 图标变形”，不做像素风与高光）。
- 媒体与生成结果不随主题改色；画布网格、连线、选中描边随主题。
- 每个视觉改动在两个主题下截图核对。


## 16. Agent Run 与 Trace 的 UI

### 16.1 放置

Canvas/Cut 展示实际素材、可见改动和状态；Drawer 展开对话、步骤、审批；Agent 页只显示连接与 Runtime 健康。Runtime 的 Run/Artifact 才是持久执行事实。

### 16.2 状态与出口

planned、running、waiting-approval、completed、failed、unknown 各自配合真实时间/任务 ID 与继续、取消、查询、重试或诊断操作。不要用永远旋转的动画掩盖未知提交。

### 16.3 Trace

默认按 Run → Step → Tool call → Artifact / Review 显示折叠的记录；展开能定位对应 Canvas 节点、Cut 帧段与宿主目标。模型自述不是已执行证据，不能用聊天正文替代回执。

## 17. 空态与加载

| 场景 | 现状（代码） | 规范 |
| --- | --- | --- |
| Cut 空时间线 | 现有 `CutPage` / `CutEditor` | 提供导入画布素材、打开已有项目或退出；不新增个人 Agent 对话首页 |
| Canvas 抽屉空会话 | `AgentEmptyState`：标题 + 4 个快捷入口（感知画布、爆款预设、上传故事、批量优化） | 保留为轻量入口；需要多步执行时继续使用同一 Drawer/Run；快捷入口应按真实 Skill 能力提供，不能跳到旧个人 Agent 页 |
| 未配置 AI 服务 | 抽屉内 `agent-setup-card` + “添加 API Key” | 保留“需要时才配置”（§6.6），配置后回到原输入 |
| 空画布 | `WorkflowStartScreen` | 一句话 + 三个起点（导入素材 / 从模板 / 让 Assistant 开始）；可选静态线稿插画，不循环动画 |
| 空素材库 | “这里还没有资产” / “没有匹配的资产” | 区分“空”和“筛选无结果”，后者给“清除筛选” |
| 首屏加载 | — | 骨架只画结构（节点框、行），≤ 300ms 不显示骨架，避免闪烁 |
| 列表 / 表格加载 | — | 骨架行 + 单向扫光；有数据即替换，逐行淡入（数值见 DESIGN.md §11.3、§14） |
| 生成中 | 节点内 `WorkflowGenerationLoader`（`flv-gen`）：圆角方块网格按真实阶段细分 + 3px 进度线 + 一行状态 / 耗时；本地导入仍用 `flv-generation-glass` | 见 §19.6 |
| 错误空态 | 各处不一 | 统一：图标 + 发生了什么 + 一个动作 + “诊断”文字链接 |

## 18. 参考先行（standing rule）

**设计或实现任何 UI / 动效之前，先查参考，并在 PR 中引用实际打开过的页面。** 四个来源各有分工：

| 来源 | 角色 | 用法 |
| --- | --- | --- |
| [Inspora](https://www.inspora.design/) | 灵感：具体的交互 / 动效片段 | 找 2–5 个与本次交互相关的帖子，写下“借鉴了什么”（状态、转场、节奏），不复制素材 |
| [Awwwards](https://www.awwwards.com/) | 审美校准 | 对照当期 Sites of the Day / 相关分类，校准密度、字体层级、留白是否过时；只做判断依据，不搬视觉 |
| [GSAP Showcase](https://gsap.com/showcase/) | 动效与交互：文字动画、滚动触发、视差、FLIP 转场、拖拽 | 看实现手法与节奏；产品内以 `motion` 实现（DESIGN.md §14.7），不因此引入 GSAP |
| [Refero Styles](https://styles.refero.design/) | 风格系统与 DESIGN.md 提取 | 参考其 DESIGN.md 分层（本仓库 [DESIGN.md](DESIGN.md) 即按此格式）；有 MCP 可用：服务器 `https://api.refero.design/mcp`（OAuth 或 Bearer token，需付费 Refero 计划），工具含 `refero_search_styles`、`refero_get_style`，见 [Refero MCP 文档](https://doc.refero.design/mcp/getting-started) |

执行要求：
1. PR 描述含“参考”小节：来源 · 页面 URL · 借鉴点 · 落到哪个 surface；没打开过的页面不写。
2. 规范层面的依据（无障碍、材质、进度、弹簧）优先引用 Apple HIG / WWDC 与 Figma 设计文章（§20.3、§20.4）。
3. 借鉴结论落到 [DESIGN.md](DESIGN.md)（视觉 / 动效 token）或本文（交互行为），不新建并列文档。
4. 一致性检查表：每个新功能 × 用了哪档弹簧 × 是否用玻璃（且是否在允许位置）× 参考来源。


## 19. 当前交互原则与可扩展方向

现有 Canvas/Cut/Drawer 是唯一创作与对话入口。后续按 P0/P1 接入结构化引用和独立 Context Card；再引入 Creative Proposal、逐帧审查、非破坏性结果写回与经确认的 Skill。

旧的 Personal Agent 独立页、Crew / Director / Operator 必经编排、多 Agent 光标飞入式生产等属于历史候选，不构成当前代码任务。原稿见 [归档](../archive/2026-11-24-agentos-alignment/01-interaction.md)。

## 20. 参考与可借鉴交互

均为 2026-11-13 实际打开的页面；只借鉴交互思路，不复制素材。Inspora 帖子以弹窗形式打开，描述与观察记录来自页面本身。规则见 §18。

### 20.1 Inspora 帖子

| # | 参考 | 交互 / 动效要点 | Iris 落点 | 优先级 |
| --- | --- | --- | --- | --- |
| R1 | [dynamic release island](https://www.inspora.design/posts/dynamic-release-island)（@BrettFromDJ） | 状态 pill 展开为构建 / 签名 / 公证 / 上传进度面板；绿色扫光填满 pill，完成打勾 | run 状态岛（§16.2）、抽屉 run 条、流程站点进度 | P0 |
| R2 | [tests visualised](https://www.inspora.design/posts/tests-visualised)（@zzzzshawn） | 每个文件一条分段进度，失败红标，失败用例重跑时显示修复状态，上方实时折线 | trace 分段进度与失败重试（§16.3）、评审轮次 revise → pass | P0 |
| R14 | [agent dashboard](https://www.inspora.design/posts/agent-dashboard)（@barret_jessy） | 任务行带优先级与状态点；点 Delegate 后出现“Claude Code is thinking”小 pill | 计划清单的委派外部 Agent（§19.2） | P0 |
| R16 | [Photo download UI design](https://www.inspora.design/posts/photo-download-ui-design)（@RaminNasibov） | 半透明卡片：点阵环形进度 + “1,077 / 2,481” + 速度 / 剩余，完成变勾 | 长视频任务 / 批量生成 / 归档进度卡（§19.6） | P0 |
| R18 | [spreadsheet UI](https://www.inspora.design/posts/spreadsheet-ui)（@Nomandsign） | prompt 提交后空表格被一道模糊扫过，逐行变清晰并填入状态标签 | 脚本 / 分镜流式生成（§19.1、§19.6）、表格骨架 | P0 |
| R12 | [glass recorder](https://www.inspora.design/posts/glass-recorder)（@kaolti） | 圆形麦克风按钮拉伸成录音 pill，内含计时与停止 | 生成按钮原位变进行中 pill + 停止；语音输入 | P1 |
| R4 | [onboarding for Anything](https://www.inspora.design/posts/onboarding-for-anything)（@jaydwivedi_） | 叠放的示例 prompt 卡依次上浮到前排 | 仅作为 Drawer 空态的可选灵感；旧 Iris 首页不再实现 | P1 |
| R6 | [admin dashboard](https://www.inspora.design/posts/admin-dashboard)（@desdivj） | 同一批用户记录在表格与卡片视图之间重排，筛选与状态标签不动 | 素材库网格 ↔ 表格（§19.3）、trace 列表 ↔ 时间线 | P1 |
| R8 | [digital card packs](https://www.inspora.design/posts/digital-card-packs)（@Yassshhu） | 撕开卡包，卡片扇形展开并带倾斜落定 | 批量候选完成时“发牌”扇出（克制版，无彩纸）（§19.5 N6） | P1 |
| R9 | [interactive folder cards](https://www.inspora.design/posts/interactive-folder-cards)（@damienghader） | 打开文件夹时内容缩略图从卡片扇出，出现小关闭钮 | 素材库文件夹预览（§19.3） | P1 |
| R10 | [fluid tooltip animation](https://www.inspora.design/posts/fluid-tooltip-animation)（@Anthony99_s） | 一个 tooltip 在侧栏图标间滑动跟随，显示名称与快捷键 | 画布工具条 / 抽屉顶栏 tooltip（单实例跟随，snappy） | P1 |
| R13 | [Folders UI](https://www.inspora.design/posts/folders-ui)（@david_visuals_） | 嵌套侧栏 + 大文件夹卡 + 下方文件表 | 素材库信息架构（§19.3） | P1 |
| R3 | [UI Dropdown filter](https://www.inspora.design/posts/ui-dropdown-filter)（@AdelineAstraOS） | 下拉筛选，胶囊颜色表示开 / 关状态，展开后列出各项计数 | 素材 / trace 筛选 chip 的“状态 + 计数”（只取信息结构，不取拟物） | P2 |
| R5 | [day/night toggle](https://www.inspora.design/posts/day-night-toggle)（@Lattice_Node） | 玻璃球拇指在 pill 内滑动，场景在昼夜间交叉淡化 | 主题开关拇指滑动（§18） | P2 |
| R17 | [dark/light mode toggle](https://www.inspora.design/posts/dark-light-mode-toggle)（@kaolti） | 方形拇指滑动，像素日 / 月图标散开重组，边缘光由暖变冷 | 主题开关图标变形（§18） | P2 |
| R15 | [AI agent dashboard](https://www.inspora.design/posts/ai-agent-dashboard)（@BenceRedmond） | 组件选择器：已添加项带“On home”勾，未添加项带“+” | Agent 页连接 / Skill 列表的“已添加 / 添加”状态 | P2 |
| R19 | [github Contribution Graph](https://www.inspora.design/posts/github-contribution-graph)（@pratyusshmd） | 日历热力图，切换色板时格子整体重新着色 | Agent 页“最近 run”活动热力（只读）；主题色变更预览 | P2 |
| R20 | [Grid Reveal animation](https://www.inspora.design/posts/1-46)（Swami，2026-11-16 打开） | 方形预览被圆角小方块铺满，2×2 → 4×4 → 8×8 → 12×12 细分并随机深浅闪动，约 5.2s 一轮，最后方块随机淡出成图；左下角胶囊状态轮换“Starting to generate / Creating image / Adding detail” | 节点生成加载态网格与完成揭示（§19.6，按真实阶段细分，不循环伪造进度） | P0（已实现） |
| R21 | [Agent Handoff](https://www.inspora.design/posts/1-48)（Jeet，2026-11-16 打开） | 卡片里一条极细胶囊进度线 + 前沿圆点，按步骤缓出前进，完成时停在满格；底部一行“角色 · 当前消息” | 节点生成进度线与一行状态（§19.6，缩成 3px 并只用真实百分比） | P0（已实现） |
| R7 | [line art animation](https://www.inspora.design/posts/line-art-animation)（@dhruvtwt_） | 线稿街景由日到夜缓慢过渡 | 起始页静态线稿插画（不循环）（§17） | P2 |
| R11 | [glass slider experiment](https://www.inspora.design/posts/glass-slider-experiment)（@imsethidev） | 一排玻璃球滑动、折射图片 | 反例参考：玻璃不进入内容层；只借“激活中的滑杆拇指可变玻璃”（Apple 对 slider / toggle 的例外） | P2 |


### 20.2 GSAP Showcase

2026-11-13 浏览 [GSAP Showcase](https://gsap.com/showcase/)（用了 Text Animation / UI Interactions 筛选与 flip、progress 搜索），逐个打开了现场站点。只借动效思路；产品内用 `motion` 实现。

| # | 条目 | 观察到的动效（卡片标注的 GSAP 插件） | Iris 落点 | 优先级 |
| --- | --- | --- | --- | --- |
| G1 | [Butter](https://www.butter.video/)（Site of the Week，ToyFight） | 大标题按行 / 词揭示，3D 小物件在词与词之间落入，品牌行横向跑马（ScrollTrigger、SplitText、Draggable、CustomEase） | 文字层逐词揭示、元素在文字间落入组装（§12.4） | P0 |
| G2 | [Carter Ogunsola Portfolio](https://carterogunsola.com/)（Site of the Day） | 计数到 100 的预加载；切换视图时旧列表移出、新卡片飞入并错落定位（ScrollTrigger、Flip、CustomEase） | 首页 → 画布转场的 FLIP、元素飞入错开（§12.2、§12.4）；长任务计数进度（§19.6） | P0 |
| G3 | [Nodeck](https://www.nodeck.online/)（Site of the Day） | 幻灯片式 PREV / NEXT，整屏擦除切换，新页标题揭示（Observer、Flip、SplitText、Draggable、Inertia） | 预览播放器逐版本 / 逐镜切换、版本对比步进（§12.6、§12.7） | P1 |
| G4 | [Staanzza](https://stanzza.design/) | 缩略图条收拢为全幅视频主视觉；下方散布的图文以不同速率视差（ScrollTrigger、ScrollSmoother、Flip、MorphSVG） | “缩略 → 全幅”用于参考帧卡展开为播放器（§12.6）；视差**不进产品**（DESIGN.md §14.5） | P1 |
| G5 | [exrcst](https://exrcst.webflow.io/) | Pixi 渲染的丝绸幕布被“拉开”揭示页面（Pixi、Flip、MotionPath） | 仅作反例：画布渲染的大转场不适合工具界面 | P2 |

另：Showcase 没有 loading / preloader 标签，`progress` 搜索只返回 The Progressors（Observer），进度动效以 G2 与 Inspora R16 为准。

### 20.3 Apple

| # | 参考 | 要点 | Iris 落点 |
| --- | --- | --- | --- |
| A1 | [HIG · Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | 有目的地加动效；动效可选、不能是唯一信息通道；反馈简短精确；高频交互少加动效；允许打断动画 | DESIGN.md §14 |
| A2 | [HIG · Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Liquid Glass 是浮在内容层之上的控件 / 导航层；不要用于内容层；节制使用；文字多用 regular，媒体上用 clear 并在亮背景加 35% 暗化；减弱透明度 / 提高对比度设置会改变外观 | DESIGN.md §9.2 |
| A3 | [HIG · Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | 状态反馈放在它描述的对象旁；只对重要完成做确认；说明命令为何不能执行 | §2 就近反馈、§7 |
| A4 | [HIG · Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators) | 尽量用确定进度；进度要准确匀速（不要 5 秒到 90%）；保持运动以免像卡死；不确定可转确定；描述要具体；能停止 | §19.6 |
| A5 | [WWDC23 · Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/) | 弹簧保持位置与速度连续、可从手势速度接续、可重定向；用 duration + bounce 定义；默认 bounce 0，0.15 更利落，0.3 明显弹，> 0.4 过度；给出与 mass / stiffness / damping 的换算 | DESIGN.md §14.3 |

### 20.4 Figma

| # | 参考 | 要点 | Iris 落点 |
| --- | --- | --- | --- |
| F1 | [How Figma put the bounce in spring animations](https://www.figma.com/blog/how-we-built-spring-animations/) | 贝塞尔难以避免“凭空加速 / 突停”；弹簧由物理参数决定路径；用“速度 + 过冲”两个手柄而非三个物理量调参，并显示时长；导出 mass / stiffness / damping 给 Framer Motion | DESIGN.md §14.3（两参数定义 + motion 统一 preset） |
| F2 | [Inside the redesigned Figma (UI3)](https://www.figma.com/blog/behind-our-redesign-ui3) | 让作品而不是 UI 居中；可收起面板与底部细工具条；输入框加底色、下拉加边框、圆角与可选标签提升可用性 | §2 内容优先、DESIGN.md §6 |
| F3 | [Figma on Figma: Our approach to designing UI3](https://www.figma.com/blog/our-approach-to-designing-ui3) | 浮动面板挤占画布、内容从背后透出分散注意、拖慢长时间使用者，正式版改回固定可调宽面板，只保留浮动工具条；可见标签与读屏标签一致 | DESIGN.md §9.2（玻璃只给 chrome、侧栏正文实底） |
| F4 | [The art and influence of motion](https://www.figma.com/blog/the-art-and-influence-of-motion/) | 微动效要有明确目的；短过渡可掩盖不可避免的处理延迟；不能让体验依赖动画（可访问性）；过多弹跳会慢慢损耗信任 | DESIGN.md §14.1、§19.6 |

### 20.5 来源角色

见 §18：Inspora（灵感）、Awwwards（审美校准）、GSAP Showcase（动效与交互）、Refero Styles（风格系统与 DESIGN.md，含 MCP）。

### 20.6 优先采纳（Top 5）

1. **run 状态岛**（R1 + A5 + F3）：画布顶部玻璃 pill，展开为 Step 列表，扫光表示进度，完成打勾——把 16 号提案的 trace 变成随时可见、可点回的状态。
2. **分段 trace 与失败重跑**（R2 + A4）：一个 run 一条分段进度，失败红标、重试后显示修复，评审轮次 revise → pass 一眼可读。
3. **长任务进度卡**（R16 + A4）：环形 / 分段进度 + `7/12 镜` + 速度 / 剩余（有数据才显示），覆盖多镜生成、渲染、归档。
4. **流式逐行揭示**（R18 + F4）：脚本、分镜表、批量结果逐行由模糊到清晰，替代整块转圈。
5. **可见的多 Agent 光标与飞入组装**（理想交互视频 + R10 + R14 + G1 + G2）：Iris 画布上每个子 Agent 一个带标签光标，元素从来源飞入并组装，trace 与元素双向高亮（§12.3–§12.5）。

另：玻璃只给 chrome + 三档弹簧（A2 + F3 + A5 + F1）作为所有项的共同约束，见 DESIGN.md §9.2、§14.3。


## 21. 可点击原型

[`docs/design/prototypes/index.html`](prototypes/index.html)：单文件、无外部资源，直接用浏览器打开。六个页签对应 §12 Iris（原型仍是改名前的“prompt 首页 → 画布 + 侧栏对话”版本，**待按 §12 对话优先重画**；→ 画布多 Agent 光标 → 播放）、§19.1 流程视图、§16.2 run 状态岛 + 侧栏实时 trace、§19.2 计划与审批、§19.3 素材库与版本对比、§19.6 生成进度；每个页签标注所依据的 Inspora / GSAP 参考，统一使用 DESIGN.md 的 token、三档弹簧与玻璃规则，并响应系统的亮 / 暗、减弱动效、减弱透明度设置（页面右上角可手动切换）。原型是交互示意，不是实现；不进入构建产物。
