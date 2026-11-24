# DESIGN.md · Iris

> 状态：**Current truth**（2026-11-24 按代码重写）。本文是 Iris **唯一**的视觉与动效设计文档：颜色、字体、间距、圆角、层级与玻璃、组件、奶蛙、Canvas / Cut / Agent 布局、动效与弹性布局。交互与行为（状态、流程、出口、谁能做什么）见 [01 交互设计](01-interaction.md)，本文给数值，01 引用数值。
> 来源：数值全部取自当前代码——`styles/index.css`（主题 token）、`styles/motion.css` + `components/studio/motionTokens.ts`（动效）、`styles/glass.css` / `skillHub.css` / `studioHub.css` / `ambientGlass.css`（玻璃与磨砂）、`styles/workflow.css` / `adaptive.css` / `fluid.css`（画布与布局）、`styles/cut.css` / `irisStoryboard.css`（Cut）、`styles/naiwaThinking.css` + `components/brand/`（奶蛙）。标 **待收敛** 的是代码里仍存在、但不再新增的写法；改 token 时同步改本文。
> 历史：2026-11-13 版本里的“多 Agent 光标 / 子 Agent 色”“Iris 对话首页 display 字号”属于已归档的 Personal Agent 方案（[archive/2026-11-24-agentos-alignment](../archive/2026-11-24-agentos-alignment/)），代码里没有实现，已从本文移除；需要时见 Git 历史。

## 0. Agent-native Production OS 的视觉重心（2026-11-24）

Iris 的界面首先服务于**看懂素材、审查 Agent 的改动、比较版本、决定是否应用**。Canvas 是素材/Workflow/审片空间；Cut 是已经可用的视频剪辑器；Agent 是连接/Runtime 管理；对话与上下文在现有 Canvas Assistant Drawer。不要按旧设计里的独立 Iris Personal Agent tab 实现 UI。

- **Spatial Context**：只把用户明确 Commit 的结论显示成独立 Context Card；卡片短标题、正文、来源 Chip 和「继续讨论」。不把所有消息平铺为节点，来源绑定默认隐藏，选中/悬停才高亮；Workflow 执行连线保持原意。
- **审片与提案**（目标）：用户看得见原版/候选、变更范围、Diff、费用和批准/拒绝；失败有定位、查询或恢复动作。工具日志按需展开，不抢素材画面的空间。
- **按任务出现的 UI**（目标）：镜头并排、帧段定位、字幕波形、审核卡只在需要时出现，结束后收拢为产物与回执；不加第四个导航入口。
- **视觉约束**：沿用本文 `--isl-*`、暖纸面/薄荷色、现有 `motion` 与弹性布局。素材优先、浅底高信息密度、避免装饰性图、重复标题和泛化营销文案。
- **状态透明**：明确区分 Done / Failed / Pending / Unknown，以及已实现/设计目标，不用动画制造假的进行中或成功。

§1–§16 定义视觉 token、数字、响应式规则与布局；标 **目标** 的条目尚未实现。产品状态和入口职责见 [00](00-overview.md)、[11](11-iris.md)。

## 1. Mood

Iris 是给**剪辑师、创作者和他们的 Agent** 用的本地创作台。它应当像一张**温暖的工作纸**——安静、紧凑、可信：米白纸面、炭黑墨线，只有一抹薄荷绿标记“可以按 / 正在进行 / 已选中”；面板是贴在纸上的扁平卡片，只有真正浮在画布之上的工具才轻轻透出底下的内容；动作短促、有弹性但不炫技。作品和画布永远比界面更显眼。Agent 的存在感来自一只托腮思考的**奶蛙**，而不是霓虹、流光或拟人化的大头像。

例外有两处，都是有意为之、范围受限：Canvas 右侧 Agent 对话面板的**环境光磨砂**（§9.4），以及 Cut / 故事版的**蓝紫玻璃色板**（§16.3）。

## 2. Key tokens

| 角色 | 值 | Token |
| --- | --- | --- |
| Accent | 薄荷 `#19c8b9`（暗 `#3ad9c9`），深 `#12a89b` | `--isl-mint`、`--isl-mint-deep` |
| Canvas | 纸面 `#f4f1ea`（暗 `#15140f`），24px 点阵 / 线格 | `--canvas-bg`、`.workflow-bg--dots/--lines` |
| App | `#f1ede3`（暗 `#131210`） | `--app-bg` |
| Palette | 纸 `#faf9f6` / `#ffffff`、墨 `#1f1d1a`、暖灰 `#6b6862`、发丝线 `#e3e0d8`、阳光 `#f5c31c`、珊瑚 `#e8615a` | `--isl-*` |
| Font | `"Inter", "Noto Sans SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif`（未打包字体文件，按系统回退） | `--isl-font` |
| Density | 正文 12px，控件 11px，行高 28–32px | — |
| Radius | 6 / 8 / 10px | `--isl-r-sm` / `--isl-r` / `--isl-r-lg` |
| Motion | 三档弹簧 snappy / smooth / expressive（§14），CSS 与 JS 同值 | `--spring-*` + `*-duration`、`SPRING`（`motionTokens.ts`） |
| Glass | 浮动 chrome 玻璃，`.flv-glass` | `--glass-*`（§9.2） |
| Frost / Scrim | 浮层磨砂与模态遮罩 | `--flv-frost-*`、`--flv-scrim`（§9.3） |
| Mascot | 奶蛙（Naiwa），20 / 32px 思考动画 | `NaiwaThinking`、`AgentWorkingOrb`（§16.4） |

主题：`:root[data-theme='light' | 'dark']` 覆盖同名变量；`ThemeMode = 'light' | 'dark' | 'system'`（`types/index.ts`）。DSH 内嵌时 `:root[data-dsh-embed]` 把变量映射到宿主的 `--dsw-*`（`styles/dshEmbed.css`）。

