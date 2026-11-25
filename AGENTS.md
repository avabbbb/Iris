# AGENTS.md

本文件约束 Iris 的 AI / 自动化开发。优先级：系统 / 开发者指令 > 用户当前明确要求 > 本文件 > 项目文档。用户已确认的新决定覆盖旧稿；历史文档不得反向改变当前产品方向。

## 0. 品牌

- 对外产品名统一为 **Iris**（2026-11-20 由 Flovart 更名；更早的 2026-10 前旧代号也叫 Iris）。顶栏第二个 surface 2026-11-17–11-20 曾叫 Iris，现在叫 **Cut**（内部 `canvasView: 'reverse'` 不变）；旧文档里“Iris surface / 个人 Agent / Iris tab”指的就是现在的 Cut。
- 兼容（2026-11-20 更名）：Agent 工具 `flovart_*` 保留为 `iris_*` 的弃用别名；`VITE_FLOVART_*` / `FLOVART_*` 环境变量作为 `VITE_IRIS_*` / `IRIS_*` 的回退；浏览器 localStorage / IndexedDB 与 `~/.flovart` 首次启动时复制到新名字（`utils/legacyStorageMigration.ts`、`tools/iris/legacy-home.js`），旧数据本版本不删除；`flovart.avabbbb.com` 在过渡期仍是受信 origin。线上协议与持久化格式标识（`flovart:` 模型 id 与事件名、`flovart.*/N` schema 标签、`flovart.skill.yaml`、`x-flovart-*` 头、`data-flovart-*`、`__FLOVART_*__`、`com.flovart.*`、`flovart://`、npm 包 `@flovart/*`）有意保留，改它们是独立迁移。
- canonical 仓库为 `avabbbb/Iris`；仓库或协议迁移不混入普通品牌清理。归档与更名前的视频可保留原名并说明背景。

## 1. 工作方式：遵循 OpenAI GPT-6.2 工程提示建议

优先完成用户已授权的工作；只有关键决定会改变范围、不可逆数据、费用或上线行为时才询问。复用既有类型、工具和业务函数，避免只为抽象而添加 Manager/Facade、第二套 Harness 或冗余 Agent 编排。小改动只查相关文件并跑相应验证；真实宿主、发布、费用相关变更才扩大检查范围。提供真实验证结果，标明未运行的测试。

按任务读取文档：产品定位、状态归属和路线见 `docs/design/00-overview.md`；当前 Canvas/Cut/Agent 职责与宿主 / Skill 路线见 `docs/design/11-iris.md`；交互见 `docs/design/01-interaction.md`；视觉见 `docs/design/DESIGN.md`；能力认证只看 `SUPPORT_MATRIX.md`。不要让每个小改动都强制读完整套文档。仓库历史和 archive 不得反过来决定当前需求。变化中的 SDK、第三方宿主 API、模型能力和许可证必须核对官方资料与实际证据。

## 2. 产品定位与职责

**Iris 是开源、local-first、BYOK 的 Agent-native Creative Production Workspace / OS。** 创作者和可插拔 Personal Agent 共同理解素材与已有工程、制定创作意图、预览修改、非破坏性制作、比较候选，并把被验证的流程沉淀为可复用 Skill。“一个人拥有小型剪辑团队的能力”是长期愿景，不能冒充当前效果或吞吐量承诺。

核心循环：**工程上下文 → 可审查 Proposal → 受控执行 → 真实 Artifact / Run Trace → 精确返工 → 经用户批准的 Skill**。Agent 可以来自内置模型或外部 Codex、Claude Code、DSH 等；Iris 不重造通用云电脑、跨 Agent 会话数据库或原生剪辑引擎。

