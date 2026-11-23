# DESIGN.md · Iris

> 状态：**Current truth**（2026-11-24 增补 AgentOS 的审片视觉优先级；其余 token 延续 2026-11-13 规范）。本文只描述**视觉语言与动效 token**（看起来是什么、动起来是什么）；交互与行为（状态、流程、出口、谁能做什么）见 [01 交互设计](01-interaction.md)。两份不重复：本文给数值，01 引用数值。
> 格式：参照 Refero Styles 的 DESIGN.md 分层（mood → tokens → typography → color → overview → components → logic → do/don't → motion）。所有数值取自当前代码：`styles/index.css`、`styles/motion.css`、`styles/adaptive.css`、`styles/workflow.css`、`styles/dshEmbed.css`、`components/` 扫描；标 **目标** 的是本次新增、代码尚未采用的 token。
> 来源：原 `31-notion-compact-ui.zh-CN.md` 的已实施部分已并入本文，原文见 [archive/2026-11-13-design-refresh](../archive/2026-11-13-design-refresh/)。

## 0. Agent-native Production OS 的视觉重心（2026-11-24）

Iris 的界面首先服务于**看懂素材、审查 Agent 的改动、比较版本、决定是否应用**。Canvas 是素材/Workflow/审片空间；Cut 是已经可用的视频剪辑器；Agent 是连接/Runtime 管理；对话与上下文在现有 Canvas Assistant Drawer。不要按旧设计里的独立 Iris Personal Agent tab 实现 UI。

- **Spatial Context**：只把用户明确 Commit 的结论显示成独立 Context Card；卡片短标题、正文、来源 Chip 和「继续讨论」。不把所有消息平铺为节点，来源绑定默认隐藏，选中/悬停才高亮；Workflow 执行连线保持原意。
- **审片与提案**（目标）：用户看得见原版/候选、变更范围、Diff、费用和批准/拒绝；失败有定位、查询或恢复动作。工具日志按需展开，不抢素材画面的空间。
- **按任务出现的 UI**（目标）：镜头并排、帧段定位、字幕波形、审核卡只在需要时出现，结束后收拢为产物与回执；不加第四个导航入口。
- **视觉约束**：沿用本文 `--isl-*`、暖纸面/薄荷色、现有 `motion` 与弹性布局。素材优先、浅底高信息密度、避免装饰性图、重复标题和泛化营销文案。
- **状态透明**：明确区分 Done / Failed / Pending / Unknown，以及已实现/设计目标，不用动画制造假的进行中或成功。

§1–§15 继续定义视觉 token、数字与响应式规则，历史组件名仅作样式参考。产品状态和入口职责见 [00](00-overview.md)、[11](11-iris.md)。

## 1. Mood

Iris 是给**剪辑师、创作者和他们的 Coding Agent** 用的本地创作台：人和 Agent 在同一张无限画布上摆素材、跑生成、比版本。它应当像一张**温暖的工作纸**——安静、紧凑、可信：底色是米白纸面和炭黑墨线，只有一抹薄荷绿标记“可以按 / 正在进行 / 已选中”；面板是贴在纸上的扁平卡片，只有真正浮在画布之上的工具才轻轻透出底下的内容；动作短促、有弹性但不炫技。作品和画布永远比界面更显眼。

## 2. Key tokens

