# Iris 交互设计

> 状态：**Current truth**（2026-11-13 重构）。本文只管**交互与行为**：状态、流程、出口、谁能做什么、动效在什么时候发生。视觉与动效 token（颜色、字号、圆角、阴影、玻璃、弹簧数值）只在 [DESIGN.md](DESIGN.md)，本文引用不重复。
> 标注约定沿用[总体设计](00-overview.md)：**已实现** = 代码在主干；**设计目标** = 尚未实现；**假设** = 待真实环境确认。§1–§10 编号保持稳定，供其他文档引用。
> 结构：§1–§10 交互规则 · §11 产品地图（三个 surface 与交接）· §12 Iris 个人 Agent 工作区 · §13–§17 Canvas、状态映射、主题、run / trace、空态 · §18 参考先行 · §19 产品交互模式 · §20 参考 · §21 原型。

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

### 6.4 Iris（个人 Agent）发起 run

~~~text
对话中说出意图 + 拖入素材（或由已连接的宿主带入上下文） → 规划 → 计划卡（预算一次确认）→ 画布上多 Agent 光标执行
→ 渲染 vN → 评审轮次 → 修补 vN+1 … → pass → 播放 / 归档
~~~

- 写入画布只通过 Canvas 的命令（`workflow.apply` 等），每次写入都显示为光标动作并进入 trace；不形成第二份 Workflow 权威。
- 逆向拆解（转写、对齐、timeline）是 run 的工具；其“同步到画布”仍是一次 `workflow.apply`，默认新增、不覆盖用户已选版本。
- 转写导入、批量生成有进度与取消；取消后已完成部分可保留或丢弃，由用户选择。完整设计见 §12。

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

## 11. 产品地图：三个顶级 surface、工具归属与交接

> 2026-11-13 定案（覆盖 PR #45 中“run 主场在 Canvas Assistant drawer”的放置决定）；2026-11-17 逆向改名 Iris 并改为对话优先。总纲同步见 [00 总体设计](00-overview.md) §2，pipeline 放置见 [16](16-agent-video-pipeline.md) §6。

| Surface | 一句话 | 拥有的工具 / 状态（唯一业务实现） | 不做 |
| --- | --- | --- | --- |
| **画布 Canvas** | GenAI 生成与 Workflow 基本盘 | 节点、连线、`workflow.inspect / selection.get / apply / node.run / viewport.set`、生成任务、素材库、版本 / take / batch、上传与转码 | 不托管多步 run 的编排；不放全量 trace |
| **Iris**（全能后期助手 · Personal agent；原名 逆向 Reverse） | 对话优先的个人 Agent，**Iris 画布是它的产出面**；Web 版不连任何宿主也完整可用，可选连接本地宿主同步剪辑上下文 | 对话、run（plan → steps → review rounds → versions）、多 Agent 光标、计划 / trace / 审批卡、预览播放器、版本对比、宿主连接器状态；Hypit 式逆向拆解（转写 → 对齐 → timeline → 字幕 / 视觉 / 音频轨）作为它的**一组工具与一个面板** | 不复制 Canvas 的节点 / 生成实现；不另存一份 Workflow；不把宿主连接设为前提 |
| **Agent** | Agent 连接与状态管理 | runtime、模型 / Provider 路由、外部 Agent（Codex、Claude Code、DSH…）的发现 / 准备 / 健康 / 每个 Agent 的状态、Skill 安装 | 不放对话、不放 run 编辑；最多只读“最近 run”跳转 |

**交接（hand-off）**：

~~~text
Agent 页 ──供应──▶ Iris：可用的 Agent（内置 / 外部）、模型路由、预算授权方式
Iris ──调用──▶ Canvas：workflow.inspect / apply / node.run / viewport.set（以光标动作可见地执行）
Iris ──调用──▶ Generation & Runtime：生成任务、渲染、转写（同一任务函数）
Canvas ──交给──▶ Iris：选中节点 → “交给 Iris”，带选中节点作为上下文开启或续接 run
Canvas Assistant drawer ──交给──▶ Iris：轻量问答就地完成；多步制作一键“在 Iris 中继续”，进入同一个 run
外部 Agent（经 CLI / MCP）──▶ 同一 run：其写入作为带 caller 徽标的 Step 出现在 Iris trace
宿主连接器（可选，Resolve 先）──上下文──▶ Iris：当前项目、时间线、选择、素材、标记（只读起步；写回走 14 号文档的安全输出）
~~~

规则：
- **一套业务实现**：Iris 不实现生成、节点、素材；它调用 Canvas 与 Runtime 的同一命令（AGENTS §3）。光标只是这些调用的可视化，不是第二条写入路径。
- **一个 run，一个主场**：run 只在 Iris 里展开（对话栏 + 画布）；Canvas 抽屉与外部 Agent 只显示 run 条 / 活动条并跳转。
- **画布是同一张**：Iris 打开的画布就是该项目的 Workflow；切回 Canvas 看到的是同一批节点（带 run 分组与 `origin=agent`）。
- **对话优先，但不是纯聊天页**：Iris 的入口与主线是对话；每个 run 的计划、素材与版本必须落到画布上可见、可改。没有画布产出的回复只用于问答（AGENTS §2）。
- **连接器可选**：没有连接任何宿主时 Iris 完整可用（素材拖入 / 上传）；连接后只是少一步上传，不改变交互主线。

## 12. Iris · 个人 Agent 工作区（设计目标）

> 2026-11-17 起：逆向改名 **Iris**，交互从“prompt 首页 + 画布主体、对话只在侧栏”改为 **Hark 式对话优先 + 画布为产出面**。§12.1、§12.2、§12.5、§12.9–§12.11 已按新方向重写；§12.3–§12.4、§12.6–§12.8 的光标、飞入、播放、对比规则不变。原型（§21）仍是旧的“侧栏对话”版本，**待重画**。现状：tab 是 coming-soon 占位（标签带“优化中”），以下全部是设计目标。
> 依据：用户提供的理想交互视频（关键帧：prompt 首页“今天想做点什么？”→ 拖入参考视频并输入“用代码把这个视频复刻出来”→ 无限网格画布上多个带标签的光标（“我”“字体”“行动”）放置像素素材、文字层“curiosity.”、参考帧卡并组装 → 播放成片）。动效数值见 [DESIGN.md](DESIGN.md) §14；原型见 §21。

### 12.1 对话首页（idle）