当前顶栏严格为 **Canvas｜Cut｜Agent**：
- **Canvas**：现有无限画布、GenAI 生成、Workflow、素材与候选版本；未来承载 Spatial Context Card 与可视化评审。
- **Cut**：**已实现的视频剪辑器**（时间线、素材、字幕、编辑、预览与导出），不是旧文档中“尚未上线的个人 Agent tab”。UI 和 Agent 复用 `services/cut/cutStore.ts`；不另存一份 Cut 工程。
- **Agent**：Runtime、Provider/模型、外部 Harness、Skill、连接状态与诊断；同时是画布会话的**放大视图**（同一 Session，不另建会话库）。
- **Canvas Assistant Drawer**：画布会话的**详情视图**：完整 markdown、工具日志、审批与选中素材上下文；不是第四个顶栏。Canvas、Cut、Drawer 与 CLI/MCP 使用对应领域的同一业务实现、权限边界、Run 和 Artifact 引用。

**Agent 嵌在画布里（2026-11-24 用户确认）**：定位语「An infinite canvas for human and agent creation」。以画布为主，参考 Eden 的「卡片即内容」：**Canvas 管空间，Agent 管执行，Cut 管时间**。画布上可以有 Agent 会话卡（`plugin:agent-session`）和轮次卡，它们是 Session 的**投影**：只存 sessionId / entryId 和一段摘录，正文从会话读；不建第二套会话库，工具调用不单独成卡。流式时卡片只显示进度和前几行，完整 markdown、工具日志和审批在 Drawer。Agent 产物放在来源旁边的空位，**绝不移动用户已摆放的节点**。默认不把整张画布交给模型，只给绑定的素材和最少的信息。外部 Agent 只存引用、摘要、回执和产物关系。

**Spatial Context v1 只做 P0+P1**：P0 在消息持久化边界保存真实 session/message ID、显式来源及内容指纹、实际送达媒体，不再靠解析文本恢复结构化关系；P1 由用户明确“钉到画布/Commit”创建独立 `plugin:context-card`，**不复用普通 text 节点**。卡片定稿不被自动重写，Context 关系默认不画 Workflow 实线；讨论使用最新授权素材，Run 自动冻结输入。外部 Agent 保留自己的会话；继续讨论可用卡片结论与素材开启新会话，不假定外部 Session Fork。

**专业宿主是可选连接器**：Resolve 优先只读能力发现与受限上下文，产物在 Iris 审查后先导入 Media Pool；新轨道/替换必须有真机验证、目标版本检查与明确审批。既不静默修改原时间线，也不通过未经验证的私有项目数据库解析/写入来宣称完整 Color/Fusion/Magic Mask 上下文。

**不要构建**：把每条消息 / 每次工具调用都铺成节点（画布只放会话卡、轮次卡这类 Session 投影）、通用第二大脑、第二套 Workflow/Provider/Session Store、无证据的“万能 Resolve API”、默认上传整张画布、未经用户许可的昂贵生成/破坏性写入。细节见当前设计与 Support Matrix。

## 3. 工程原则：短路径、单一权威

- 同一能力只有一份业务实现；CLI / MCP / Host adapter / Iris 光标只做参数、权限上下文、结果转换与可视化。
- 同一任务一个 durable identity、一份状态；重试靠幂等与查询，不复制任务。
- 只有出现第二个真实复用场景、独立状态所有权或必要进程 / 凭据边界时才抽模块；不新增只转发的 Manager / Facade / Coordinator / Repository 层，不为假设建通用总线。
- 确定性工具直接执行，不交给第二个模型重新解释。
- 不因“精简”删除目标绑定、revision、幂等、取消、错误恢复、费用授权、素材持久化或权限校验。
- 不顺手改无关文件；保护已有用户改动；只删已证明被当前路径取代的部分。

## 4. Workflow、生成与素材

Browser Workflow 是稳定 Agent operation 的可见权威；迁移 authority 先改 contract，再改实现与文档。稳定 baseline：`status`、`workflow.inspect`、`workflow.selection.get`、`workflow.apply`、`workflow.node.run`。