| 角色 | 值 | Token |
| --- | --- | --- |
| Accent | 薄荷 `#19c8b9`（暗 `#3ad9c9`），深 `#12a89b` | `--isl-mint`、`--isl-mint-deep` |
| Canvas | 纸面 `#f4f1ea`（暗 `#15140f`），24px 点阵 / 线格 | `--canvas-bg`、`.workflow-bg--dots/--lines` |
| App | `#f1ede3`（暗 `#131210`） | `--app-bg` |
| Palette | 纸 `#faf9f6` / `#ffffff`、墨 `#1f1d1a`、暖灰 `#6b6862`、发丝线 `#e3e0d8`、阳光 `#f5c31c`、珊瑚 `#e8615a` | `--isl-*` |
| Font | `Inter, Noto Sans SC, Microsoft YaHei, Segoe UI, system-ui`（未打包字体文件，按系统回退） | `--isl-font` |
| Density | 正文 12px，控件 11px，行高 28–32px | — |
| Radius | 6 / 8 / 10px | `--isl-r-sm` / `--isl-r` / `--isl-r-lg` |
| Motion | 三档弹簧 snappy / smooth / expressive（§14），已在 `styles/motion.css` 落地 | `--spring-snappy` / `--spring-smooth` / `--spring-expressive` + `*-duration` |
| Frost | 浮层磨砂（Skill / @ 引用 / 预览卡 / 资源窗口），半透明，见 §9.3 | `--flv-frost-*`、`.flv-frost` |
| Scrim | 模态窗外遮罩，亮暗都是深色，见 §9.3 | `--flv-scrim`、`--flv-scrim-blur` |

## 3. Typography roles

现状分布（扫描）：`font-size:10/11px` 各约 100 处、`text-[11px]` 108 处、`text-xs` 212 处，13–15px 少量——这是 11–12px 的紧凑工具界面。

| 名称 | 字号 / 行高 | 字重 | 用法 |
| --- | --- | --- | --- |
| display | 20 / 28px | 600 | 仅首次使用与关键空态；历史个人 Agent 首页不是当前交互入口 |
| title | 15 / 22px | 600 | 面板标题、空态标题、视图标题 |
| body-strong | 13 / 20px | 600 | 卡片标题、抽屉 / 侧栏分区标题、run 名 |
| body | 12 / 18px | 400 | 正文、对话、trace 行、表格 |
| label | 11 / 16px | 500–600 | 控件、chip、节点元数据、光标标签 |
| caption | 10 / 14px | 500 | 时间戳、计数、徽标；不放需要阅读的句子 |
| button | 11 / 16px | 800（仅 `.isl-go`）/ 600 | 主按钮字重 800、字距 0.02em；其他按钮 600 |
| numeric | 同所在角色 | 同 | `font-variant-numeric: tabular-nums`：进度、计时、费用、版本号 |

规则：标题 600、正文 400；`font-extrabold` 只留给 `.isl-go`（待收敛 14 处）；中英混排不加字距；不使用斜体。

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
| 强调 · 主操作 · 进度 · 成功 | `#19c8b9` | `#3ad9c9` | `--isl-mint` |
| 强调深 · 链接 · hover | `#12a89b` | `#1fb8a9` | `--isl-mint-deep` |
| 选中底 | `#e3f7f4` | `rgba(58,217,201,.14)` | `--isl-mint-bg` |
| 警示 · 待确认 · 费用 | `#f5c31c` | `#f7d04a` | `--isl-sun` |
| 失败 · 破坏性 | `#e8615a` | `#f07a72` | `--isl-coral` |
| 失败文字 | `#cf4b45` | `#e8615a` | `--isl-coral-deep` |

**光标 / 子 Agent 色**（**目标**，§11.4）：从现有色阶派生，不新增色相以外的品牌色——`我 / 用户` 墨 `#1f1d1a`、主编排 薄荷 `#12a89b`、版式 / 字体 珊瑚 `#cf4b45`、素材 / 生成 阳光 `#b88a00`（`--isl-sun` 压暗以满足白字对比）、合成 / 行动 蓝 `#3f7fd9`、评审 紫 `#7a5cc7`。同屏最多 6 色；超出用同色加编号。

**遗留，不再新增**：`--iris-*`（冷灰 zinc 系）、`--flv-*`（rose / coral / violet / glow）。**待收敛漂移**：`#e5484d`、`#e05252`（失败红）、`#6c64b0`、`#00ff88`（生成态强调）、抽屉暗色 `rgba(28,29,34,.78)`、未定义的 `--isl-line`。

## 5. Overview