## 3. Typography

现状分布（2026-11-24 扫描 `components/` + `styles/`）：`text-xs` 206 处、`text-[11px]` 108 处；CSS 里 `font-size:11px` 171、`10px` 137、`12px` 120、`13px` 47 处——这是 10–12px 的紧凑工具界面。

| 名称 | 字号 / 行高 | 字重 | 用法 |
| --- | --- | --- | --- |
| title | 15 / 22px | 600 | 面板标题、空态标题、视图标题 |
| body-strong | 13 / 20px | 600 | 卡片标题、抽屉 / 侧栏分区标题、run 名 |
| body | 12 / 18px | 400 | 正文、对话、trace 行、表格 |
| label | 11 / 16px | 500–600 | 控件、chip、节点元数据 |
| caption | 10 / 14px | 500 | 时间戳、计数、徽标；不放需要阅读的句子 |
| button | 11 / 16px | 800（仅 `.isl-go`）/ 600 | 主按钮字重 800、字距 0.02em；其他按钮 600 |
| numeric | 同所在角色 | 同 | `font-variant-numeric: tabular-nums`：进度、计时、费用、版本号、时间码 |
| code | `ui-monospace` 10.5px | 400 | 命令、JSON；底 `--isl-surface-sunk`，圆角 4px |

规则：标题 600、正文 400；`font-extrabold` 只留给 `.isl-go`（**待收敛** 14 处）；中英混排不加字距；不使用斜体。画布上的文本层（用户 / Agent 写的标题字）是内容字体，不受 UI 字体约束。

## 4. Color roles

| 角色 | 亮 | 暗 | Token |
| --- | --- | --- | --- |
| App 底 | `#f1ede3` | `#131210` | `--app-bg` |
| 画布底 | `#f4f1ea` | `#15140f` | `--canvas-bg` |
| 面板 / 输入底 | `#faf9f6` | `#1a1917` | `--isl-surface` |
| 次级填充 / hover | `#f1efe9` | `#232220` | `--isl-surface-2` |
| 凹陷槽 | `#f4f2ec` | `#151412` | `--isl-surface-sunk` |
| 卡片 / 节点 / 弹层 | `#ffffff` | `#201f1d` | `--isl-card` |
| 正文 | `#1f1d1a` | `#f4f2ec` | `--isl-ink` |
| 次要文字 / 图标 | `#6b6862` | `#b4b0a8` | `--isl-ink-soft` |
| 占位 / 禁用 | `#a8a49c` | `#76726b` | `--isl-ink-ghost` |
| 发丝线 | `#e3e0d8` | `#3a3834` | `--isl-border` |
| 强边框 | `#cfcbc1` | `#4c4944` | `--isl-border-strong` |
| 连线 / 连线（选中）/ 连线（错误） | `#d6d2c8` / `#0f9a8f` / `#b83f3a` | `#100f0e` / `#0c8479` / `#b8463f` | `--isl-edge`、`--isl-edge-mint`、`--isl-edge-coral` |
| 强调 · 主操作 · 进度 · 成功 | `#19c8b9` | `#3ad9c9` | `--isl-mint` |
| 强调深 · 链接 · hover | `#12a89b` | `#1fb8a9` | `--isl-mint-deep` |
| 选中底 | `#e3f7f4` | `rgba(58,217,201,.14)` | `--isl-mint-bg` |
| 警示 · 待确认 · 费用 | `#f5c31c` | `#f7d04a` | `--isl-sun` |
| 失败 · 破坏性 | `#e8615a` | `#f07a72` | `--isl-coral` |
| 失败文字 | `#cf4b45` | `#e8615a` | `--isl-coral-deep` |

**遗留，不再新增**：`index.css` 里冷灰 zinc 系的 `--iris-panel-*` / `--iris-text-*` 与 `--flv-*`（rose / coral / violet / glow）。注意：Cut / 故事版的 `--iris-bg-*`、`--iris-glass*` 等是**现行**色板（§16.3），名字相近但不是这批遗留变量。**待收敛漂移**：`#6c64b0`（9 处）、`#e5484d`、`#e05252`（失败红）、`#00ff88`（生成态强调）、`rgba(28, 29, 34, …)` 抽屉暗色、未定义的 `--isl-line`（各 2 处）。

## 5. Overview

| 维度 | 规格 |
| --- | --- |
| Mood | 暖纸面、单一薄荷、扁平分层、紧凑密度（§1） |
| Layout | 顶栏三个 surface **画布 Canvas｜Cut｜Agent** + 下方主工作区；布局细节见 §16 |
| Content width | 页面型内容 `--content-max: 1280px`；表单 `--form-max: 680px`；侧栏 `--sidebar-width: clamp(220px, 24vw, 320px)`；宿主面板 280–480px |
| Grid | 画布 24px 点阵（`.workflow-bg--dots`，墨 16%）或线格（`--lines`，13%），可开关；吸附网格同 24px；页面用 `--space-*` 而非列栅格 |
| Icons | `lucide-react`（^1.20）线性图标；常用 12–18px（`size={13}` 137 处、`12` 127、`14` 82、`15` 81、`18` 66） |
| Imagery | 用户素材与生成结果是唯一的“图”；界面不放装饰插画（起始页线稿与奶蛙除外） |

## 6. Buttons