| 元素 | 规格 |
| --- | --- |
| 标题 | display 20/28 “今天想做点什么？”（随 i18n） |
| 输入框 | 居中，宽 `min(640px, 100%)`；多行；左下 `+` 附件、`@` 引用画布节点 / 素材 / 已连接宿主的当前选择；右下发送（同位变停止） |
| 附件拖入 | 拖入视频 / 图片 / 文本 / 链接时整框虚线 mint 边 + `--isl-mint-bg`，松手后附件卡以 snappy 进入输入框上方（缩略图 + 时长 / 尺寸 + 移除）；大文件显示导入进度，导入中仍可编辑文字 |
| 宿主上下文 chip | 输入框上方一枚小 chip，见 §12.11：已连接时显示“Resolve · 当前时间线”，可点开选择要带入的范围；未连接时不显示 chip，只在 `+` 菜单里有“连接剪辑软件（可选）” |
| 示例卡 | 输入框下 3 张叠放示例（“复刻这个视频”“把截图做成宣传片”“给这段音频配画面”），点击只填入不发送（参考 Inspora R4） |
| 最近对话 | 下方一行：最近 3 个对话 / run 的名称 · 状态 · vN，点击回到该对话与画布 |
| Agent / 模型 | 输入框内右侧小 chip：当前 Agent 与模型（来自 Agent 页）；未配置时 chip 变 sun 并点击去 Agent 页配置（§6.6） |

状态：空 → 有输入 → 拖入中 → 附件导入中 → 可发送 → 规划中（planning，输入框锁定为只读并显示“正在规划…”，可取消）。纯问答（不需要产出）在对话里直接回答，不打开画布。

### 12.2 开始产出：对话首页 → 对话栏 + 画布（转场）

1. 发送后首页的输入框与第一轮对话原位移到左侧对话栏（smooth，FLIP：记录首末位置，只动 transform / opacity；参考 GSAP G2、G4）。对话仍是主线：用户继续在对话栏输入、追问、改要求。
2. 画布网格在右侧从中心淡入并以 0.98 → 1 缩放到位（smooth）；附件作为第一个元素“参考帧卡”以 expressive 落在画布左上（参考 Inspora R8 的落定、G1 的元素落入）。
3. 计划卡（awaiting_approval，§19.2）作为一条消息出现在对话里，同时在画布上画出计划的流程带骨架（§19.1）。
4. 总时长 ≤ 600ms；减弱动效时为 120ms 交叉淡化，无位移。
5. 返回：对话栏顶部“← 首页”回到对话首页，run 在后台继续（首页“最近对话”显示进度）。
6. 窄容器（< 900px）：对话与画布上下切换（segmented：对话 / 画布），产出到画布时对话里出现“在画布中查看”的缩略卡。

### 12.3 多 Agent 光标

| 方面 | 规则 |
| --- | --- |
| 谁有光标 | 每个**正在写画布或产物**的执行者一个：主编排、子 Agent（字体 / 版式、素材 / 生成、合成 / 行动、评审）、外部 caller（codex、claude-code、dsh）。只读工具（inspect、frames 抽取）不产生光标 |
| 标签 | 角色名 pill（“我”= 用户本人时不显示；“字体”“行动”“素材”“评审”…），名称来自 run 的 Step caller / 工具注册表元数据，不在组件写死 |
| 颜色 | 每个角色一个派生色（DESIGN §4 光标色），run 内稳定；同屏 ≤ 6 色 |
| 动作映射 | `workflow.apply` 新增节点 → 光标移到落点、按下（光标缩到 0.9 再回 1，snappy）、元素出现（§12.4）；移动 / 对齐 → 光标拖着元素走；改文字 → 光标停在文本层，显示 I 形光标与逐字输入；`viewport.set` → 只平移视角，不出光标；`node.run` → 光标点节点的运行按钮，节点进入生成态 |
| 运动 | 位移用 smooth 弹簧（可被新目标打断、保持速度）；路径为直线，不画轨迹；距离 > 800px 时先淡出、在目标附近 80px 处淡入（避免横穿屏幕）；速度上限约 1600 px/s |
| 碰撞 | 两个光标目标距离 < 32px 时，后到者沿 45° 偏移 24px 停靠；标签互相遮挡时后者标签翻到左侧 |
| 空闲 | 无动作 2s 后光标降为 60% 不透明；10s 后收回到对话栏对应 Step 行的头像位置（淡出）；有新动作再从那里出现 |
| 视野外 | 光标在视口外时，视口边缘显示同色小箭头 + 标签，点击平移到它 |
| 用户抓取 | 用户按下某元素（或框选含该元素）时：正在操作它的光标立即停下、标签变“等待你”（虚线边），该 Agent 的**此元素相关** Step 暂停；用户松手 1.5s 后无进一步编辑则 Agent 读取新状态（`expectedRevision` 已变）重新计划这一步并继续；用户在该元素上的修改写入 trace（caller=user），Agent 不得回滚。其他光标不受影响 |
| 用户让路 | 对话栏“暂停全部 Agent”一键冻结所有光标（标签变灰）；“接管此步”把当前 Step 转为手动并结束其光标 |
| 减弱动效 | 光标不移动，直接出现在目标处并显示 300ms 静态描边；标签照常 |

参考：Inspora R10 fluid tooltip（单实例标签滑动跟随）、R14 agent dashboard（委派后的“thinking”小 pill）；GSAP G2（FLIP 式飞入定位）。

### 12.4 元素飞入与组装

- **来源点**：元素从产生它的地方飞出——生成结果从对应生成节点 / 光标位置；素材从对话里的附件 / 素材区；参考帧从参考帧卡。
- **轨迹**：transform 平移 + 0.96 → 1 缩放 + 透明度 0 → 1，expressive 弹簧；同批元素错开 60ms（最多 8 个，其余直接出现）。
- **组装**：版式子 Agent 对齐时，元素同时以 smooth 移到网格对齐位，出现 1px 对齐参考线（mint 40%）300ms 后消失；文字层逐词由模糊到清晰（参考 Inspora R18、GSAP G1 的 SplitText 式揭示，用 CSS / motion 实现，不引入 GSAP）。
- **选中框**：正在被操作的元素显示该 Agent 色的 1px 框 + 手柄 + 左下属性标签（如“字体：思源黑体”“拆帧”）。
- **不做**：彩纸、旋转飞入、3D 翻转、持续漂浮。
- 减弱动效：直接出现（120ms 淡入），对齐参考线保留。

### 12.5 对话栏与 trace 同步

