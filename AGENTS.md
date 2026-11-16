# AGENTS.md

本文件约束 Flovart 的 AI / 自动化开发。优先级：系统 / 开发者指令 > 用户当前明确要求 > 本文件 > 项目文档。用户已确认的新决定覆盖旧稿；历史文档不得反向改变当前产品方向。

## 0. 品牌

- 对外产品名统一为 **Flovart**；新 UI、标题、宿主面板、README 与当前文档不再引入 Iris 品牌。
- CLI、Skill、package、环境变量中的 `flovart` 不动；旧 `iris-*` 数据库字段、协议字段、持久化 key、兼容 ID、已存素材路径保持兼容，只清理纯展示、CSS 与新导出文件名。
- canonical 仓库为 `avabbbb/Flovart`；仓库或协议迁移不混入普通品牌清理。归档与更名前的视频可保留原名并说明背景。

## 1. 开始前先确认当前事实

先读 `docs/index.md` → 相关 current-truth 文档 → 真实代码与 `SUPPORT_MATRIX.md`。产品与系统目标见 `docs/design/00-overview.md`；交互行为见 `docs/design/01-interaction.md`（简单直接、不硬编码、不死锁）；视觉与动效 token 见 `docs/design/DESIGN.md`；模块细节见 `docs/design/1x-*.md`。不要从 archive、旧 audit、release evidence 或 Git 历史推导当前需求。

会变化的 SDK、宿主 API、许可证、模型 / Provider 能力按当前日期核验官方文档与真实源码。构建通过、mock 通过、manifest 存在都不等于真实宿主 / 账号已认证。

## 2. 产品地图：三个顶级 surface

产品场景：① 爆款视频逆向与复刻（参考视频 → 拆解 → 用户自己的角色 / 素材批量做变体）；② 剪辑宿主插件（达芬奇首发：读时间轴与素材做局部替换、特效、生成素材）；③ 游戏素材替换（暂缓）。

顶栏固定为 **画布 Canvas｜逆向 Reverse｜Agent**（原 Table 已移除，不保留 `table` 视图）：

| Surface | 拥有 | 交接 |
| --- | --- | --- |
| **Canvas** | GenAI 生成与 Workflow 基本盘：节点、连线、生成任务、素材、版本 / take / batch、`workflow.*` 命令 | 被逆向与外部 Agent 调用；选中节点可交给逆向 |
| **Reverse（逆向 · 全能助手）** | 强模型把电脑与画布当工具的多 Agent 工作区：prompt 首页、run（计划 → 步骤 → 评审轮次 → 版本）、画布上带标签的 Agent 光标、docked 侧栏（trace / 计划 / 审批）、预览与版本对比；Hypit 式逆向拆解是它的一组工具与一个面板 | 调用 Canvas 与 Generation 的同一命令；使用 Agent 页供应的 Agent 与模型 |
| **Agent** | Agent 连接与状态管理：runtime、模型 / Provider 路由、外部 Agent（Codex、Claude Code、DSH）发现 / 准备 / 健康 / 每个 Agent 的状态、Skill 安装 | 向逆向供应 Agent 与模型；不放对话、不放 run 编辑，最多只读“最近 run”跳转 |

- **Canvas Assistant drawer** 保留为轻量上下文入口（就地问答、单步操作）；多步制作“在逆向中继续”，进入同一个 run（同一 runId）。不复制到 Agent 页，不做 Host 连接管理。
- **禁止只有聊天的整页**。逆向是 prompt 优先、以画布与可见产物为主体的工作区，对话只是侧栏中的输入与 run 卡片——这不属于聊天页。也不要引入 Tasks / Artifacts / Context 工作区、Production Crew / Director / Operator 必经层、Production Skill Marketplace 或第二套 Canvas / Workflow。
- **Hypit 复刻边界**：以 gitignored `_ref/hypit` 为参照对齐分层、数据模型、术语与数据流，代码在 `services/reverse/` 自写；不复制 Hypit 源文件，不把 `@hypit/*` 打进 bundle（附加条件的 Apache-2.0 与本仓库 MIT 冲突）。WhisperX / ffmpeg / 渲染走本地 Runtime 或用户自装的 hypit CLI，结果作为 durable artifact 导回。
- **Recordly / Snipaste 边界**：Recordly 是 AGPL-3.0 + 附加条款（UI 与仓库署名、禁用其名称），Snipaste 闭源。主仓库（MIT）不复制、不打包 Recordly 源码，移植成 Rust 仍算衍生作品；只通过连接器调用用户自装的 Recordly、导入其导出文件，Snipaste 只借鉴交互。路线与分期见 `docs/plans/recordly-capture-hub.md`（计划草案）。
- 外部 Agent 默认走 **Skill + CLI**；MCP 是同一 operation contract 的可选投影。内置 Agent（逆向 / 抽屉）、宿主面板与外部 Agent 复用同一业务能力与权限边界。