| 类型 | 类 | 规格 |
| --- | --- | --- |
| Primary | `.isl-go` | 底 `--isl-mint`、字白（暗色字 `#131210`）、圆角 8px、高 28–32px、字重 800；hover `--isl-mint-deep`；禁用底 `--isl-border-strong` 字 `--isl-card`；一个视图只有一个 |
| Chip / Toggle | `.isl-chip`、`--active` | 1px `--isl-border-strong`、底 `--isl-surface`、圆角 6px、字重 600；hover 边框与字转 mint；激活底 `--isl-mint-bg` + mint 边框 + `--isl-mint-deep` 字；计数 tabular 放右侧 |
| Ghost / Secondary | — | 1px `--isl-border`、底 `--isl-surface`、hover `--isl-surface-2` |
| Icon button | `.agent-new-chat-btn.is-icon` 等 | 28px 方形、圆角 6px、图标 14–15px、hover 底 `--isl-surface-2`；必须有 `aria-label` 与 tooltip |
| Destructive | — | 文字 / 边框 `--isl-coral-deep`；主按钮形态只在确认对话框内出现 |
| Send / Stop | `.agent-composer__send` | 同一位置切换；生成中变停止方块 |
| Segments（Cut / 故事版） | `.iris-segments` + `__pill` | 胶囊分段，选中块为白色胶囊（`--iris-pill`）滑动 |

按下不缩放、不位移；状态切换只换颜色（120–140ms）。

## 7. Iconography

- 库：`lucide-react`；不混用其他图标库；不用 emoji 充当状态。
- 尺寸：行内 12–14px、按钮 14–16px、空态 20–26px；描边 2（只在 12px 以下可用 2.4–2.5）。
- 颜色：默认 `--isl-ink-soft`；激活 `--isl-mint-deep`；状态图标按 [01](01-interaction.md) 的映射（`Clock` 排队、`LoaderCircle` 等待、`CheckCircle2` 成功、`XCircle` 失败、`ShieldQuestion` / `BadgeDollarSign` 待确认、`Lock` 锁定、`Archive` 废片）。
- Cut 子页标签用 `Clapperboard`（剪辑）与 `LayoutGrid`（故事版 · 逆向），12px。

## 8. Spacing

| Token | 值 | 用法 |
| --- | --- | --- |
| `--space-xs` | 4px | 图标与文字、chip 内 |
| `--space-sm` | 8px | 控件间、卡片内边距 |
| `--space-md` | 12px | 分组间 |
| `--space-lg` | 20px | 区块间 |
| `--shell-gap` | `clamp(12px, 2vw, 32px)` | 壳层外边距 |
| `--panel-gap` | `clamp(10px, 1.6vw, 24px)` | 面板间 |
| `--control-height-sm` / `-md` | 32 / 40px | 控件高度；紧凑行 28px |
| 控件内边距 | `px-2 py-1`（8 / 4px） | 紧凑密度 |

## 9. Elevation, glass & depth

### 9.1 三层

| 层 | 底 | 阴影 | 例子 |
| --- | --- | --- | --- |
| 0 画布 | `--canvas-bg` + 网格 | 无 | 画布 |
| 1 内容 | `--isl-card` 实底 + 1px `--isl-border` | **无** | 节点、素材卡、面板正文、表格 |
| 2 浮动 chrome | 玻璃（§9.2）或 `--isl-card` | `--isl-shadow-*` / `--glass-shadow` | 画布工具条、节点工具条、run 状态岛、左右停靠面板外壳、popover、菜单、工具弹窗、tooltip |

| Token | 亮 | 暗 |
| --- | --- | --- |
| `--isl-shadow-sm` | `0 1px 2px rgba(31,29,26,.06)` | `0 1px 2px rgba(0,0,0,.30)` |
| `--isl-shadow` | `0 2px 8px rgba(31,29,26,.08)` | `0 2px 8px rgba(0,0,0,.34)` |
| `--isl-shadow-lg` | `0 6px 18px rgba(31,29,26,.10)` | `0 6px 18px rgba(0,0,0,.40)` |

`--shadow-panel`、`--shadow-floating-*` 属旧层，不再新增。

### 9.2 玻璃（只给浮动 chrome，`styles/glass.css`）

依据：Apple Materials（玻璃是浮在内容之上的控件 / 导航层，节制使用）与 Figma UI3（浮动面板遮挡画布，正式版只保留浮动工具条）。

| Token | 亮 | 暗 |
| --- | --- | --- |
| `--glass-bg` | `color-mix(in srgb, var(--isl-card) 72%, transparent)` | `… 66% …` |
| `--glass-bg-thick`（popover，`.flv-glass--thick`） | `… 86% …` | `… 84% …` |
| `--glass-filter` | `blur(20px) saturate(160%)` | `blur(20px) saturate(140%)` |
| `--glass-stroke` | `color-mix(in srgb, var(--isl-border) 75%, transparent)` | `rgba(255,255,255,.09)` |
| `--glass-highlight` | `inset 0 1px 0 rgba(255,255,255,.55)` | `inset 0 1px 0 rgba(255,255,255,.07)` |
| `--glass-shadow` | 0.5px 外描边 + 2px 近投影 + 32px 远投影（墨色） | 同结构，黑色更深 |
| `--glass-radius` / `-lg` | 14px / 18px | 同 |

- **允许**：画布浮动工具条 / 快捷开关 / 小地图框、节点工具条与节点内媒体菜单、run 状态岛头部、左右停靠面板的**外壳**（两侧同一套）、popover / 菜单 / tooltip、工具弹窗外壳、媒体上的叠加控件（clear：`rgba(0,0,0,.35)` + `blur(12px)`）。
- **禁止**：节点主体、素材卡、trace、表格、代码 / JSON、模态正文、宿主面板。
- **回退**：`@supports not (backdrop-filter: blur(1px))`、`prefers-reduced-transparency: reduce`、`prefers-contrast: more` → `--isl-card` 实底。
- **对比度**：玻璃上只放 `--isl-ink` / `--isl-ink-soft`；不足 4.5:1 时提高不透明度，不加文字阴影。
- **性能**：同屏 ≤ 3 层玻璃、不嵌套；画布拖拽 / 缩放时不改 blur 半径。

### 9.3 磨砂浮层与遮罩

浮层与放大窗口用半透明磨砂（参照 bleep-app，见 [references.md](references.md)），窗外用深色遮罩，不用发白的蒙层。