- 位置：画布左侧停靠，宽 `clamp(360px, 32vw, 480px)`，可拖宽、可收起为 40px 竖条（仍显示 run 进度点）；窄容器见 §12.2 第 6 条。顶栏玻璃，正文实底（DESIGN §9.2）。
- 结构：**对话**是主体（消息、附件、宿主上下文 chip、输入框常驻底部）；**计划卡**（Plan / Step 清单与审批，§19.2）与 **run 卡片**作为对话消息出现；**运行**（trace，§16.3）与**逆向拆解**（§12.8）是从 run 卡片展开的子面板，不另起顶层分区。待处理托盘同 §19.4。
- **悬停 Step → 高亮元素**：trace 行 hover / 键盘聚焦时，画布上该 Step 产出或修改的元素显示该 caller 色 2px 外描边并轻微提亮（120ms），视口外的元素在边缘显示箭头；点击行平移到元素（smooth）并选中。
- **悬停元素 → 高亮 Step**：画布元素 hover 时，对话栏中最近修改它的 Step 行或消息左侧出现同色竖条；元素右键“查看来源 Step”“在对话中引用”。
- 实时：新 Step 行 snappy 进入；运行中的行显示该 caller 光标色的进度条。

### 12.6 预览播放器

- 入口：Render 站 / 版本条 / 对话中的“播放 vN”；在画布上以浮层打开（不离开画布），尺寸按成片比例、最大占视口 70%，背景画布暗化 40%。
- 控件：clear 玻璃控件条（播放 / 暂停、时间码 tabular、逐帧 ←/→、速度、循环、全屏）；时间轴上显示评审 findings 钉（sun）与镜头分段（细分隔），点击钉跳到该时间并在对话栏展开该 finding。
- 空格播放 / 暂停，J/K/L 倒放 / 暂停 / 快进，Esc 关闭；关闭后回到原视角。
- 渲染中打开：显示最近一版 + “v3 渲染中 62%”角标，渲染完成后提示切换（不自动切换）。
- 失败：播放器内显示原因与“重新渲染”。

### 12.7 版本对比

- 版本条（v1 … vN）在播放器下方与 Render 站；评审轮次 `r1 revise → r2 revise → r3 pass` 与版本一一对应。
- 选两个版本 → 对比模式：**分屏滑杆**（默认）/ 并排 / 差异叠加；两个播放头锁定同步；可锁定到某条 finding 的时间点。
- 每个版本显示：由哪个 Step / 哪条 finding 产生（fixedBy）、改了哪些层、费用；被否版本标 rejected 保留。
- 锁定 / 解锁片段与素材规则同 §19.3。

### 12.8 逆向拆解（Hypit 式）作为工具与面板

- 工具：`reverse.transcribe`、`reverse.align`、`reverse.timeline`、`reverse.tracks`（命名以 [11](11-iris.md) 与命令注册表为准）——由主编排在需要“复刻参考视频”时调用，各自作为 Step 出现在 trace。
- 面板：run 卡片展开的“逆向拆解”子面板显示 Script（三栏）、转写证据、对齐结果与 Timeline（字幕 / 视觉 / 音频轨）；点击 Timeline 片段 → 画布上对应的参考帧卡与生成元素高亮。
- 不再是独立工作台：原“逆向工程转为 Canvas 子画布”的单次 `workflow.apply` 出口保留为一个工具（“同步到画布”），由 run 调用或用户在面板中点击。

### 12.9 Canvas 抽屉的去留

**建议保留为轻量上下文入口**：Canvas 右侧 Assistant drawer 继续承担“就地问答 / 单步操作”（解释节点、改一个提示词、跑一个节点），不展开多步 run；当请求需要多步制作或 run 已存在时，抽屉显示 run 条与“在 Iris 中继续”，点击后带当前选中节点切到 Iris，进入**同一个 run**（同一 runId，不复制会话）。抽屉的“运行日志”分区改为只读 run 列表跳转。

### 12.10 状态与出口

| 状态 | 用户看到 | 主动作 | 出口 |
| --- | --- | --- | --- |
| 首页空 | 标题 + 输入框 + 示例卡 + 最近对话；无宿主连接时不提示连接 | 发送 | 打开最近对话 |
| 规划中 | 输入框只读“正在规划…” | — | 取消 |
| 待批准 | 对话里的计划卡 + 画布上的流程带骨架 | 开始制作 | 在对话里改 / 取消 / 回首页 |
| 运行中 | 光标在画布上工作；trace 实时 | — | 暂停全部 / 停止 / 接管此步 |
| 用户抓取 | 对应光标“等待你” | 继续编辑 | 松手后 Agent 重新计划此步 |
| 待确认（费用 / 解锁） | 岛与对话同时提示 | 确认 | 修改 / 跳过 / 停止 |
| 评审中 | 播放器 + findings 钉 | 接受修补 | 改意见 / 手动接管 |
| 完成 | vN pass；“播放 / 归档” | 播放 | 再来一轮 / 回 Canvas 看节点 |
| 失败 / 阻塞 | 失败 Step 展开原因 | 重试此步 | 跳过 / 停止 |
| Agent 断开 | 光标灰化“已断开”；已提交任务继续 | 重连（去 Agent 页） | 换 Agent 续跑 |
| 刷新恢复 | “正在恢复 run…” | — | 回首页 |
| 宿主断开 | 上下文 chip 灰化“Resolve 已断开”；已带入的上下文快照保留在对话里 | 继续（用已带入的上下文或改为上传） | 重连 |

### 12.11 宿主上下文连接器（可选）

- **不是前提**：Iris 的每个状态都不要求先连宿主。首页、空态与错误文案都不出现“请先连接剪辑软件”；连接入口只在 `+` 菜单与 Agent 页。
- **顺序**：DaVinci Resolve 先（native MCP / Scripting），Premiere（UXP）、剪映 / CapCut 后续。剪映 6.0+ 草稿加密，外部可能读不到（**待验证**）；CapCut 国际版草稿格式待核对（**待验证**）。见 [14](14-creative-hosts.md) §7。
- **chip 状态**：未连接（不显示）· 连接中（spinner + 宿主名）· 已连接（宿主名 + 当前项目 / 时间线；点开选择带入范围：当前选择 / 当前时间线 / 标记区间）· 只读（默认，chip 带小锁）· 断开（灰化，见 §12.10）。
- **带入是显式且可见的**：发送时把带入的上下文作为一条可展开的“上下文快照”附在消息上（项目名、时间线、片段数、时间范围），用户可在发送前移除；不在后台静默读取整个工程。
- **写回**：Iris 不直接改宿主时间线；产物先在画布上比较、选定，再按 14 号文档的安全输出送回（Resolve 先 Add to Media Pool），按钮文案用动词（§7）。
- 宿主连接管理（安装、配对、健康）在 Agent 页，不在 Iris 对话里展开。

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