| 维度 | 规格 |
| --- | --- |
| Mood | 暖纸面、单一薄荷、扁平分层、紧凑密度（§1） |
| Layout | 顶栏三个 surface：**画布 Canvas｜Cut｜Agent**（职责见 [01](01-interaction.md) §11）；下方工作区 = 主 surface + 可停靠侧栏；Canvas 主体是无限画布；Cut 是实际视频时间线；现有 Assistant Drawer 负责对话与审查 |
| Content width | 页面型内容 `--content-max: 1280px`；表单 `--form-max: 680px`；侧栏 `--sidebar-width: clamp(220px, 24vw, 320px)`；宿主面板 280–480px |
| Grid | 画布 24px 点阵（`.workflow-bg--dots`，墨 16%）或线格（`--lines`，13%），可开关；吸附网格同 24px；页面用 `--space-*` 间距而非列栅格 |
| Icons | `lucide-react`（^1.20）线性图标，常用 12–18px（15px 75 处、14px 66 处），描边默认 2 |
| Imagery | 用户素材与生成结果是唯一的“图”；界面不放装饰插画（起始页线稿除外，静态） |

## 6. Buttons

| 类型 | 类 | 规格 |
| --- | --- | --- |
| Primary | `.isl-go` | 底 `--isl-mint`、字白（暗色字 `#131210`）、圆角 8px、高 28–32px、字重 800；hover `--isl-mint-deep`；禁用底 `--isl-border-strong` 字 `--isl-card`；一个视图只有一个 |
| Chip / Toggle | `.isl-chip`、`--active` | 1px `--isl-border-strong`、底 `--isl-surface`、圆角 6px、字重 600；hover 边框与字转 mint；激活底 `--isl-mint-bg` + mint 边框 + `--isl-mint-deep` 字；计数 tabular 放右侧 |
| Ghost / Secondary | — | 1px `--isl-border`、底 `--isl-surface`、hover `--isl-surface-2` |
| Icon button | `.agent-new-chat-btn.is-icon` 等 | 28px 方形、圆角 6px、图标 14–15px、hover 背景 `--isl-surface-2`；必须有 `aria-label` 与 tooltip |
| Destructive | — | 文字 / 边框 `--isl-coral-deep`；主按钮形态只在确认对话框内出现 |
| Send / Stop | `.agent-composer__send` | 同一位置切换；生成中变停止方块 |

按下不缩放、不位移；状态切换只换颜色（120–140ms）。

## 7. Iconography

- 库：`lucide-react`；不混用其他图标库；不用 emoji 充当状态。
- 尺寸：行内 12–14px、按钮 14–16px、空态 20–26px；描边 2（只在 12px 以下可用 2.4–2.5）。
- 颜色：默认 `--isl-ink-soft`；激活 `--isl-mint-deep`；状态图标按 [01](01-interaction.md) §14.3 映射（`Clock` 排队、`LoaderCircle` 等待、`CheckCircle2` 成功、`XCircle` 失败、`ShieldQuestion` / `BadgeDollarSign` 待确认、`Lock` 锁定、`Archive` 废片）。
- 光标：Agent 光标用 lucide `MousePointer2` 实心变体 + 标签 pill（§11.4），不画自定义箭头。

## 8. Spacing scale

| Token | 值 | 用法 |
| --- | --- | --- |
| `--space-xs` | 4px | 图标与文字、chip 内 |
| `--space-sm` | 8px | 控件间、卡片内边距 |
| `--space-md` | 12px | 分组间（原 31 号“分组 12px”） |
| `--space-lg` | 20px | 区块间 |
| `--shell-gap` | `clamp(12px, 2vw, 32px)` | 壳层外边距 |
| `--panel-gap` | `clamp(10px, 1.6vw, 24px)` | 面板间 |
| `--control-height-sm` / `-md` | 32 / 40px | 控件高度；紧凑行 28px |
| 控件内边距 | `px-2 py-1`（8 / 4px） | 原 31 号密度规则 |