| Token | 亮 | 暗 | 定义处 |
| --- | --- | --- | --- |
| `--flv-frost-fill` | `color-mix(in srgb, var(--isl-surface) 68%, transparent)` | `… 64% …` | `styles/skillHub.css` |
| `--flv-frost-fill-strong`（菜单） | `… 80% …` | `… 76% …` | 同上 |
| `--flv-frost-blur` | `blur(28px) saturate(175%)` | 同 | 同上 |
| `--flv-frost-edge` / `-highlight` / `-shadow` | 墨色发丝 + 内高光 + 双层投影 | 更深 | 同上 |
| `--flv-frost-fallback` | 不支持 backdrop-filter 时的近实底 | 同 | 同上 |
| `--flv-scrim` | `color-mix(in srgb, #0d100f 42%, transparent)` | `color-mix(in srgb, #000 56%, transparent)` | `styles/studioHub.css` |
| `--flv-scrim-blur` | `blur(2px)` | 同 | 同上 |

- 背后文字必须糊到读不出：浮层的祖先不能成为 backdrop root。面板外壳的玻璃画在 `::before` 上，外壳自身不写 `backdrop-filter`（`styles/adaptive.css`）。
- 放大窗口（`components/studio/StudioHub.tsx`）：一个外壳，侧栏 Skills / 历史 / 素材库，窄宽度收成 56px 图标栏。

### 9.4 Agent 对话面板的环境光磨砂（例外，`styles/ambientGlass.css`）

只作用于 Canvas 右侧的 Agent 对话面板：面板壳半透明（亮 `rgba(255,255,255,.46)`）+ 面板内三团柔和环境光（顶部薄荷 `--amb-p1`、右中淡紫 `--amb-p2`、底部蜜桃 `--amb-p3`）+ `blur(32px) saturate(115%)`；面板里的输入框、提示卡、生成计划卡是磨砂卡（`--amb-card` + `blur(20px)`）。消息正文本身不上玻璃。减弱透明度 / 高对比 / 不支持 backdrop-filter 时整体回退实底。应用其余部分不使用这套 `--amb-*` 变量。

### 9.5 斜叠卡片（多结果叠放）

少量多结果（首图节点的备选，及分镜 / 批量命令的自动分组）叠成一摞：后面两张左右斜出，悬停时散开（`components/ui/ImageFan.tsx`、`components/workflow/WorkflowAlternatesStack.tsx`、`batchStackMotion.ts`）。

- 叠放姿态：静止时侧卡旋转 ±5.5°（按深度递减）、下沉 3%；悬停时 ±9°、上浮 2%、散开 1.6 倍。弹簧 `stiffness 420 / damping 26 / mass 0.7`（**待收敛**到 `SPRING`）。
- 展开为 2 列网格（格距 12，世界坐标）：每格从叠放位（错开 5 / 3px、0.96 缩放、非首格透明）逐格错开 40ms 弹出；收起从最后一格开始逐格错开 25ms 飞回。
- 叠放卡是节点附属内容（§9.1 第 1 层）：实底 + 发丝线，不上玻璃。

## 10. Radius

| Token | 值 | 用法 |
| --- | --- | --- |
| `--isl-r-sm` | 6px（0.375rem） | 控件、chip、输入、版本按钮 |
| `--isl-r` | 8px（0.5rem） | 卡片、节点、面板分区、主按钮（`--isl-r-pill` 当前也是 8px） |
| `--isl-r-lg` | 10px（0.625rem） | 弹窗、浮动 chrome |
| `--glass-radius` / `-lg` | 14 / 18px | 玻璃外壳 |
| 16px | — | 左右停靠面板外壳（两侧一致） |
| `--iris-r-panel` / `-card` / `-thumb` | 26 / 18 / 14px | 仅 Cut / 故事版（§16.3） |
| 999px | — | 状态点、头像、胶囊（Agent 工作胶囊、run 状态岛收起态、分段胶囊） |
| 边框 | 1px | 强调用背景而非加粗；选中 = 1px mint + 外 2px `--isl-mint-bg` |

**待收敛**：组件里 `rounded-2xl` / `rounded-3xl` 23 处、`border-2` / `border-[1.5px]` 30 处；`styles/agent.css` 多种圆角混用。

## 11. Components

### 11.1 内容单元

| 单元 | 规格 |
| --- | --- |
| 节点卡 | `--isl-card`、1px 边框、8px 圆角、无阴影；媒体区 6px 圆角；标题 11px 600；右下角尺寸 / 大小角标 |
| 多结果（首图 + 备选） | 总数 ≤ 4 时斜叠卡片、展开为格子；> 4 时节点下方网格（`wfalt` 容器）；画廊在 `MediaPreviewModal` |
| 素材卡 | 同节点卡；缩略 62px 高；名称 11px 600；元数据 10px |
| trace 行 | 高 28px、1px 底线；状态图标 14px · 标题 11px · caller 徽标 9px pill · 耗时 10px tabular |
| run 状态岛 | 收起 34px 高胶囊、展开 10px 圆角；头部玻璃、列表实底 |
| 版本条 | 6px 圆角按钮，选中 mint 底；晚到版本右上 7px mint 点；废片删除线 + ghost |

### 11.2 Agent 卡片

确认卡、生成计划卡、提问卡共用一个外壳（`components/agent/AgentCardShell.tsx`、`styles/agentCardShell.css`，版式参照 Inspora「AI Agent Approval Cards」，登记见 [references.md](references.md)）：一句人话说明动作与对象，费用明细收进「详情」，「允许」为唯一主按钮，授权范围用一个下拉。计划卡：标题 + 状态「待生成 → 生成中 n/N → 已完成」、可展开资产列表、三个选择；步骤列表见 `styles/planSteps.css`。

### 11.3 派生控件