```text
UI / Agent / Host entry → same generation/business function → Provider adapter → durable artifact/version → Workflow / Iris / Host consumer
```

- **RunningHub 保持内置**（含预设模型与核验线路），正式商业化前不移除、不隐藏；其他第三方站点优先做成用户自定义脚本。
- 用户自定义脚本、服务地址与模型映射必须随配置导出。

素材需要稳定来源、版本与校验；临时 URL、聊天消息、base64 不能冒充 durable artifact。晚到任务不能覆盖用户已选的新版本。

### 4.1 Agent 视频流水线（现有工具与未验证闭环）

当前实现状态以 `SUPPORT_MATRIX.md` 与实际 Runtime/pipeline 代码为准，历史阶段方案见 `docs/archive/2026-11-24-agentos-alignment/16-agent-video-pipeline.md`。相关施工遵守：

- **trace 唯一权威**：run（durable `runId`）由本地 Runtime 保存 run → step → tool call → artifact → version → review round；Step 由命令边界自动记录，不让模型自己“写日志”。会话与画布节点只存引用。
- **Run 不另建主场**：Canvas（会话卡）、Cut、Drawer（详情）、Agent 页（放大视图）和外部 Agent 引用同一持久 runId/trace 与同一 Session；以实际执行结果为准，不新建旧方案中的独立 Personal Agent Tab 或第二套会话 / Run 存储。
- **工具只投影已有业务函数**：`pipeline.run.*`、`asset.import`、`audio.tts`、`audio.transcribe`、`timeline.align`、`composition.patch`、`composition.render`、`media.probe`、`media.frames`、`review.submit`、`run.archive`、`capture.ui` 先有业务实现再登记 canonical registry；内置 Agent、CLI、MCP、DSH 同一 schema 与权限；只在 run 激活时加载，认证后才按 Support Matrix 升级。
- **不开放任意执行**：内置 Agent 不得获得 shell、任意文件读写或任意 ffmpeg 参数；跑用户仓库、注入演示数据交给外部 Coding Agent，以 `asset.import` 带回同一 run；网页截图录屏只走 `capture.ui`（仅 localhost / 授权文件夹页面，需用户确认）；桌面级真实操作录制将来走 Recordly 连接器或自研伴生工具，产物同样以 artifact 进入同一 run（计划，未实现）。
- **评审可审计**：findings 写明时间点 / 片段、层、问题、修法、结论；修补基于版本号，不改 locked 片段（除非显式解锁并留痕）；轮数受 run 预算约束。
- **素材 durable**：截图、底片、干声、转写证据、静帧、每版渲染都是带 sha256 的 artifact；被否版本标 rejected 保留。
- **本机执行**：Remotion 渲染、WhisperX / hypit 转写、ffmpeg / ffprobe 在本地 Runtime；云端只做 Provider 生成（配音当前经 RunningHub 调 MiniMax speech，key 只走环境变量 / 安全存储）。依赖缺失返回 `CAPABILITY_UNAVAILABLE` 与诊断动作，不静默跳过。
- **费用**：run 级预算（任务数 / 金额 / 最大评审轮数）一次确认，复用 spend mandate 与 Runtime gate；范围变化重新确认。

## 5. Creative host / native effect

宿主扩展只是 projection，不建立第二套 Workflow、Provider、任务或资产系统；边界见 `docs/design/14-creative-hosts.md`，Resolve 实现还须遵循 `integrations/studio/resolve/PRODUCT_UI_SPEC.md`（实现前重新打开 Blackmagic 当前官方页面核对视觉）。