## 9. Elevation & Depth

### 9.1 三层

| 层 | 底 | 阴影 | 例子 |
| --- | --- | --- | --- |
| 0 画布 | `--canvas-bg` + 网格 | 无 | 画布 |
| 1 内容 | `--isl-card` 实底 + 1px `--isl-border` | **无** | 节点、素材卡、面板、侧栏正文、表格 |
| 2 浮动 chrome | 玻璃（§9.2）或 `--isl-card` | `--isl-shadow-*` | 工具条、节点工具条、run 状态岛、左右停靠面板（内缩 8px 的悬浮卡）、popover、菜单、工具弹窗、tooltip、Agent 光标标签 |

| Token | 亮 | 暗 |
| --- | --- | --- |
| `--isl-shadow-sm` | `0 1px 2px rgba(31,29,26,.06)` | `0 1px 2px rgba(0,0,0,.30)` |
| `--isl-shadow` | `0 2px 8px rgba(31,29,26,.08)` | `0 2px 8px rgba(0,0,0,.34)` |
| `--isl-shadow-lg` | `0 6px 18px rgba(31,29,26,.10)` | `0 6px 18px rgba(0,0,0,.40)` |

pressable 3D drop（`--isl-drop*`）已于 2026-10-30 删除；`--shadow-panel`、`--shadow-floating-*` 属旧层，不再新增。

### 9.2 玻璃（只给浮动 chrome）

依据：Apple Materials（Liquid Glass 是浮在内容层之上的控件 / 导航层，不进内容层、节制使用、文字多用 regular、媒体上用 clear + 暗化）与 Figma UI3（浮动面板遮挡画布、拖慢长时间使用者，正式版改回固定面板，只保留浮动工具条）。

| Token（**目标**） | 亮 | 暗 |
| --- | --- | --- |
| `--glass-bg`（regular） | `color-mix(in srgb, var(--isl-card) 72%, transparent)` | `… 70% …`（暖 `#201f1d`） |
| `--glass-bg-thick`（popover） | `… 84% …` | `… 82% …` |
| `--glass-filter` | `blur(20px) saturate(160%)` | `blur(20px) saturate(140%)` |
| `--glass-border` | `1px solid color-mix(in srgb, var(--isl-border) 70%, transparent)` | `1px solid rgba(255,255,255,.08)` |
| `--glass-highlight` | `inset 0 1px 0 rgba(255,255,255,.55)` | `inset 0 1px 0 rgba(255,255,255,.06)` |
| clear（媒体叠加） | `rgba(0,0,0,.35)` + `blur(12px)` | 同 |

- **允许**：画布浮动工具条 / 快捷开关 / 小地图框、节点工具条与节点内媒体菜单、run 状态岛头部、左侧图层面板与右侧 Agent 面板的**外壳**（两侧必须同一套：内缩 8px、16px 圆角、发丝描边 + 柔和远投影）、popover / 菜单 / tooltip、工具弹窗外壳、Agent 光标标签、媒体上的叠加控件（clear）。实现：`styles/glass.css` 的 `.flv-glass` 与 `--glass-*`。
- **禁止**：节点主体、素材卡、对话 / trace 正文、表格、代码 / JSON、模态正文、宿主面板。
- **回退**：`@supports not (backdrop-filter: blur(1px))`、`prefers-reduced-transparency: reduce`、`prefers-contrast: more` → `--isl-card` 实底 + `--isl-border-strong`。（**假设**：WebView2 对 `prefers-reduced-transparency` 的支持按当期版本核验。）
- **对比度**：玻璃上只放 `--isl-ink` / `--isl-ink-soft`；按最坏背景估算不足 4.5:1 时提高不透明度，不加文字阴影。
- **性能**：同屏 ≤ 3 层玻璃、不嵌套；画布拖拽 / 缩放时不改 blur 半径；减弱动效时不做动态高光。
- **现状**：代码里 blur 有 4–28px 十种（抽屉整体 `blur(24px) saturate(150%)` 78% 底、`.flv-glass-shell blur(28px)`、节点角标 `blur(4px)`），统一为 regular 20px / clear 12px 两档；抽屉正文改实底。