## 16. Agent run 与 trace 的 UI 状态（与 [16 号提案](16-agent-video-pipeline.md) 一致）

> 本节是交互规格；run / trace 的数据模型与权威（Runtime 保存 run → step → tool call → artifact → version → review round）以 16 号提案为准。被接受前为**设计目标**。

### 16.1 放置

- **Iris 是 run 的主场**（2026-11-13 定案，覆盖 PR #45 的抽屉方案；2026-11-17 改为对话优先）：对话栏里 run 卡片展开的“运行”子面板按 run 显示**实时 trace**，计划卡显示 Step 清单与审批；画布上是同一份可见生产状态与 Agent 光标；顶部居中有 run 状态岛（§16.2）。
- **Canvas Assistant drawer**：只显示 run 条与“在 Iris 中继续”（§12.9）。
- **Agent 页**：不显示对话和 trace，最多只读“最近 run”跳转。
- 外部 Agent 驱动时：其写入作为带 caller 徽标的 Step 与光标出现在 Iris；Canvas 只显示活动条与待确认项，对话留在外部 Agent（§6.2）。

### 16.2 run 状态岛（设计目标，参考 Inspora *dynamic release island*）

| 形态 | 内容 | 进入 / 切换 |
| --- | --- | --- |
| 收起 pill（34px 高） | run 名 · 当前 Step · 第 N 轮 · 进度扫光（填充 pill 底色）· 已花费 | 出现：expressive；进度：smooth 插值 |
| 展开面板（点击 / 键盘 Enter） | Step 列表（每步 tool、caller、状态、耗时、产物缩略）、当前版本 vN、待确认项、“在对话中查看” | smooth；Step 逐条 snappy 淡入，间隔 30ms，最多 8 条 |
| 待确认 | pill 变 sun 边，显示“需要确认 · 预计 ¥x” | expressive 一次 |
| 完成 | 扫光填满 → 打勾 → 3s 后收为“已完成 vN · 打开” | 打勾 ≤ 300ms，无粒子 |
| 失败 / 阻塞（block） | coral 边；“第 3 步失败：原因”；主动作“查看 / 重试此步” | 无抖动 |

岛是浮动 chrome（玻璃头部 + 实底列表，DESIGN.md §9.2），可拖到画布四角，可收起为一个点；不遮挡选中节点（与选中节点包围盒相交时自动让位）。

### 16.3 trace 视图（Iris run 卡片的“运行”子面板）

| 区域 | 内容 |
| --- | --- |
| run 头 | run 名、状态、轮次 `round 2/5`、预算 `已用 ¥12 / 上限 ¥40`、caller 分布 |
| Step 行 | 状态图标 · tool 显示名（来自注册表）· caller 徽标（built-in / codex / claude-code / dsh / user，颜色同其光标）· 耗时 · 产物缩略 · 费用；hover 高亮画布元素，点击定位到节点 / 帧（§12.5） |
| 分段进度 | 一个 run 一条横向分段条，每段一个 Step：灰 = 未开始、mint = 成功、coral 标记 = 失败、斜纹 = 运行中（参考 Inspora *tests visualised*） |
| 版本与评审 | `v1 → v2 → v3` 链；每个版本下挂 ReviewRound：findings（时间点 / 片段、层、问题、修法）、结论 pass / revise / block、fixedBy |
| 过滤 | caller、状态、仅看失败；chip 带计数 |

状态与出口：

| trace 状态 | 显示 | 出口 |
| --- | --- | --- |
| 无 run | 空态：一句话 + “在对话里说出要做什么” | 聚焦输入框 |
| running | 实时追加 Step；新 Step 自动滚到可见，用户手动上滚后停止自动滚动并显示“有 N 条新步骤” | 停止 run；查看画布 |
| awaiting_approval | 顶部固定确认卡（预算、范围），对话中同步出现 | 确认 / 修改 / 取消 |
| failed step | 该行展开原因与建议 | 重试此步 / 跳过 / 停止 |
| review: revise | 显示 findings 与将修改的片段（locked 片段带锁） | 接受修补 / 改意见 |
| round limit / 连续两轮相同 | 停止并报告卡点 | 提高上限（需确认）/ 手动接管 |
| 刷新恢复 | “正在恢复 run …”，读取后从最后未完成 Step 继续 | — |
| 外部 caller 写入 | 新行带 caller 徽标即时出现（例如 CLI 提交的 user review） | — |

现状：Canvas 抽屉的“运行日志”分区是 `AgentActivityPanel`（`view="log"`）的扁平列表，数据来自内存 200 条的 `useAgentActivityStore`，重启后清空、不按 run 分组（问题与改造见 §19.4）。

## 17. 空态与加载

| 场景 | 现状（代码） | 规范 |
| --- | --- | --- |
| Iris 首页 | coming-soon 占位（`App.tsx`，“优化中”） | §12.1：标题 + 输入框 + 叠放示例卡（点击只填入）+ 最近对话；无宿主连接时不出现连接提示 |
| Canvas 抽屉空会话 | `AgentEmptyState`：标题 + 4 个快捷入口（感知画布、爆款预设、上传故事、批量优化） | 保留为轻量入口；多步类入口（爆款预设、上传故事改编）改为“在 Iris 中开始”；入口列表来自 Skill 注册表 |
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

## 19. 产品交互模式（设计目标）

> 以下六项是**设计目标**，给出状态、转换、空 / 错误态与到现有代码的映射。实现时按 AGENTS.md 先改 contract 再改实现；涉及 run / trace 的部分以 [16 号提案](16-agent-video-pipeline.md) 被接受为前提。参考来源编号见 §20。

### 19.1 视频制作流视图（pipeline flow）

目标：把 brief → 脚本 → 分镜 → 生成 → 渲染 → 评审轮次**画在画布上**（Iris 的产出面，§12），同一条 run 的实时 trace 在 Iris 对话栏的 run 卡片里；用户随时能看到“现在在哪一站、这一站产出了什么、下一站等什么”。

**画布形态**：一个 run 是一个横向“流程带”（复用 `subgraph` 节点与 `batchId` 分组，不新建第二套图）：

~~~text
[Brief] → [Script] → [Shots ×N] → [Generate ×N] → [Render vN] → [Review r1…rK]
   │          │           │              │               │              └─ findings 钉在成片时间轴上
   └ artifact └ 三栏脚本   └ shot.index 排序 └ 每镜候选堆叠  └ 版本条 v1…vN