- **宿主轻面板**：当前 selection → intent / reference → plan → generate → import；复杂编排回到 Canvas / Drawer / Cut。面板是宿主原生感的 contextual inspector，不是聊天页、dashboard 或缩小版 Canvas；跟随宿主主题、密度、键盘与焦点。
- **native effect / OFX**：宿主参数、关键帧、固定版本预览与导出；render callback 不联网、不等待模型、不依赖 Agent / Iris 在线。
- 默认新增结果，不静默覆盖；替换必须显式且可恢复。Resolve P0 唯一安全输出是 **Add to Media Pool**，P1 才有 Add to new track，P2 才做 Replace / Commit。
- **Resolve Studio 21.1 first**：宿主操作优先 Blackmagic native MCP；Iris Skill + `iris` CLI 提供生成与 Artifact；不建第二套 Resolve MCP，不为每个 Scripting API 建 wrapper。外部 Agent 的聊天留在 Codex / Claude 等原宿主。
- **宿主上下文连接器**：只读同步工程上下文是第一步，写回仍走上面的安全输出。Resolve 走 native MCP / Scripting；Premiere 走当期 UXP；剪映 6.0+ 草稿加密（待验证；11.7 起外部不可读，待验证），不做破解；CapCut 国际版按明文草稿评估（待验证），实现前按当前版本核对。连接器是 Iris 的可选能力，不是使用 Iris 的前提。
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

- Web：React + TypeScript + Vite + Ant Design + Tailwind + Zustand（以 lockfile 为准）；网页版全静态（无服务端；Cloudflare Worker `worker/index.ts` 只做无状态 `/api/llm-proxy/*`，需要服务端时用 TS 在 Worker 里无状态实现）；Local Runtime：Rust / Tauri；CLI / Agent：Node。不为原生效果复制第二套调度器。
- Workflow：`components/workflow/`、`stores/workflow/`；Iris：当前代码仍在 `components/reverse/`、`services/reverse/`（`_ref/hypit` 不提交），目录改名单独迁移；Agent：`components/agent/`；共享 chrome：`components/studio/`；宿主：`integrations/studio/`。
- 浏览器业务数据用 localforage，localStorage 只放极小配置；宿主长期素材必须是 durable file / artifact。
- 存储形态变化同步 `docs/content/docs/backend/backend-database.mdx`，不用未来字段冒充已建表。

## 8. 验证与发布口径

- 评测总纲是 `eval/eval.md`（评什么、怎么评、Rubric 与 Judge、上线门禁）；新口径改 eval.md 与 `eval/judge/rubrics/`，不另起方法文档。单轮评测与排障按「trace 现象 → 根因 → 修复 → 测试」写进 `docs/quality/<日期>-*.md`，并在 `docs/index.md` 留指针；不另起并列报告。
- 测试匹配改动风险：文档跑 `npm run docs:check`；代码跑相关测试；宿主 / 原生效果进真实应用。
- 普通开发 / PR 走快速通道：只跑与改动直接相关的一轮验证；缺 SDK / 宿主 / 依赖时写 `NOT_RUN locally`，确定性验证可交给 GitHub Actions。10x critical、完整 IrisBench、依赖审计、CodeQL、发布验证、全平台安装包属于 main / scheduled / manual / release，不作普通 PR 前置。secret audit、目标 / revision / 幂等、unknown-after-submit、未授权破坏性写入仍 fail-closed。
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
- `skills/iris/` 是 canonical Skill package；`.agents/skills/iris/`、`.claude/skills/iris/` 是兼容投影，不反转、不手工漂移。
- README outcome-first 且严格跟随 Support Matrix；不复制内部 transport、端口或过时测试数字。

## 10. 提问与执行

只在答案会实质改变产品范围、不可逆数据 / 发布行为或实施路线时提问；一次一个关键问题并给建议。用户已要求直接执行时，不为常规编辑、验证与收尾重复索要许可。回答使用中文，并区分 **已实现 / 已验证 / 设计目标 / 假设**。

## 11. 发版本

只有用户明确要求时才执行版本流程：整理 CHANGELOG、提升 VERSION、提交授权范围内的改动并打 tag。不要自行发布、推送第三方商店或做未授权的生产签名。