### 9.3 磨砂浮层与遮罩（2026-11-16）

用户更正：浮层与放大窗口要**半透明**的高级磨砂（参照 bleep-app，见 [references.md](references.md)），不要不透明底；窗外用 Iris 深色遮罩，不要发白的蒙层。

| Token | 亮 | 暗 | 定义处 |
| --- | --- | --- | --- |
| `--flv-frost-fill` | `color-mix(in srgb, var(--isl-surface) 68%, transparent)` | `… 64% …` | `styles/skillHub.css` |
| `--flv-frost-fill-strong`（菜单） | `… 80% …` | `… 76% …` | 同上 |
| `--flv-frost-blur` | `blur(28px) saturate(175%)` | 同 | 同上 |
| `--flv-frost-edge` / `-highlight` / `-shadow` | 墨色 10% 发丝 + 内高光 + 双层投影 | 墨色 12% + 弱内高光 + 深投影 | 同上 |
| `--flv-frost-fallback` | `… 95% …`（无 backdrop-filter 时） | 同 | 同上 |
| `--flv-scrim` | `color-mix(in srgb, #0d100f 42%, transparent)` | `color-mix(in srgb, #000 56%, transparent)` | `styles/studioHub.css` |
| `--flv-scrim-blur` | `blur(2px)` | 同 | 同上 |

- 背后聊天文字必须糊到读不出：浮层的祖先不能成为 backdrop root。面板外壳的玻璃画在 `::before` 上，外壳自身不写 `backdrop-filter`、`will-change: opacity`（`styles/adaptive.css`）。
- 回退同 §9.2：不支持 backdrop-filter、`prefers-reduced-transparency`、`prefers-contrast: more` → 实底。
- 放大窗口（`components/studio/StudioHub.tsx`）：一个外壳，侧栏 Skills / 历史 / 素材库，窄宽度（≤760px 视口或手动收起）收成 56px 图标栏。

## 10. Shapes / radius

| Token | 值 | 用法 |
| --- | --- | --- |
| `--isl-r-sm` | 6px | 控件、chip、输入、版本按钮 |
| `--isl-r` | 8px | 卡片、节点、面板分区、主按钮（`--isl-r-pill` 当前也是 8px） |
| `--isl-r-lg` | 10px | 弹窗、浮动 chrome |
| 16px | — | 只用于左右停靠面板外壳（两侧必须一致） |
| 999px | — | 只用于状态点、头像、光标标签、run 状态岛收起态 |
| 边框 | 1px | 强调用背景而非加粗；选中 = 1px mint + 外 2px `--isl-mint-bg` |

待收敛：`styles/agent.css` 八种圆角（16 / 14 / 12 / 10 / 9 / 8 / 7 / 999px），停靠抽屉 16px；`rounded-2xl/3xl` 22 处、`border-2` / `border-[1.5px]` 32 处。

## 11. Component captures

### 11.1 文本

| 片段 | 规格 |
| --- | --- |
| 视图标题 | title 15/22 · 600 · `--isl-ink` |
| 元数据行 | caption 10/14 · `--isl-ink-soft`，用 `·` 分隔 |
| 代码 / 命令 | `ui-monospace` 10.5px，底 `--isl-surface-sunk`，圆角 4px |
| 文本层（画布上的标题元素，如“curiosity.”） | 用户 / Agent 的内容字体，不受 UI 字体约束；选中时显示 1px mint 包围框 + 字体光标标签 |

### 11.2 内容单元