| 控件 | 规格 |
| --- | --- |
| 分段 / 标签 | 槽 `--isl-surface-sunk` 8px 圆角 2px 内边距；选中块 `--isl-card` + `--isl-shadow-sm`，snappy 滑动 |
| 输入 / composer | 底 `--isl-surface`、1px 边框、6–8px 圆角；聚焦 mint 边框；附件拖入时虚线 mint 边 + `--isl-mint-bg` |
| 进度 | 线性 2px（节点底）/ 6px 分段（trace）/ 环形 64px（长任务）；色 mint，轨 `--isl-surface-2` |
| 骨架 | `--isl-surface-2` 实块、同最终尺寸、8px 圆角 |
| 对比滑杆 | 2px 白分界 + 22px 圆形把手（`--isl-shadow`）；两侧 clear 角标标版本 |

## 12. Underlying logic

| 项 | 规则（代码依据） |
| --- | --- |
| CSS 变量 | 新组件只用 `--isl-*`；`--app-bg` / `--panel-*` / `--text-*` 是壳层别名 |
| 断点 | 容器优先：`@container app-shell (width <= 1023px)`、`@container workflow-space (width <= 1023 / 760 / 420px)` 等（`styles/adaptive.css`、`fluid.css`）；媒体查询只做兜底；断点只表达“放不放得下”，不按设备分支 |
| Hover / 状态 | hover 只换背景或边框（120–140ms `--ease-standard`）；pressed 深一级；focus-visible 2px mint 外偏移 2px；disabled 50% 不透明 |
| 列表浮层键盘 | 每个列表浮层（模型 / Provider / 画布切换 / Skill / @ / 历史 / 素材 / 节点类型 / 设置下拉）：打开即可输入筛选、↑/↓ 移动高亮、Enter 选中、Esc 先清空再关闭、悬停同步高亮；`listbox` / `option` + `aria-activedescendant`；输入法组字中不响应。统一用 `hooks/useListboxKeyboard.ts`，不另写键盘逻辑 |
| Pointer / 画布 | 画布自有 pan / zoom（`InfiniteWorkflow`）；`data-workflow-overlay` 的浮层阻止冒泡防误拖；手柄命中区 ≥ 24px；拖拽中卡片 `--isl-shadow-lg`、不旋转 |
| 减弱动效 | `@media (prefers-reduced-motion: reduce)`（styles 里 39 段）：`--motion-*` / `--spring-*-duration` → 0.01ms；JS 动画用 `MotionConfig reducedMotion="user"` / `useReducedMotion()` |
| 减弱透明度 | `prefers-reduced-transparency` / `prefers-contrast: more` → 玻璃与磨砂回实底（§9） |

## 13. Do & Don't

| Do | Don't |
| --- | --- |
| 用 `--isl-*` token；新色同时给亮 / 暗 | 在组件里写 hex、`rounded-2xl`、`border-2`、`font-extrabold` |
| 薄荷只给主操作、选中、进度、成功 | 用薄荷做装饰描边或大面积底色 |
| 节点与面板**正文**实底；面板**外壳**按 §9.2 用玻璃 | 给节点加抬起；左右面板各用一套外壳 |
| 玻璃只给浮动 chrome，且可退化 | 对话正文、trace、表格放在玻璃上 |
| 状态 = 图标 + 文字 + 颜色 | 只靠颜色区分失败 / 运行 |
| hover 换背景 | hover `translateY` / `scale` |
| 用三档弹簧，可打断 | 自定义 cubic-bezier 过冲、对宽高做弹簧 |
| 结果由模糊到清晰揭示一次（`flv-gen-reveal`） | 霓虹流光（`#00ff88`）、无限呼吸、彩纸粒子 |
| 奶蛙只表示“Agent 在想 / 在做” | 把奶蛙当装饰贴满界面、改造型或给它加身体 |
| 按容器宽度逐级降级（§15） | 只在一个窗口宽度下设计；靠 `flex-wrap` 把工具行折成两行 |
| 空态、菜单、弹层的类名都有样式定义 | 写了 `className` 却没有 CSS |
| 跟随主题的 `color-mix` / token | `rgba(22,22,24,.86)` 这类硬编码深色；`var(--未定义, #1f1f23)` 兜底 |

## 14. Motion

### 14.1 Level

**Medium-low**：只在因果处动（出现、落定、进度、交接），高频交互不动；参考 Apple Motion（有目的、可选、可打断）。

### 14.2 Durations（`styles/motion.css`）

| Token | 值 | 用法 |
| --- | --- | --- |
| `--motion-fast` | 140ms | 颜色、背景、边框 |
| `--motion-base` | 220ms | 主题切换、淡入 |
| `--motion-medium` | 320ms | 视图进入；Agent 工作胶囊换阶段的离场 |
| `--motion-slow` | 420ms | 少用 |
| 退出 | 120–160ms | 菜单关闭、toast 消失 |
| 结果揭示 | 680ms | `flv-gen-reveal`（模糊 → 清晰，`--ease-soft-out`） |
| 不确定循环 | 1.2–1.6s | 旋转 / 扫光，仅在等待时 |

### 14.3 Easings & springs

曲线（均无过冲）：`--ease-standard cubic-bezier(0.4,0,0.2,1)`、`--ease-soft-out (0.22,1,0.36,1)`、`--ease-spring-soft (0.2,0.8,0.2,1)`、`--ease-emphasis (0.16,1,0.3,1)`。

弹簧（**已实现**：CSS `--spring-*` 在 `styles/motion.css`，JS 镜像 `SPRING` 在 `components/studio/motionTokens.ts`；不支持 `linear()` 的内核回退 `--ease-emphasis`）。按 Apple《Animate with springs》的 duration + bounce 定义；`motion` 组件写 `{ type: 'spring', visualDuration, bounce }`。