## 3. 工程原则：短路径、单一权威

- 同一能力只有一份业务实现；CLI / MCP / Host adapter / 逆向光标只做参数、权限上下文、结果转换与可视化。
- 同一任务一个 durable identity、一份状态；重试靠幂等与查询，不复制任务。
- 只有出现第二个真实复用场景、独立状态所有权或必要进程 / 凭据边界时才抽模块；不新增只转发的 Manager / Facade / Coordinator / Repository 层，不为假设建通用总线。
- 确定性工具直接执行，不交给第二个模型重新解释。
- 不因“精简”删除目标绑定、revision、幂等、取消、错误恢复、费用授权、素材持久化或权限校验。
- 不顺手改无关文件；保护已有用户改动；只删已证明被当前路径取代的部分。

## 4. Workflow、生成与素材

Browser Workflow 是稳定 Agent operation 的可见权威；迁移 authority 先改 contract，再改实现与文档。稳定 baseline：`status`、`workflow.inspect`、`workflow.selection.get`、`workflow.apply`、`workflow.node.run`。

```text
UI / Agent / Host entry → same generation/business function → Provider adapter → durable artifact/version → Workflow / Reverse / Host consumer
```

- **RunningHub 保持内置**（含预设模型与核验线路），正式商业化前不移除、不隐藏；其他第三方站点优先做成用户自定义脚本。
- 用户自定义脚本、服务地址与模型映射必须随配置导出。

素材需要稳定来源、版本与校验；临时 URL、聊天消息、base64 不能冒充 durable artifact。晚到任务不能覆盖用户已选的新版本。

### 4.1 Agent 视频流水线（PROPOSAL，`docs/design/16-agent-video-pipeline.md`）

实现进度以 16 §12 为准。被接受前，相关施工遵守：

- **trace 唯一权威**：run（durable `runId`）由本地 Runtime 保存 run → step → tool call → artifact → version → review round；Step 由命令边界自动记录，不让模型自己“写日志”。会话与画布节点只存引用。
- **主场在逆向**：run 在逆向发起与驱动；画布写入以可见 Agent 光标呈现；Canvas 抽屉只交接到同一 run（当前已有抽屉 run 卡片与“放到画布”版本分组作为轻量入口）；外部 caller 写入同一条 trace。
- **工具只投影已有业务函数**：`pipeline.run.*`、`asset.import`、`audio.tts`、`audio.transcribe`、`timeline.align`、`composition.patch`、`composition.render`、`media.probe`、`media.frames`、`review.submit`、`run.archive`、`capture.ui` 先有业务实现再登记 canonical registry；内置 Agent、CLI、MCP、DSH 同一 schema 与权限；只在 run 激活时加载，认证后才按 Support Matrix 升级。
- **不开放任意执行**：内置 Agent 不得获得 shell、任意文件读写或任意 ffmpeg 参数；跑用户仓库、注入演示数据交给外部 Coding Agent，以 `asset.import` 带回同一 run；网页截图录屏只走 `capture.ui`（仅 localhost / 授权文件夹页面，需用户确认）；桌面级真实操作录制将来走 Recordly 连接器或自研伴生工具，产物同样以 artifact 进入同一 run（计划，未实现）。
- **评审可审计**：findings 写明时间点 / 片段、层、问题、修法、结论；修补基于版本号，不改 locked 片段（除非显式解锁并留痕）；轮数受 run 预算约束。
- **素材 durable**：截图、底片、干声、转写证据、静帧、每版渲染都是带 sha256 的 artifact；被否版本标 rejected 保留。
- **本机执行**：Remotion 渲染、WhisperX / hypit 转写、ffmpeg / ffprobe 在本地 Runtime；云端只做 Provider 生成（配音当前经 RunningHub 调 MiniMax speech，key 只走环境变量 / 安全存储）。依赖缺失返回 `CAPABILITY_UNAVAILABLE` 与诊断动作，不静默跳过。
- **费用**：run 级预算（任务数 / 金额 / 最大评审轮数）一次确认，复用 spend mandate 与 Runtime gate；范围变化重新确认。