| 单元 | 规格 |
| --- | --- |
| 节点卡 | `--isl-card`、1px 边框、8px 圆角、无阴影；媒体区 6px 圆角；标题 11px 600；生成态见 01 §19.6 |
| 素材卡 | 同节点卡；缩略 62px 高；名称 11px 600；元数据 10px |
| 参考帧卡（拖入画布的参考视频帧） | 同节点卡 + 左上 clear 玻璃时间码角标 |
| trace 行 | 高 28px、1px 底线；状态图标 14px · 标题 11px · caller 徽标 9px pill · 耗时 10px tabular |
| run 状态岛 | 收起 34px 高 pill（999px）、展开 10px 圆角；头部玻璃、列表实底 |
| 版本条 | 6px 圆角按钮，选中 mint 底；晚到版本右上 7px mint 点；废片删除线 + ghost |

### 11.3 派生控件

| 控件 | 规格 |
| --- | --- |
| 分段 / 标签 | 槽 `--isl-surface-sunk` 8px 圆角 2px 内边距；选中块 `--isl-card` + `--isl-shadow-sm`，snappy 滑动 |
| 输入 / composer | 底 `--isl-surface`、1px 边框、6–8px 圆角；聚焦 mint 边框；附件拖入时虚线 mint 边 + `--isl-mint-bg` |
| 进度 | 线性 2px（节点底）/ 6px 分段（trace）/ 环形 64px（长任务）；色 mint，轨 `--isl-surface-2` |
| 骨架 | `--isl-surface-2` 实块、同最终尺寸、8px 圆角；扫光 = `--isl-card` 50% 的 30° 渐变带 |
| 确认卡 | `--isl-card`、左 3px `--isl-sun` 边、8px 圆角 |
| 对比滑杆 | 2px 白分界 + 22px 圆形把手（`--isl-shadow`）；两侧 clear 角标标版本 |

### 11.4 Agent 光标（**目标**，行为见 [01](01-interaction.md) §12.3）

- 结构：`MousePointer2` 16px（填充为该 Agent 色）+ 右下偏移 4px 的标签 pill（高 18px、999px 圆角、10px 600 白字、底为该 Agent 色、`--isl-shadow-sm`）。
- 标签内容：子 Agent / 工具角色名（如“我”“字体”“行动”“素材”），超过 6 个汉字截断。
- 正在操作的元素：1px 该色描边 + 四角 6px 手柄 + 左下同色小标签（如“字体：思源黑体”）。
- 用户自己的光标不加标签；协作者（人）用头像而非 pill。

## 12. Underlying logic