| 档位 | visualDuration / bounce | 过冲 | CSS 时长 | 用于 |
| --- | --- | --- | --- | --- |
| snappy | 0.22s / 0 | 0 | 330ms | tooltip、菜单、chip、toggle、分段指示块 |
| smooth | 0.35s / 0 | 0 | 520ms | 侧栏开合、分区切换、视角平移（尺寸不过冲，只动 transform / opacity） |
| expressive | 0.42s / 0.2 | 1.5% | 565ms | 状态岛展开、元素落定、拖入画布落定、候选扇出 |

**待收敛**：组件里仍有十余种 `stiffness / damping` 写法（`420/34`、`420/32`、`420/30`、`380/32`、`520/40`、`400/25`、`400/22`、`320/28`、`700/22`、`620/44` 等），以及 `visualDuration` 0.24 / 0.26 / 0.3 / 0.32 的变体；新代码一律用 `SPRING.*`。

### 14.4 Hover

只换颜色 / 背景 / 边框，`--motion-fast`。**待收敛**：`.motion-surface:hover`（`translateY(-1px) scale(var(--scale-hover))`）、`.workspace-pill:hover`、`.storyboard-shot-card:hover translateY(-2px)`。

### 14.5 Scroll

产品界面没有滚动驱动动画（无 parallax、无 scroll-trigger 揭示）；列表新增项 snappy 淡入；Agent 对话在用户上翻后不再自动跟随到底部，离底超过 1/3 屏时出现“回到最新消息”按钮。滚动叙事只用于官网 / 宣传片。

### 14.6 Canvas

- 视角平移 / 缩放到目标：smooth；用户拖拽画布 1:1 跟手，松手不加惯性。
- 节点落定：expressive，只发生一次。自动整理：所有节点同时 smooth 过渡，可撤销。
- 画布切换有冲击波揭示（`styles/canvasSwitch.css`，原点为点击点或切换器中心）。
- 减弱动效：位移改为 120ms 透明度，循环全部停止。

### 14.7 动效库

保留 `motion`（^12.40，`motion/react`）。GSAP 只是候选、不加依赖：其“No Charge”授权禁止用于与 Webflow 可视化动画构建竞争的工具，Iris 是创作工具，引入前需法务评估；现有需求（弹簧、布局动画、手势）motion 已覆盖。

## 15. Elastic layout（弹性布局）

**判断**：Iris 的每块面板都会被用户拖宽拖窄、被窗口挤压、被嵌进宿主。UI 不是为某个宽度画的静态稿，而是一条**随自身宽度降级的曲线**。任何宽度下都不允许重叠、折行、文字被截成半个字（如 `Lo…`）或控件溢出面板。

### 15.1 降级梯（从宽到窄，依次执行）

1. 完整：图标 + 文字标签
2. 收窄：次要文字截断（`min-width:0` + `text-overflow: ellipsis`），当前项保留文字
3. 图标化：所有控件变 28px 图标按钮，文字改由 `title` / `aria-label` 承担
4. 收纳：次要控件隐藏，但必须有别的路径（菜单、快捷键）
5. 收起：整块面板收成一个图标（右上角开关）

### 15.2 规则

| 项 | 规则 |
| --- | --- |
| 断点依据 | 用 `@container`，按**组件自身宽度**判断，不用 `@media` 按窗口判断。每个可变宽的面板都声明 `container-type: inline-size` 和名字 |
| 断点数量 | 每个组件最多 2 个断点，值写在 `styles/fluid.css`，旁边注释写明“到这里变成什么” |
| 工具行 | `flex-wrap: nowrap`；文字 span 必须 `min-width:0` 才能截断 |
| 居中浮条 | `position:absolute; left:50%; translateX(-50%)` 的 shrink-to-fit 只能拿到容器一半宽度，会提前折行 → 加 `width: max-content` |
| 可拖面板 | 有 `minWidth`；拖过最小宽度 72px 时进入半透明预览，松手收成图标（同 macOS 侧栏），而不是把内容挤爆 |
| 隐藏 ≠ 删除 | 被收纳的功能必须保留入口：撤销 / 重做 → `Ctrl Z`；修订号 / Timeline → 工具条「历史操作」菜单里的「Timeline」，以及 Hub 侧栏 |
| `cqw` 基准 | 新加 `container-type` 会改变子元素里 `100cqw` 的参照对象，加之前先 grep 子树里的 `cqw` |

### 15.3 当前实现（样张）

| 组件 | 容器 | 断点 → 结果 |
| --- | --- | --- |
| 左侧图层标签 | `wfsb` | ≤260px：非当前标签变图标、隐藏计数；≤200px：全部图标 |
| Agent 输入区工具行 | `agentcomposer` | ≤420px：模型名截到 9ch；≤340px：全部 28px 图标 |
| 画布底部工具条 | `workflow-canvas` | ≤700px：收起撤销 / 重做 / 修订号；≤480px：收起缩放 |
| 右侧面板 | `StudioRightDrawer` | 最小 280px；比最小宽度再窄 72px 时吸附收起 |
| 节点下方的多结果网格（总数 >4） | `wfalt` | ≤420px：批量操作只留图标；≤220px：标题只留计数 |
| 斜叠卡片展开后的格子（总数 ≤4） | `wfaltcell` | ≤240px：下载 / 设为首图 只留图标 |

### 15.4 验收（每个 UI PR 都要做）

- 在**真实入口**截三档：宽（默认）、中（面板拖到一半）、最小（拖到 `minWidth`），并截一张收起态；亮色、暗色各一组。
- 逐张检查：没有重叠、没有折行、没有半截字、没有贴边裁切、没有硬编码颜色在暗色下发黑或发白。
- 截图放进 PR 描述；只给单一宽度截图的 PR 不算验收。


## 16. Layout · Canvas / Cut / Agent

### 16.1 外壳与顶栏