## 5. Creative host / native effect

宿主扩展只是 projection，不建立第二套 Workflow、Provider、任务或资产系统；边界见 `docs/design/14-creative-hosts.md`，Resolve 实现还须遵循 `integrations/studio/resolve/PRODUCT_UI_SPEC.md`（实现前重新打开 Blackmagic 当前官方页面核对视觉）。

- **宿主轻面板**：当前 selection → intent / reference → plan → generate → import；复杂编排打开 Flovart。面板是宿主原生感的 contextual inspector，不是聊天页、dashboard 或缩小版 Canvas；跟随宿主主题、密度、键盘与焦点。
- **native effect / OFX**：宿主参数、关键帧、固定版本预览与导出；render callback 不联网、不等待模型、不依赖 Agent / Flovart 在线。
- 默认新增结果，不静默覆盖；替换必须显式且可恢复。Resolve P0 唯一安全输出是 **Add to Media Pool**，P1 才有 Add to new track，P2 才做 Replace / Commit。
- **Resolve Studio 21.1 first**：宿主操作优先 Blackmagic native MCP；Flovart Skill + `flovart` CLI 提供生成与 Artifact；不建第二套 Resolve MCP，不为每个 Scripting API 建 wrapper。外部 Agent 的聊天留在 Codex / Claude 等原宿主。
- After Effects（CEP + C++ Effect SDK）保持 Experimental，暂停扩张；Photoshop / Premiere 按当期官方 UXP API 实现。
- Provider key、Agent token、OAuth 或私有凭据不得进入宿主工程、Skill、日志或素材 metadata。
- 真实宿主认证覆盖：安装、目标绑定、生成 / 导入、取消 / 失败、保存重开、素材缺失、离线导出；native effect 另覆盖参数持久化、随机帧、色彩 / alpha / 帧率与关键帧。

## 6. UI、交互与动效

- **参考先行**：设计或实现任何 UI / 动效前，先查参考并在 PR 中引用实际打开的页面——Inspora（灵感）、Awwwards（审美校准）、GSAP Showcase（动效与交互）、Refero Styles（风格系统与 DESIGN.md，有 MCP）；规则见 `01-interaction.md` §18。
- 视觉只用 `docs/design/DESIGN.md` 的 token：不写 hex、不加 `rounded-2xl` / `border-2`、不自定义过冲曲线；动效用三档弹簧（snappy / smooth / expressive），可打断，遵守 reduced-motion；**玻璃只给浮动 chrome**（包括节点工具条、左右停靠面板外壳、工具弹窗外壳），不进入节点主体、正文、trace、表格；左右面板外壳必须同一套。
- 动效库保持 `motion`；GSAP 只是候选（授权含竞品限制，需评估），未经决定不得加依赖。
- 复用 container-driven layout；不要重新引入 viewport inset 补丁。新 UI 必须挂到真实入口并验证可见路径；mock-only 面板不算交付。
- 持续任务显示真实状态，不能用动画掩盖未知提交、失败或 Provider 未响应。PromptBar、ElementToolbar 与原始媒体比例行为按现有产品保持。
- **弹性布局是硬要求**（DESIGN.md §15）：UI 按组件自身宽度用 `@container` 逐级降级（文字 → 截断 → 图标 + title → 收纳 → 整块收成图标），不许只按一个窗口宽度做静态稿。工具行 `nowrap` + 文字 `min-width:0`；居中绝对定位浮条加 `width:max-content`；可拖面板拖过最小宽度就吸附收起；被隐藏的功能必须保留入口。
- **样式要落地**：新写的 `className`（尤其空态、菜单、弹层）必须有对应 CSS，提交前用 grep 核对；禁止硬编码深色 rgba 和 `var(--未定义, #hex)` 兜底，统一用主题 token / `color-mix`。
- **UI 验收**：在真实入口截宽 / 中 / 最小三档宽度 + 收起态，亮暗各一组，逐张检查重叠、折行、半截字、裁切，截图附在 PR 里。只截一个宽度不算验收。

## 7. 代码边界