| 项 | 规则（代码依据） |
| --- | --- |
| CSS 变量 | 新组件只用 `--isl-*`；`--app-bg` / `--panel-*` / `--text-*` 是壳层别名；主题由 `:root[data-theme='light' \| 'dark']` 覆盖；DSH 宿主内由 `:root[data-dsh-embed]` 映射到 `--dsw-*` |
| 主题 | `ThemeMode = 'light' \| 'dark' \| 'system'`（`types/index.ts`）；`html, body` 背景与文字 `--motion-base` 过渡；`color-scheme` 同步 |
| 断点 | 容器优先：`@container app-shell (width <= 1023px)`、`@container workflow-space (width <= 760px / 900px)`；媒体兜底 360 / 560 / 640 / 720 / 760 / 1023px 与 `max-height: 600px`；断点只表达“放不放得下”，不按设备分支 |
| Hover / 状态 | hover 只换背景或边框（120–140ms `--ease-standard`）；pressed 背景深一级；focus-visible 2px mint 外偏移 2px；disabled 50% 不透明 |
| 列表浮层键盘 | **每个列表浮层**（模型 / Provider / 画布切换 / Skill / @ / 历史 / 素材 / 节点类型 / 设置下拉）都必须支持：打开即可输入筛选（搜索框自动聚焦，浮层内别处的可打印键转给搜索框）、↑/↓ 移动高亮（回绕或夹住、跳过分组标题与禁用项、滚到可见、每次筛选后高亮第一项）、Enter 选中、Esc 先清空搜索再关闭、悬停同步高亮；`listbox` / `option` + `aria-activedescendant`，输入法组字（`isComposing`）中不响应。统一用 `hooks/useListboxKeyboard.ts`（`useListboxKeyboard` / `useMenuKeyboard` / `useSearchGridKeyboard`），不另写键盘逻辑。高亮 = hover 同一层背景（`data-listbox-active`）；已选中项再被高亮时叠 1px 内描边，与「选中」区分 |
| Pointer / 画布 | 画布自有 pan / zoom（`InfiniteWorkflow`）；`data-workflow-overlay` 的浮层 `stopPropagation` 防止误拖画布；手柄命中区 ≥ 24px；拖拽中卡片 `--isl-shadow-lg`、不旋转 |
| 减弱动效 | `@media (prefers-reduced-motion: reduce)`：`--motion-*` → 0.01ms、`--scale-*` → 1（`styles/motion.css` 等 15 段）；**JS 动画需另接** `MotionConfig reducedMotion="user"` / `useReducedMotion()`（现只有 `ProductionSkillDeck` 用了） |
| 减弱透明度 | `prefers-reduced-transparency` / `prefers-contrast: more` → 玻璃实底（§9.2，**目标**） |

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
| 结果由模糊到清晰揭示一次 | 霓虹流光（`#00ff88`）、无限呼吸、彩纸粒子 |
| 光标标签用派生色阶、≤ 6 色 | 每个工具发明一个品牌色 |
| 按容器宽度逐级降级（§15） | 只在一个窗口宽度下设计；靠 `flex-wrap` 把工具行折成两行 |
| 空态、菜单、弹层的类名都有样式定义 | 写了 `className` 却没有 CSS（空态“崩”就是这样来的） |
| 跟随主题的 `color-mix` / token | `rgba(22,22,24,.86)` 这类硬编码深色；`var(--未定义, #1f1f23)` 兜底 |

## 14. Motion

### 14.1 Level

**Medium-low**：只在因果处动（出现、落定、进度、交接），高频交互不动；没有滚动叙事。参考 Apple Motion（有目的、可选、可打断、高频少动）与 Figma 访谈（微动效要解决具体问题）。

### 14.2 Durations

| Token | 值 | 用法 |
| --- | --- | --- |
| `--motion-fast` | 140ms | 颜色、背景、边框 |
| `--motion-base` | 220ms | 主题切换、淡入 |
| `--motion-medium` | 320ms | 视图进入（`workspaceViewEnter`） |
| `--motion-slow` | 420ms | 少用 |
| 退出 | 120–160ms | 菜单关闭、toast 消失 |
| 结果揭示 | 680ms | `flv-gen-reveal`（模糊 → 清晰） |
| 不确定循环 | 1.2–1.6s | 旋转 / 扫光，仅在等待时 |

### 14.3 Easings & springs

已有曲线（保留，均无过冲）：`--ease-standard cubic-bezier(0.4,0,0.2,1)`、`--ease-soft-out (0.22,1,0.36,1)`、`--ease-spring-soft (0.2,0.8,0.2,1)`、`--ease-emphasis (0.16,1,0.3,1)`；新增 `--ease-exit (0.4,0,1,1)`（**目标**）。

弹簧（**目标**）：按 Apple WWDC23《Animate with springs》的 duration + bounce 定义，`mass = 1`、`stiffness = (2π / d)²`、`damping = 4π(1 − bounce) / d`；CSS 用 `linear()` 采样，`transition-duration` 取**落定时长**。JS（`motion` 12.40，已在依赖中）统一写 `{ type: 'spring', visualDuration, bounce }`。