~~~

| 站点状态 | 视觉 | 转换 | 出口 |
| --- | --- | --- | --- |
| pending | 灰色站点、虚线入边 | 上一站成功 → ready | — |
| ready | 实线入边、站点 hover 显示“运行此站” | 用户 / Agent 运行 → running | 跳过（需确认） |
| running | 入边有流动点（1 个点，1.2s，减弱动效时静止）；站点内分段进度；执行它的 Agent 光标停在站点旁 | → succeeded / failed / awaiting | 停止此站 |
| awaiting_approval | sun 边、费用徽标 | 确认 → running | 修改 / 取消 |
| succeeded | mint 勾、产物缩略；站点宽度不变 | 下游变 ready | 重跑（产生新版本） |
| failed | coral 边、原因一行 | 重试 → running | 跳过 / 停止 run |
| stale | 上游改动后显示“已过期”（`workflow-node__stale-badge` 已实现） | 选择性重跑 | 保持旧结果 |
| locked | 锁图标；修改需显式解锁并写入 trace | 解锁 → ready | — |

- **评审轮次**：Review 站展开为横向轮次条 `r1 revise → r2 revise → r3 pass`；每条 finding 是成片时间轴上的钉（atSec / range），点击跳到该帧并在 Render 站显示 vN 与 vN-1 的对比（§19.3）。
- **焦点跟随**：run 运行时，画布不自动移动视角；只在用户点击岛或 trace 行时用 smooth 平移到站点。
- **空态**：无 run 时流程带不出现；Iris 首页示例卡“做一条产品宣传片”点击填入 brief 模板。
- **错误态**：依赖缺失（ffmpeg / Remotion / WhisperX 未就绪）显示 `CAPABILITY_UNAVAILABLE` 的人话版 + “打开 Agent 页诊断”；不静默跳过站点。
- **代码映射**：分组 `components/workflow/WorkflowNode.tsx`（`SubgraphFrameSurface`、batch 折叠）、`shotAssembly.ts`、`services/shotPlanning.ts`（`shot.index`）、`runState.ts`；节点 metadata 记 `runId` / `version`（16 号 §4.2）；trace 读取 `pipeline.run.get`（提案）。
- **参考**：R1 dynamic release island（站点进度扫光）、R2 tests visualised（分段进度 + 失败标记 + 重跑修复）、R18 spreadsheet UI（脚本 / 分镜表的逐行揭示）、Figma F1（平移用弹簧、可打断）。

### 19.2 Agent 计划与待办（run plan / step checklist / approvals）

现状：**2026-11-20 已整体移除执行计划（任务清单）**——`iris_todo` 工具、`AgentTodoCard`、`agentTodo.ts` 与提示词里的清单规则都已删除，`flovart_todo` 只作弃用的无操作别名保留；以下为移除前的记录。原实现：模型通过 `iris_todo` 工具提交清单，`components/agent/AgentTodoCard.tsx` 只读渲染（pending / active / blocked / done 四态，active 用旋转图标）；付费 / 删除走 `AgentConfirmCard`；自动模式授权走 spend mandate（`agentSpendMandate.ts`）。

问题：清单与 run 无关联（只是最近一次工具结果）；`active` 的旋转图标没有 reduced-motion 处理；卡片 12px 圆角与内联样式绕过 token；`--isl-line` 未定义；确认卡与清单分离，用户看不出“哪一步在等我”。

设计：

| 区块 | 内容 | 规则 |
| --- | --- | --- |
| Plan 卡（awaiting_approval） | 目标一句话 · 步骤预览（≤ 8 条，超出折叠）· 预计任务数 / 金额 / 最大评审轮数 · 将使用的模型 | 一次确认整个 run 预算（16 号 §4.1 费用规则）；主按钮“开始制作” |
| Step 清单 | 每步：状态图标 · 标题 · caller · 耗时 · 产物数；`blocked` 行内显示原因与动作 | 清单项 = trace 的 Step 投影，不是模型自报；模型只能写“计划”，完成状态由命令边界回填 |
| 行内审批 | 需要确认的步骤直接在该行展开确认（金额、范围、改动列表），与对话中的确认卡是同一个请求 | 任一处确认即生效，另一处同步（§4.3） |
| 委派 | 某步可“交给外部 Agent”（例如 `capture.ui` 前的截图录屏），行内显示“Claude Code 正在处理”小岛 | 参考 R14 agent dashboard 的 Delegate → thinking pill |
| 进度 | 头部 `3/8` + 分段条 | 新完成项打勾一次；不划掉正在读的行，已完成行降低对比度到 ink-soft（不删除线） |

| 状态 | 主动作 | 出口 |
| --- | --- | --- |
| 草拟中（planning） | — | 取消 |
| 待批准 | 开始制作 | 修改计划 / 取消；超时作废 |
| 执行中 | — | 暂停 run；停止 |
| 某步待确认 | 确认此步 | 跳过此步 / 停止 |
| 某步阻塞 | 按原因：补素材 / 改参数 / 重试 | 跳过 / 停止 |
| 预算将超 | 追加预算（需确认） | 在此停止 |
| 完成 | 打开成片 / 归档 | 再来一轮评审 |

空态：无计划时不渲染卡片（现状一致）。错误态：工具结果解析失败时显示“计划不可读，已忽略”，不让卡片消失后无提示。

代码映射：`components/agent/agentTodo.ts`（解析）、`AgentTodoCard.tsx`、`AgentConfirmCard.tsx`、`agentConfirmCopy.ts`、`services/agentSpendMandate.ts`；run 关联依赖 16 号提案的 `run_steps`。

### 19.3 素材管理：库、版本 v1→vN、对比、锁定、归档、拖到画布

现状（已实现）：`components/studio/AssetLibraryBrowser.tsx`（文件夹 + 网格、标签筛选、`motion` 布局动画、批量管理 `BatchManageModal`、可拖拽）、`FolderTree.tsx`、`StudioMediaBrowser.tsx`；结果节点有 take 版本条（`OperationVersionStrip`，晚到显示“有新版本”）；批次有“设为主图”。“Agent 资产库尚未接入”为占位文案。

设计：