- Web：React + TypeScript + Vite + Ant Design + Tailwind + Zustand（以 lockfile 为准）；网站后端：Cloudflare Pages Functions（TS，`server/hub/` + `functions/api/`）+ D1 + R2，迁移在 `migrations/`；旧 Go + Gin + GORM 版 `backend/` 待下线，不再新增功能；Local Runtime：Rust / Tauri；CLI / Agent：Node。不为原生效果复制第二套调度器。
- Workflow：`components/workflow/`、`stores/workflow/`；逆向：`components/reverse/`、`services/reverse/`（`_ref/hypit` 不提交）；Agent：`components/agent/`；共享 chrome：`components/studio/`；宿主：`integrations/studio/`。
- 浏览器业务数据用 localforage，localStorage 只放极小配置；宿主长期素材必须是 durable file / artifact。
- 新增数据表同步 `docs/content/docs/backend/backend-database.mdx`，不用未来字段冒充已建表。

## 8. 验证与发布口径

- 评测总纲是 `eval/eval.md`（评什么、怎么评、Rubric 与 Judge、上线门禁）；新口径改 eval.md 与 `eval/judge/rubrics/`，不另起方法文档。单轮评测与排障按「trace 现象 → 根因 → 修复 → 测试」写进 `docs/quality/<日期>-*.md`，并在 `docs/index.md` 留指针；不另起并列报告。
- 测试匹配改动风险：文档跑 `npm run docs:check`；代码跑相关测试；宿主 / 原生效果进真实应用。
- 普通开发 / PR 走快速通道：只跑与改动直接相关的一轮验证；缺 SDK / 宿主 / 依赖时写 `NOT_RUN locally`，确定性验证可交给 GitHub Actions。10x critical、完整 FlovartBench、依赖审计、CodeQL、发布验证、全平台安装包属于 main / scheduled / manual / release，不作普通 PR 前置。secret audit、目标 / revision / 幂等、unknown-after-submit、未授权破坏性写入仍 fail-closed。
- 真实支持状态只由 `SUPPORT_MATRIX.md` 升级；Provider 认证区分 Fake fixture 与真实账号、扣费、429、取消、unknown-submit。
- 不宣传未验证的实时生成、宿主 Stable、完全离线、云同步、无缝 Agent 登录态迁移或跨平台等价。
- 浏览器验收用 Chrome for Testing / 动态隔离端口；临时文件放 `.tmp/` 或 `artifacts/`。

## 9. 文档治理

`docs/index.md` 是文档地图（current truth / 提案 / 指南 / 归档）。

- `docs/design/` 最多 **12 份** Markdown：`00-overview`、`01-interaction`（交互与行为）、`DESIGN.md`（视觉与动效 token）、模块文档 `10–15`、`20-quality-and-governance`，以及同时存在的提案（`16+`，最多 2 份）。超过先合并或归档。`docs/design/prototypes/` 只放 01 引用的单文件 HTML 原型，不计份数。
- 不新增并列的 CURRENT / TARGET / AUDIT / GOAL / HANDOFF / 清单 / 对标报告类文档。产品变化改 00；交互改 01；视觉改 DESIGN；模块变化改对应模块文档。
- 提案标 **PROPOSAL / REFERENCE**，接受后蒸馏进 current truth 再归档。`docs/plans/` 只放进行中的计划；完成或作废即归档。
- `todo.mdx` 只放未完成；已实现待现实验证进 `pending-test.mdx`；验证后更新 features。
- 历史施工包、对标报告、面试材料、阶段性 launch checklist 不留在 active tree：移到 `docs/archive/<日期>/` 并在 `docs/index.md` 留指针。
- `skills/flovart/` 是 canonical Skill package；`.agents/skills/flovart/`、`.claude/skills/flovart/` 是兼容投影，不反转、不手工漂移。
- README outcome-first 且严格跟随 Support Matrix；不复制内部 transport、端口或过时测试数字。

## 10. 提问与执行

只在答案会实质改变产品范围、不可逆数据 / 发布行为或实施路线时提问；一次一个关键问题并给建议。用户已要求直接执行时，不为常规编辑、验证与收尾重复索要许可。回答使用中文，并区分 **已实现 / 已验证 / 设计目标 / 假设**。

## 11. 发版本

只有用户明确要求时才执行版本流程：整理 CHANGELOG、提升 VERSION、提交授权范围内的改动并打 tag。不要自行发布、推送第三方商店或做未授权的生产签名。