- 顶栏 `StudioTopMenu`（`components/studio/StudioTopMenu.tsx`）：左侧奶蛙 logo（`public/favicon.png`，28px、8px 圆角）+ 项目名；居中 `role="tablist"` 的三个视图切换 **画布 / Cut / Agent**（英文 Canvas / Cut / Agent；内部视图 id `spatial` / `reverse` / `agent`）；右侧账号、AI 服务状态、语言、主题 / 显示、设置。在 Canvas 视图下顶栏背景透明、浮在画布之上（`styles/chrome.css`）。
- 主工作区按容器（`app-shell`、`workflow-space`）排版，不用 viewport inset 补丁。

### 16.2 Canvas

- 主体是无限画布（点阵 / 线格可切换）；左侧图层 / 素材 / 本地文件夹侧栏（`WorkflowSidebar`），底部居中浮动工具条（修订号、新建、聚焦、调整、历史、撤销 / 重做、缩放、Agent 开关），左下角小地图与快捷开关。浮动件用玻璃。
- 右侧停靠抽屉 `StudioRightDrawer`：宽度 280–640px 可拖（`App.tsx`），比最小宽度再窄 72px 吸附收起；内容是内置 Agent 对话（§9.4 环境光磨砂）。

### 16.3 Cut

- 页面（`components/cut/CutPage.tsx`、`styles/cut.css`）：顶部胶囊分段切换「剪辑 / Editor」与「故事版 · 逆向 / Storyboard · Reverse」。
- 剪辑器栅格：上排 **素材箱 | 预览 | 属性**（列宽 `minmax(220px, 280px) | minmax(0, 1fr) | minmax(220px, 270px)`），下排通栏 **时间线**（行高 `minmax(190px, 36%)`），间距 12px，内边距 `10px 16px 16px`。
- 色板：Cut 与故事版沿用 `styles/irisStoryboard.css` 的蓝紫玻璃色板——底色 `--iris-bg-top` → `--iris-bg-bottom` 渐变（亮 `#e8ecfa` → `#d9d6f2`，暗 `#0e1324` → `#282c58`）+ 微弱光晕，面板是半透明大圆角磨砂（`--iris-glass`，圆角 `--iris-r-panel` 26px / 卡片 18px / 缩略 14px），分段与按钮用白色胶囊（`--iris-pill`）。这是用户指定的例外（覆盖“玻璃只给浮动 chrome”与圆角上限）：两块面板就是停靠面板外壳，素材格子与正文仍是低对比实色填充，不叠第二层 `backdrop-filter`。不要把这套色板带出 Cut / 故事版。
- 浏览器缺少 WebCodecs 时显示 `cut-unsupported` 提示（`Clapperboard` 图标 + 缺失能力），而不是空白。

### 16.4 Agent 页与奶蛙

- Agent 视图是连接与状态页（`AgentConnectionsPage`，`components/agent/AgentWorkspace.tsx`、`styles/agentLink.css`）：连接指引 / 连接状态 / 运行日志，事实用两列网格，日志行 `max-content | 4.5ch | 1fr`。没有聊天区。
- **奶蛙（Naiwa）** 是 Agent 的形象：圆黄头、绿脸颊、一只手托腮；**只有头和手，没有身体**。
  - 静态 logo：`public/favicon.png`（顶栏、抽屉头部）。
  - 思考动画：`components/brand/NaiwaThinking.tsx` + `styles/naiwaThinking.css`——底图去掉瞳孔和嘴，SVG 叠加瞳孔、眼皮、嘴；3.6s 一个循环（往上看 → 眯眼 → 眨眼 → 换方向 → 回正，头轻晃 ±3°），右上「…」思考气泡 1.2s。关键帧与时长从 OfferU 原样移植，不要改。
  - 尺寸只有两档（`AgentWorkingOrb`）：**20px** 行内（运行中的工具行、输入框“运行中”，不带气泡）、**32px** 工作胶囊（带气泡）；小于 20px 认不出，不提供。
  - 工作胶囊（`.agent-orb-pill`，999px 圆角）：奶蛙 + 静态阶段标签，状态全部来自真实事件（`agentWorkingPhase`）；动效只在奶蛙身上，字不扫光、不打字机；换阶段时旧胶囊模糊 + 右滑 + 淡出（`--motion-medium`），新胶囊淡入。
  - 减弱动效时奶蛙与气泡静止（气泡点全亮）。暗色主题下气泡底色另行适配。

## 拓展 UI（规划中）

> **规划中，均未实现。** 本节是拓展 UI 的概念规范（2026-11-24），用于后续实现时对齐视觉与交互；不是现行设计，不能当成已上线功能对外宣称。完整版设计说明与概念稿在仓库外维护，本节是精简版。所有概念复用上文 token，**不新增色相**：内容卡实底无阴影、浮动件玻璃、画布无阴影；审批一律用确认卡（左 3px `--isl-sun`）；"原样保留"用 `Lock` + ink-soft；"新分支 / 新时间线"用 `GitBranch` + 薄荷；分支色 A 蓝 `#3f7fd9` / B 紫 `#7a5cc7` / C 阳光暗 `#b88a00`。

### 「即将推出」标签（`.isl-soon`，提案）

虚线 1.5px `rgba(244,242,236,.38)`、999px 圆角、`--isl-ink-soft` 字、前置阳光色 `Sparkles`。只用于预告 / 实验态；不用薄荷或阳光实底，避免和"可按 / 待确认"混淆。产品里对应"实验性"标签。

### 1. 审片台 · Branch Review