| 视图 | 交互 | 参考 |
| --- | --- | --- |
| 库 | 左侧文件夹树 + 右侧网格 / 表格切换（同一批记录在两种布局间以 smooth 重排，选中保持） | R6 admin dashboard、R13 Folders UI |
| 文件夹预览 | hover / 打开文件夹时前 3 张缩略图从卡片内扇出（snappy，减弱动效时静态排列） | R9 interactive folder cards |
| 筛选 | 类型 / 来源（上传、生成、run）/ 状态（final、locked、rejected）chip，带计数 | R3 UI dropdown filter（只取“状态 + 计数”） |
| 版本条 | 素材详情底部 `v1 v2 … vN`；当前选中实心，晚到新版本带点；悬停预览缩略 | 现有 `OperationVersionStrip` 推广到素材 |
| 对比 | 选两个版本 → 分屏滑杆（左右拖动分界）/ 并排 / 叠加差异；视频对比同步播放头，可锁定到某条 finding 的时间点 | Apple Feedback：状态就近 |
| 锁定 | 版本或片段（镜头、声线、字体）可锁；锁定后 Agent 修补必须显式解锁并写 trace（16 号 §5） | — |
| 废片 | 被否版本标 `rejected` 保留，默认隐藏，筛选可见，显示被否原因 | 16 号 §5“废片库” |
| 归档 | run 完成后“归档”生成 final / spec / stems / rejected / reviews / manifest；进度卡显示文件数与大小 | R16 photo download UI |
| 拖到画布 | 拖出时缩略图跟手（snappy），画布显示落点；松手 expressive 落定；拖入的是引用还是副本按来源语义（[10](10-canvas-workflow.md) §3） | Apple Motion：跟随手势 |

| 状态 | 显示 | 出口 |
| --- | --- | --- |
| 空库 | “这里还没有资产” + 导入 / 从画布收集 | — |
| 筛选无结果 | “没有匹配的资产” + 清除筛选 | 清除筛选 |
| 本地文件夹失效 | 卡片灰化 + “重新定位”（按 ID，不按文件名猜） | 重新授权 |
| 对比的两版不同规格 | 提示分辨率 / 时长不同，按较短者对齐 | 换版本 |
| 解锁 | 二次确认，说明将影响哪些下游 | 取消 |
| 归档失败 | 已写部分保留，列出失败文件 | 重试失败项 |

### 19.4 Assistant drawer 改造（`IrisAgentPanel` / `AgentDrawerSections`）

> 2026-11-13 放置定案后：下面“改造后的设计”整体用于 **Iris 对话栏**（§12.5，2026-11-17 起对话为主体）；Canvas 抽屉保留同一组件的轻量模式（对话 + run 条 + “在 Iris 中继续”，§12.9）。审计问题 D1–D12 对两者都成立。

**现状审计（代码事实）**：

| # | 问题 | 位置 |
| --- | --- | --- |
| D1 | 整个抽屉（含对话正文）是玻璃：`blur(24px) saturate(150%)`、卡片底 78% 透明；暗色用冷色 `rgba(28,29,34,.78)`；停靠卡片圆角 16px（token 上限 10px） | `styles/adaptive.css` `.compact-right-panel[data-docked='true']` |
| D2 | 四个分区（对话 / 连接指引 / 连接状态 / 运行日志）藏在 Logo 下拉菜单里，没有可见的分区切换，“运行日志”难发现 | `AgentDrawerSections.tsx` `AgentLogoMenu` |
| D3 | “连接指引 / 连接状态”属于 Agent 连接中心职责，与抽屉“只放上下文助手”的边界重叠 | 同上；`AgentHostPicker`、`AgentActivityPanel view="status"` |
| D4 | 运行日志是扁平列表：不按 run 分组、内存 200 条、重启清空，`max-h-[420px]` 内嵌滚动造成双滚动 | `AgentActivityPanel.tsx`、`stores/useAgentActivityStore.ts` |
| D5 | 工具调用消息默认可展开原始 JSON（`<pre>{JSON.stringify(detail)}</pre>`）；pending 用 `CircleAlert`（警告形）表示“等待执行” | `components/workflow/WorkflowAgentMessages.tsx` `ToolMessage` |
| D6 | 运行中只有一行“Agent 正在处理...”，没有当前步骤 | `WorkflowAgentMessages` |
| D7 | 命令显示名在组件内维护第二份中英映射 `COMMAND_LABELS`，违反 §3 | `AgentActivityPanel.tsx` |
| D8 | 颜色与样式绕过 token：`#e5484d`、内联 `borderRadius: 12`、`rounded-xl`、未定义的 `--isl-line` | `AgentActivityPanel`、`AgentTodoCard` |
| D9 | 硬编码中文：模式菜单说明“删除、付费生成…始终单独确认”、引用选择器“引用节点或我的素材”、发送 / 停止的 `aria-label` | `IrisAgentPanel.tsx` |
| D10 | 待办卡、确认卡、ask 卡、分组横幅在消息与输入框之间各自堆叠，最多同时出现 4 张卡，挤压对话区 | `IrisAgentPanel.tsx` 1022–1060 行 |
| D11 | 动效：`.compact-right-panel` 对 width 做 3.4% 过冲弹簧；状态图标 `animate-spin` 无减弱处理 | `styles/agentPanelLibtv.css`、`AgentTodoCard` |
| D12 | 1207 行单组件持有 20+ 个 `useState`（会话、确认、ask、mandate、模式、引用、附件、模型、分组…），状态互相影响难以验证 | `IrisAgentPanel.tsx` |

**改造后的设计**：

~~~text
┌ drawer 顶栏（玻璃）：项目名 · [对话 | 运行] 分段 · 会话历史 · 新建 · 收起
├ run 条（有 run 时出现，实底）：岛的紧凑形态 —— 当前步骤 · 轮次 · 花费 · 展开
├ 正文（实底，唯一滚动容器）
│   对话：消息 · 工具摘要行（人话）· run 卡片（嵌在对话流中）
│   运行：trace（§16.3）
├ 待处理托盘（最多 1 张可见，其余计数）：确认 / 提问 / 计划 —— 按紧急度排队
└ 输入区：附件 · @引用 · 模型 · 模式 · 发送/停止（同一位置）
~~~