| Token | d / bounce | k / c | 过冲 | CSS 时长 | `linear()` |
| --- | --- | --- | --- | --- | --- |
| `--spring-snappy` | 0.22s / 0 | 816 / 57.1 | 0 | 330ms | `linear(0, 0.121, 0.331, 0.528, 0.681, 0.791, 0.866, 0.915, 0.946, 0.967, 0.98, 0.988, 0.992, 0.995, 0.997, 0.998, 1)` |
| `--spring-smooth` | 0.35s / 0 | 322 / 35.9 | 0 | 520ms | `linear(0, 0.119, 0.328, 0.522, 0.676, 0.787, 0.863, 0.914, 0.946, 0.966, 0.979, 0.987, 0.992, 0.995, 0.997, 0.998, 1)` |
| `--spring-expressive` | 0.42s / 0.2 | 224 / 23.9 | 1.5% | 565ms | `linear(0, 0.108, 0.317, 0.534, 0.713, 0.841, 0.926, 0.976, 1.002, 1.012, 1.015, 1.013, 1.01, 1.007, 1.004, 1.002, 1)` |

| 意图 | 用 |
| --- | --- |
| tooltip、菜单、chip、toggle 拇指、分段指示块 | snappy |
| 侧栏开合、分区切换、网格 ↔ 表格、视角平移、prompt 首页 → 画布 | smooth（尺寸不过冲，只动 transform / opacity） |
| 状态岛展开、元素飞入落定、拖入画布落定、候选扇出 | expressive（bounce ≤ 0.2） |
| Agent 光标移动 | smooth 的位移 + 到达前 80ms 减速（行为见 01 §12.3） |

**现状核对**：motion 弹簧 `420/32`（15 处）≈ 307ms / bounce 0.22；`420/32/mass 0.7`（6 处）≈ 257ms / bounce 0.07；另有 `400/30`、`380/28`、`500/30`（过冲 5.7%）、`600/40`、`320/30`、`120/20` 等十余种；CSS `cubic-bezier(.2,1.4,.3,1)` 类过冲 4.1–6.6%；抽屉对 width 做 `cubic-bezier(.34,1.32,.64,1)`（尺寸过冲 3.4%）。结论：方向对（已用弹簧、有 reduced-motion 段），但需收敛为上表三档。

### 14.4 Hover

只换颜色 / 背景 / 边框，`--motion-fast`；`.motion-surface:hover`（`translateY(-1px) scale(1.015)`）、`.workspace-pill:hover`、`.storyboard-shot-card:hover translateY(-2px)` 待改。

### 14.5 Scroll

产品界面**没有滚动驱动动画**（无 parallax、无 scroll-trigger 揭示）；列表新增项 snappy 淡入；trace 自动滚动在用户上滚后暂停（01 §16.3）。滚动叙事只用于官网 / 宣传页，不进产品。

### 14.6 Canvas

- 视角平移 / 缩放到目标：smooth；用户拖拽画布无缓动（1:1 跟手），松手不加惯性（**现状**，保持）。
- 节点 / 元素落定：expressive，自 8px 上方与 0.96 缩放落到位置，只发生一次。
- 自动整理：所有节点同时 smooth 过渡到新位置，可撤销。
- Agent 光标、飞入、组装：见 01 §12.3–§12.4。
- 减弱动效：位移改为 120ms 透明度；光标直接跳到目标并显示 300ms 静态高亮；循环全部停止。

### 14.7 动效库

保留 `motion`（12.40.0，`motion/react`）。**GSAP 只作为候选，不加依赖**：3.13 起在 Webflow 支持下全部插件免费、可商用，但授权是 Webflow 的 *Standard "No Charge" GSAP License*（非开源），其 Prohibited Uses 包含“让用户无需代码构建视觉动画、与 Webflow 视觉动画构建能力竞争的工具”——Iris 是创作工具，引入前需法务评估。体积（unpkg UMD，gzip）：`gsap.min.js` 28.4KB + ScrollTrigger 18.0KB + Flip 9.7KB + SplitText 3.7KB；本仓库 `motion.js` UMD 44.7KB（`framer-motion.js` 60.8KB）；两者在 Vite 中的 tree-shaken 实际增量**未实测**。现有需求（弹簧、布局动画、手势）motion 已覆盖；只有当需要 FLIP 跨容器重排或文字逐字拆分且 motion 不足时再评估。

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