- 顶部"原片"源卡（`Film` · 文件名 · 时长 · `Lock 原片不动`）向下分出 2–4 条分支卡；每张：字母方块 + 版本名 + `v1` chip → 16:9 预览 → 指标 chip → 镜头条（每镜一格）→ 时间尺 → "选这版"。
- 多张卡共用一个同步播放头。点某条分支的镜头条 → 薄荷定位针 `MapPin 00:14`，该镜头薄荷描边，其余镜头 `Lock` + 压暗到 55%；只重生成这一个镜头，完成后版本 chip `v1 → v2`，toast"只改了 1 个镜头 · 其余不动"。
- 降级：< 900px 上下叠放；< 560px 只显示当前分支 + "对比"按钮。

### 2. Scene IR / Context Card（工程压缩卡）

- 内容卡：`FileText Scene IR` + `Context Card` chip；元数据"工程 · 时长 · fps · 镜头数"；四段——结构（分段色块，宽 = 时长占比）、节奏（每镜一根薄荷柱）、色彩（5 色块）、字幕（轨数 · 条数 · 版式）。
- 底部 `Cpu`"整个工程压成 N tokens，再交给模型"——让人看见模型到底读到了什么。可 @ 进对话，点段展开明细。

### 3. Resolve 桥接

- 宿主面板（Workflow Integration，跟随 Resolve 中性灰、弱品牌）：`已连接` + `Eye 只读`；只读扫描清单 Media Pool / Timeline / Fusion 节点树 / 调色节点骨架，逐行 `LoaderCircle → CheckCircle2`；"只调用官方 API 读取 · 不改动原工程"。
- 扫描结果连到画布上的 Scene IR 卡。写入前是审批闸门（确认卡）："写入前，先问你" → `GitBranch` 新建 `Timeline_v2_Agent` / `Lock` 原时间线不改动 / `Layers` 插入段；唯一主按钮"批准写入"；"删掉新时间线即可撤销"。
- 写入后是时间线对照卡（原时间线锁定、新时间线插入段薄荷）。未检测到 Studio / 无项目 / 守护进程未连接各给一个恢复动作，不暴露端口与 token。

### 4. Skill 蒸馏

- 左：过往工程卡汇入中间的蒸馏卡（`FlaskConical`，"来自 N 个工程"）：节奏指纹（镜长柱 + 卡点率）、结构指纹（段落色块）、视觉指纹（色板 + 字幕样张）。
- 右：浮出的新 Skill 卡（玻璃）：名称胶囊 `@我的产品宣传片`（与 composer 的 @ 引用同形态）→ `节奏 ✓ 结构 ✓ 视觉 ✓` → "保存为 Skill"。@ 它发一句话 → 画布出现套用了该 Skill 的新节点。

### 5. 长任务与费用审批队列

- run 状态岛（玻璃 pill）：进度环 + "N 个任务 · 后台运行" + 阳光 chip "N 个待批准"。
- 队列卡：右上今日预算条（薄荷 = 已用，阳光斜纹 = 待批准预估）；每行进度环（排队 `Clock` / 待批准阳光 `CircleDollarSign` / 完成 ✓）+ 模型 · 规格 · 预估费用 · 预计时长 + 动作（取消 / 跳过 · 批准 / 超预算 `Pause 先放着`）。
- 超过阈值或超预算的任务自动进待批准；底部 `Cpu`"任务跑在本地 Iris 守护进程里 · 关掉窗口也会继续" + `History 可重启恢复`。

### 6. 空间化上下文 · Context Card / 对话分叉

参考 Eden 画布的"连线即上下文"，但**不把 Iris 变成通用 AI 笔记画布**：Canvas 仍是生产空间，Cut 仍是剪辑器 / 个人后期 Agent，Agent 页仍是外部 Agent 连接与运行状态；始终只有一个主 Agent。

- **Context Card**：选中节点 → 右键「用这些素材开启讨论」（或从连接点拖到空白处）→ 画布上一张绑定这些来源的卡：`MessageSquare` 标题 → source chips（缩略 + 名称 + `@rev` + 状态）→ 已确认的短结论 → 产出 refs（生成计划卡、成片节点）→ "打开会话"链接。
- **绑定范围可见**：来源 + 卡片外包一圈上下文范围（薄荷 38% 细边 + 4.5% 底，标签"只含连线绑定的 N 个素材 · 模型不读整张画布"）；范围外节点不进上下文（hover 显示 `EyeOff 未绑定`）。不提供"和整张画布聊天"，要更大范围先编组。
- **实时引用 vs 冻结快照**：实时 = 薄荷实线 + `Radio 实时` + 跟随最新 revision；冻结 = ink-ghost 双线 + `Snowflake` 结 + `快照 @r12`，由某次 Run 开跑时锁定。源已更新时快照行出阳光 tag "源已到 r14" + "用最新版重跑"（仍走生成计划卡审批）。快照不用虚线（虚线留给「即将推出」与占位）。
- **对话分叉**：从任意回复「从这里分叉」→ 分叉结（`GitFork`）→ 分支泳道 A / B，各自有计划 → Run → 结果节点，泳道头部写追溯"来源 @rev · 回复 #N · 分支 A"。付费分支的计划仍是确认卡（¥ 预估 + 已批准）。
- **钉到画布**：选中确认过的回复片段 → `Pin 钉到画布` 生成 / 更新 Context Card；回复里的分镜行掉出成真实镜头节点，可拖进 Cut、可单独生成。
- 数据形状：

  ```ts
  interface CanvasContextCard {
    id: string;
    projectId: string;
    sessionRef?: string;
    runId?: string;
    sources: Array<{ kind: 'node' | 'artifact' | 'document' | 'shot'; id: string; revision?: number }>;
    summary?: string;
    outputRefs: string[];
  }
  ```

- 分期：**P0** 选中节点作为 Cut / Assistant 上下文 → **P1** 钉成 Context Card 并跨重载保留 → **P2** 对话分叉 → **P3** 关联 Run / 候选结果 / trace（冻结快照）→ **P4** 外部 Agent 经 Skill / CLI / MCP 读取绑定（范围与画布一致）。