| 改造 | 解决 | 映射 |
| --- | --- | --- |
| 顶栏可见分段 `对话 | 运行`；“连接指引 / 连接状态”移到 Agent 页，抽屉内只在断连时给一行“打开连接中心” | D2、D3 | `AgentDrawerSections` 的 `SECTIONS` 收为两项；`AgentHostPicker` 只在 Agent 页挂载 |
| 顶栏玻璃、正文实底、停靠圆角 10px、暗色用暖色 | D1 | DESIGN.md §9.2 |
| “运行”分区 = trace，按 run 分组，数据来自 Runtime（16 号），非 run 的零散操作归入“其他操作”折叠组 | D4 | `AgentActivityPanel` 改为读 run；`useAgentActivityStore` 降为实时缓冲 |
| 工具消息默认一行人话摘要（来自注册表显示名 + 结果摘要），原始参数进“诊断”折叠；pending 用 `Clock` | D5、D7 | `ToolMessage`；显示名从 `tools/iris/registry.js` 元数据读 |
| 运行中显示当前步骤（与岛同源），而不是“正在处理” | D6 | run 条 |
| 待处理托盘：同一时刻只展开 1 张卡，按 `确认 > 提问 > 计划` 排序，其余显示“还有 2 项” | D10 | `pendingAsk`、`confirmation`、`todoItems`、`groupBanner` 合并为一个队列 |
| token 化与 i18n | D8、D9 | DESIGN.md、`t()` |
| 抽屉开合改 `--spring-smooth` 且只动 transform / opacity；所有旋转图标接 reduced-motion | D11 | DESIGN.md §14 |
| 把会话、待处理队列、输入草稿拆成三个 reducer / hook，组件只组合 | D12 | 不新增 Manager 层（AGENTS §3），只是同文件内拆函数 |

状态与出口：未连接 → 输入框只读提示 + “重试连接”；需要 Key → setup 卡（§6.6）；生成中 → 发送键变停止；断线 → run 条显示“已断开，任务在后台继续”；会话恢复 → 骨架消息 ≤ 3 条。

参考：R1（岛）、R2（trace 分段）、R4（空态示例卡）、R14（委派小岛）、R10 fluid tooltip（顶栏图标按钮的跟随 tooltip 与快捷键）、Apple A2（材质分层）、Figma F3（浮动面板遮挡内容的教训）。

### 19.5 画布节点：过时交互审计与现代化

| # | 过时交互（现状） | 位置 | 现代化交互 |
| --- | --- | --- | --- |
| N1 | 图片工具（裁剪、滤镜、扩图、蒙版、拆分、旋转、宫格、标注、重打光、风格化、矢量化、移动、分镜、图层…）全部走 antd `Modal` 对话框，遮住画布与上下文 | `WorkflowImageToolDialogs.tsx`（601 行）、`WorkflowVideoToolDialogs.tsx`、`WorkflowAudioToolDialogs.tsx` | **就地编辑**：参数在节点旁的锚定 popover（玻璃 thick），几何类（裁剪 / 扩图 / 蒙版 / 移动）直接在节点画面上操作，Enter 应用、Esc 取消；只有破坏性“替换原图”才确认 |
| N2 | 4 个工具（反推提示词、滤镜、扩图、蒙版）尚未迁入 Operation Registry，标签硬编码中文 | `nodeToolCatalog.ts` | 迁入 registry 后统一产出带生成记录的结果节点与 take 版本；标签来自 registry |
| N3 | 失败只显示一个 18px 红色“!”徽标，原因藏在 `title` 悬停提示里；另有一段覆盖在媒体上的错误条 | `WorkflowNode.tsx` `workflow-node__error-badge` / `generation-error` | 节点底部状态条：图标 + 一行原因 + “重试 / 改参数”；原因可聚焦、可读屏；颜色用 `--isl-coral` |
| N4 | Operation 节点状态文案在组件里写死中文（“旧配方结果 / 已停止 / 执行失败 / 已完成 / 执行中 / 待执行”），`Operation 配方缺失` 未翻译 | `OperationNodeCard` | 来自 i18n；状态用 §14.3 图标 + 文本 |
| N5 | 版本条是一排 `v1 v2` 文本按钮，不能预览、不能对比 | `OperationVersionStrip` | 悬停版本即在节点画面上临时预览（松开恢复），长按 / 右键“与当前对比”打开 §19.3 对比 |
| N6 | ~~多结果是同位叠放的 N 个节点，点堆叠选中整组，只剩组工具条~~（已改，2026-11-16） | `WorkflowAlternatesDock.tsx`、`batchAlternates.ts` | 首图是原节点，其余是它的备选：总数 ≤4 为首图后的斜叠卡片（可展开成 2 列网格），更多为节点下方网格（§13.3）；“设为首图”在展开格 / 网格的悬停操作与画廊里 |
| N7 | ~~生成态：虚线框 + 2px 扫光无限循环 + 状态标签 2.4s 呼吸 + 透明度 2.2s 呼吸 + 整节点 1.8s 缩放呼吸；JS 动画绕过 reduced-motion~~（2026-11-16 已改，遗留 `.animate-card-neon-flow` 仍在 `styles/index.css`） | `WorkflowNode.tsx` → `WorkflowGenerationLoader.tsx`、`generationLoader.ts`、`styles/generation.css` | 已实现，见 §19.6“节点生成加载态”：网格（R20）+ 进度线（R21）+ 一行状态；阶段只来自真实信号；无百分比时为不确定短线；失败为贴底小卡 + 重试；减弱动效时全部静态 |
| N8 | 视频节点需先点“加载视频播放器”才可播放 | `workflow-node__video-activate` | 保留懒加载（性能），但改为悬停即预取首帧 + 悬停播放静音预览，点击进入完整控件 |
| N9 | 双击标题重命名，无可见提示 | `workflow-node__title` | 标题文字本身是可编辑字段（单击选中节点、再单击进入编辑），F2 重命名 |
| N10 | 13px 方形缩放手柄（2px 边框、mint 填充）常驻 | `.workflow-resize` | 只在选中 / 悬停时出现，8px 圆点，命中区 24px |
| N11 | 节点内分镜表（镜号 / 时长 / 场景 / 台词表格）在小节点里密集难读 | `ScriptNodeCard`、`WorkflowStoryboard.tsx` | 节点内只显示摘要（镜数、总时长、前 3 行），双击打开 Iris 逆向拆解风格的分镜视图；流式生成时逐行揭示（R18） |
| N12 | hover 抬起：`.storyboard-shot-card:hover translateY(-2px)`、`.motion-surface:hover scale(1.015)` | `styles/motion.css` | 只换边框 / 背景（DESIGN.md §14.4） |
| N13 | ~~生成信息角标（速度、Token、耗时、陈旧提示）是 4 个独立的 `blur(4px)` 小黑块~~（2026-11-16 已删除） | `workflow-node__generation-meta` 等 | 已合并进 §19.6 加载态底部的一行状态胶囊（传输明细 / 消息 + 耗时） |

### 19.6 生成动效与进度

阶段与视觉（从 `WorkflowNode` 的 `uploadStage`（probe / download / transcode / store）、`metadata.progress`、`generationLabel`、`elapsedSec` 扩展）：

| 状态 | 节点内表现 | 动效 | 出口 |
| --- | --- | --- | --- |
| queued | 骨架画面（节点比例占位）+ “排队中 · 第 3 位”（有队列信息时） | 无 | 取消 |
| submitting | 主按钮原位变“提交中”，不显示百分比 | 按钮内不确定指示器 | — |
| running · 等待供应商（进度未知） | 骨架 + 单向扫光 + 计时 `00:42` | 扫光 1.4s；减弱动效时静态 | 停止 |
| running · 进度已知 | 底部 2px 确定进度条 + 百分比；视频长任务另显示阶段（排队 → 生成 → 下载 → 转码 → 入库）与预计剩余（仅当供应商给出时） | 数值 smooth 插值，**不回退、不跳到 99% 停住** | 停止 |
| streaming（文本 / 脚本） | 逐 token / 逐行出现；脚本表格逐行由模糊到清晰（R18） | 新行 snappy 淡入 | 停止（保留已生成部分） |
| partial preview（图 / 视频） | 供应商返回中间帧时以低清预览替换骨架，角标“预览” | 交叉淡化 220ms | 停止 |
| long-running（≥ 180s） | 追加一行“已等待较久，可继续等待或停止”（现有 `staleHint`） | 无 | 停止 / 后台继续 |
| done | 结果由模糊到清晰（现有 `flv-gen-reveal` 680ms）；批量时候选依次落定，间隔 60ms | 结果揭示 + expressive 落定 | 重新生成 |
| failed | 骨架变灰，底部状态条原因 + 重试 | 无抖动 | 重试 / 改参数 |
| retrying | 状态条“第 2 次尝试”，保留上次失败原因可展开 | 同 running | 停止 |
| canceled | “已停止”；若供应商可能计费，显示提示（§4.2） | 无 | 重新开始 |
| unknown_submit | “正在确认是否已提交”，不允许重复提交 | 无 | 继续其他工作 |

**节点生成加载态（已实现，2026-11-16）**：`components/workflow/WorkflowGenerationLoader.tsx` + `generationLoader.ts` + `styles/generation.css` `.flv-gen*`。

- **网格**（参考 R20 Grid Reveal）：节点内铺满圆角小方块（`--isl-card` 方块、`--isl-surface-sunk` 缝、约 30% 格子用 `--isl-border` / `--isl-ink-ghost` 叠一档深浅），按**真实阶段**细分：准备 2×2 → 上传 / 排队 / 转码 4×4 → 生成 8×8 → 下载 / 写入 12×12；同一次生成内只前进不后退；格子小于 9px 的级别自动跳过（小节点少一级）。约 0.9s 一次深浅噪点重排（0.28s 交叉淡化），细分时格子从上一级尺寸收缩到位（0.2s 缓出）。用 canvas 绘制、`motion` 的 `animate()` 驱动，共享一个 0.9s 节拍。
- **进度线**（参考 R21 Agent Handoff 的 thin progress line）：3px 胶囊轨道 + 8px 前沿圆点（3px 同色淡光晕），mint 渐变填充；**只显示上游真实百分比**（批量按张数），0.5s 缓出前进；没有百分比时是一段 28% 的短线在轨道上来回滑（1.6s），不画假进度。
- **状态行**：底部左侧一枚胶囊：脉冲点 + 一行真实文案（传输明细 > 供应商消息 > 阶段名）+ 百分比（有时）+ 耗时（共享 100ms 计时器直接写 textContent，不触发渲染）；续接下载时前置“续接”小标。≥180s 时（≥240×190 的节点）追加“已等待较久”提示。
- **尺寸降级（容器查询）**：节点高 <96px 只留进度线；宽 <180px 隐藏耗时与“续接”；≥240×190 放大间距与字号。
- **完成**：loading → success 时同一实例切到完成态，方块按随机顺序在 0.6s 内淡出露出结果，进度线满格，状态“完成 · 总耗时”；约 1.1s 后整层淡出（减弱动效 0.6s、无动画）。
- **失败**：贴底小卡（`--isl-card` 实底、coral 边）：× 图标 +“生成失败”+ 重试（下载失败时为“重新下载”，走原 `onRun` 续接逻辑）+ 两行原因。
- **性能与减弱动效**：同屏最多 6 个节点跑网格闪动与不确定进度，其余静态；`prefers-reduced-motion` 时无节拍、无细分过渡、无滑动、无脉冲，结果直接出现。整节点不再缩放呼吸。

**长视频任务进度卡**（多镜批量 / 渲染 / 归档）：在 run 岛展开面板与 trace 中显示环形或分段进度、`已完成 7 / 12 镜`、速度与剩余（有数据时）、失败数；完成时环变勾（R16 photo download UI）。

**晚到结果（late result）**：
- 已取消或已被新任务取代的任务返回结果时，作为新 take / 新版本挂在原节点版本条末尾，带“晚到”点；**不替换**用户当前选中的版本（[10](10-canvas-workflow.md) §3）。
- 节点上出现一次性提示“有一个晚到的结果 · 查看”，3 秒后收为版本条上的点；不弹全局 toast。
- 若节点已删除：结果进入素材库“未归属”筛选，不自动重建节点。

**骨架与扫光规范**：骨架用 `--isl-surface-2` 实块、8px 圆角、与最终内容同尺寸；扫光是 `--isl-card` 50% 的 30° 渐变带，单向 1.4s，同屏最多 6 个扫光（其余静态），避免整屏闪烁。

参考：G2 Carter Ogunsola（计数到 100 的进度）、R16 photo download UI（环形进度 + 计数 + 速度 + 剩余 + 完成打勾）、R1 dynamic release island（扫光填充 pill）、R18 spreadsheet UI（逐行模糊揭示）、R2 tests visualised（失败重跑的修复状态）、R12 glass recorder（按钮原位变成进行中 pill + 停止）、Apple A4 Progress indicators（尽量用确定进度、进度要匀速、能停止）、Figma F4（短过渡可以掩盖不可避免的延迟，但不能伪造进度）。

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
| R4 | [onboarding for Anything](https://www.inspora.design/posts/onboarding-for-anything)（@jaydwivedi_） | 叠放的示例 prompt 卡依次上浮到前排 | Iris 首页与抽屉空态的示例卡（§12.1、§17） | P1 |
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
