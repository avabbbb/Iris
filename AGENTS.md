# AGENTS.md

给在本仓库工作的 Coding Agent（Codex、Claude Code、Copilot 等）的操作手册。优先级：系统 / 开发者指令 > 用户当前明确要求 > 本文件 > 其他项目文档。用户新确认的决定覆盖旧稿；归档文档与 Git 历史不能反过来决定当前需求。回答用中文，并区分 **已实现 / 已验证 / 设计目标 / 假设**。

## 0. 先读什么

| 任务 | 读 |
| --- | --- |
| 任何任务 | 本文件；文档地图 [docs/index.md](docs/index.md) |
| 产品定位、状态归属、路线图 | [docs/design/00-overview.md](docs/design/00-overview.md) |
| Canvas / Cut / Agent 职责与 AgentOS 路线 | [docs/design/11-iris.md](docs/design/11-iris.md)；Canvas-first 方向以本文 §1 与 DESIGN.md「Canvas-first Agent（规划中）」为准（11 未同步处以这两处为准） |
| 交互行为 | [docs/design/01-interaction.md](docs/design/01-interaction.md) |
| 视觉、动效、组件 | [docs/design/DESIGN.md](docs/design/DESIGN.md) |
| 模块细节 | `docs/design/10`（Canvas）`12`（Agent）`13`（生成 / Runtime）`14`（宿主）`15`（Web / 扩展）`20`（质量） |
| 能不能对外说“支持” | **只看** [SUPPORT_MATRIX.md](SUPPORT_MATRIX.md) |
| 评测方法 | [eval/eval.md](eval/eval.md) |
| 外部 Agent 怎么操作 Iris | `skills/iris/SKILL.md`（canonical Skill） |

小改动只读相关文件，不必通读整套文档。变化中的 SDK、宿主 API、模型能力和许可证必须核对官方资料与实际证据。

## 1. 产品一句话

**Iris — An infinite canvas for human and agent creation. / 人与 Agent 共同创作的无限画布。**（副句：Think spatially. Create with anything. Stay in control. / 在空间中思考，以任何合适的方式创作，始终掌握作品的控制权。）「开源的无限画布 AgentOS」仍可作描述语。一句话原则：**用户在哪里创作，Agent 就在哪里工作。** 人和可插拔的 Agent（内置模型或外部 Codex / Claude Code / DSH）在同一份可见状态上理解素材、提出修改、经审批执行、留下可追溯的产物与 run，再把验证过的流程沉淀为 Skill。“一个人拥有小型剪辑团队的能力”是愿景，不是当前能力或效率承诺。

> 2026-11-24 起的方向是 **Canvas-first**（下文 §1.1–§1.5）。除特别标注“已实现”外，Canvas 内 Agent、Turn Card、Workbench、Code Project 都是**设计目标**；现状以代码和 [SUPPORT_MATRIX.md](SUPPORT_MATRIX.md) 为准，视觉规范见 [DESIGN.md「Canvas-first Agent（规划中）」](docs/design/DESIGN.md)。

顶栏严格为 **Canvas｜Cut｜Agent**（中文 画布｜Cut｜Agent）。三者是同一套会话、素材引用、run 记录和工程产物的**三种视图**（空间 / 执行 / 时间），不是严格流水线：Cut 也可以发起 Agent 任务，结果回到同一份状态。

| 视图 | 目标定位 | 现状（已实现） | 状态权威 |
| --- | --- | --- | --- |
| **Canvas**（空间，默认工作区） | 无限画布；Agent 作为与图片 / 视频 / 文档平级的节点嵌在画布里 | 画布、生成节点、素材 / 版本、Workflow；Agent 对话在右侧 Drawer | Browser Workflow（`components/workflow/store.ts`）；修改带 `projectId + expectedRevision + mutationId` |
| **Agent**（执行）= Agent Workbench | **同一个** session / Run 的放大执行视图：完整对话、计划、实时工程预览、帧检查、终端 / 工具日志、源码 diff、参数、渲染、长任务、预算、审批。从画布「打开工作台」进入，不重发消息、不重选 Skill | 连接与状态页（`AgentConnectionsPage`，`components/agent/AgentWorkspace.tsx`） | 会话归内置 Runtime 或外部 Harness；Workbench 不存第二份对话或工程 |
| **Cut**（时间） | 时间线拼装与交付 | **已实现的浏览器视频剪辑器**（时间线、字幕、属性、代理、导出）+ 子页「故事版 · 逆向」（计划迁移，见 §1.3） | `services/cut/cutStore.ts`；UI 与 `iris_cut_*` 工具共用同一批操作 |
| Right Drawer（Canvas 右侧，**不是**第四个顶栏） | 画布上某个对话的详情视图，可关闭；不是 Agent 的唯一入口 | 内置 Agent 对话、引用、工具调用、审批的唯一入口 | 同上 |

### 1.1 画布上只有四种 Agent 相关对象（设计目标）

| 对象 | 是什么 | 硬约束 |
| --- | --- | --- |
| **Agent Session** | 活的对话卡：绑定素材（连线 / 选中）、模型 + Skill | 绑定内置 Runtime 已有的 session id；不新建会话系统 |
| **Turn Card** | 同一 session 某一轮的**投影**（按 `turnId`） | 只存布局（位置、折叠），不存消息副本；点卡 → Drawer 定位到该轮，反之亦然 |
| **Context Card** | 用户 Commit 的决定，可被其他对话引用 | 只有用户确认才生成；带来源 refs |
| **Artifact / Project** | 图 / 视频 / 文档 / 代码与可编辑工程；`CodeProjectNode` = workspace ref、entrypoint、renderer（`html` / `remotion` / `external`）、revision、preview / rendered artifact ids | 产物是持久 artifact，不是聊天消息、临时 URL 或 base64 |

Agent 节点三态：收起的结论卡 / 原地展开的对话 / 聚焦（Workbench）。一个 session 可拆成多个并行 Agent，共用一条预算 / 审批条。

### 1.2 不要构建

- 第四个顶栏、第二个 Canvas、“万能 Resolve API”、第二套 Workflow / Provider / Task / Session Store、**第二个聊天数据库**或统一多 Agent 会话库。
- Agent 对话轮次**可以**作为 Turn Card 投影到画布（投影、只存布局、由用户控制折叠）；但**不要**不受控地把原始消息气泡倾倒在画布上。
- 不要让 Agent 移动用户手动摆放的节点：新产物自动布局在对话旁，用户放过的位置不动。
- 不要默认上传整张画布：上下文 = 连线 / 选中的对象；剪断连线即移除上下文。
- 未经批准的付费生成或破坏性写入（§5 闸门照旧）。
- 不要把本地 Runtime（Tauri、本机 daemon、Resolve、Hypit CLI、本地 Claude Code / Codex）放上关键路径：它们是可选伴随件，网页版必须独立可用（§1.4）。
- 不要为 Storyboard 再造独立子视图；不要让 Adapter 统一时间线 schema；不要假设 Skill 与 Adapter 一一对应（§1.3）。

### 1.3 Adapter、Skill 与 Storyboard（设计目标）

- **Adapter** 统一的是工程生命周期：`detect` / `capabilities` / `inspect` / `preview` / `collectArtifacts`，**不**统一各家时间线 schema。**Skill ≠ Adapter**，不是一一对应：一个 Skill 可用多个 Adapter，一个 Adapter 服务多个 Skill。
- **Storyboard**：去掉 Cut 下的独立子视图（`components/reverse/IrisStoryboardPage.tsx`、`WorkflowStoryboardView`），数据迁成画布上的结构化 Storyboard 节点；分镜 / 逆向的业务能力保留为 Skill / 工具（`services/reverse/`）。迁移是带数据迁移与测试的独立 PR。

### 1.4 部署现实（静态网页优先）

- 网页版是纯静态站（https://iris.avabbbb.com），部署在 Cloudflare；BYOK，模型请求经 `worker/index.ts` 的无状态 `/api/llm-proxy/*`；业务数据在 IndexedDB（localforage）。没有服务端数据库。
- HTML / JS 代码动画（目标）在沙箱 iframe 里运行：`srcdoc` 或 Blob URL、`sandbox="allow-scripts"`（不加 `allow-same-origin`），通过 `window.seekToFrame(f)` 协议逐帧定位；导出在浏览器内用 WebCodecs / mediabunny / ffmpeg.wasm。
- 画布引擎：当前是 **DOM + CSS transform**（`InfiniteWorkflow.tsx` 的 `.workflow-world`）。`konva` / `react-konva` 虽在 `package.json` 里，但源码没有引用；不要假设画布是 Konva，换引擎需单独决定。
- Tauri / 本地 Runtime（`src-tauri/`、`agent/`、Resolve、Hypit CLI、本地 Claude Code / Codex）是可选伴随件；依赖缺失时返回 `CAPABILITY_UNAVAILABLE`，网页功能不受影响。

### 1.5 路线图（设计目标）

P0 结构化 Turn Context + 稳定 session refs → P1 画布内 Agent Session、行内输入、从选中素材开始 → P2 每轮投影、Drawer 双向定位、产物就近布局 → P3 分叉、Context Card commit 与上下文连线 → P4 Workbench ↔ 画布会话无缝切换 → P5 Code Project（守拙式 HTML / JS 动画、Hypit 工程预览）→ P6 对作品的区间评审、精准返工、Cut 与 Resolve 交付。**P0–P2 是第一次有意义的 UX 测试。**

## 2. 改名：Flovart → Iris（2026-11-20）

产品名、文档、UI、CLI / MCP / Agent 工具名（`iris_*`）、环境变量（`IRIS_*` / `VITE_IRIS_*`）、本机目录（`~/.iris`）、仓库 `avabbbb/Iris`、站点 https://iris.avabbbb.com 已改名。旧文档里把第二个 tab 叫 “Iris / 个人 Agent / 逆向 / Reverse” 的，指的都是现在的 **Cut**。

**仍然存在的遗留标识——不要在普通改动里顺手改名**（它们是线上协议、持久化格式或兼容别名；改它们是带迁移与测试的独立 PR）：

| 遗留标识 | 位置 / 用途 |
| --- | --- |
| `flovart_*` Agent 工具名 | `iris_*` 的弃用别名（`tools/iris/agent-tools.js`）；MCP 仅在 `includeLegacyFlovartNames: true` 时注册（`tools/iris/mcp-server.js`）；`flovart_todo` 是已删除任务清单的无操作别名（`agent/todo.js`） |
| `FLOVART_*` / `VITE_FLOVART_*` | 环境变量回退 |
| `~/.flovart`、浏览器旧 key | 首次启动复制到新名、不删旧数据（`tools/iris/legacy-home.js`、`utils/legacyStorageMigration.ts`） |
| `/agent/flovart/*` | 本机 Agent 旧路径，与 `/agent/iris/*` 并存（`agent/index.js`） |
| `flovart-state.db`、`com.flovart.desktop`、`flovart://` | 桌面 Runtime 数据库、Tauri identifier、深链接 |
| `flovart:` 模型 id 与事件名、`flovart.*/N` schema 标签、`flovart.skill.yaml`、`x-flovart-*`、`data-flovart-*`、`__FLOVART_*__` | 线上协议与持久化格式 |
| npm `@flovart/*`（如 `@flovart/dsh-plugin`）、`npm run flovart:cli` / `flovart:agent` | 包作用域与脚本别名 |
| `canvasView: 'reverse'`、`components/reverse/`、`services/reverse/`、`useReverseStore` | Cut 的内部视图 id 与故事版 · 逆向代码；目录改名是单独迁移 |
| CSS `--flv-*`、`.flv-glass` / `.flv-frost`、`--iris-*`（Cut / 故事版的玻璃色板） | 样式命名，见 DESIGN.md |
| `flovart.avabbbb.com` | 过渡期仍是受信 origin（扩展配对、本机 Agent bootstrap） |

## 3. 架构地图（真实路径）

```text
App.tsx / appMain.tsx / RouterHost.tsx      应用入口；StudioTopMenu 切换 Canvas | Cut | Agent
components/
  workflow/      画布：InfiniteWorkflow、节点、store.ts、operations / operationRegistry（节点工具）、nodeToolCatalog
  cut/           Cut 剪辑器 UI（CutPage、CutEditor、CutTimeline、CutInspector、CutSubtitlePanel）
  reverse/       Cut 的「故事版 · 逆向」子页（IrisStoryboardPage、ReverseWorkbench）
  agent/         内置 Agent 面板（IrisAgentPanel）、确认 / 计划 / 提问卡、Agent 连接页（AgentWorkspace.tsx 的 AgentConnectionsPage）
  studio/        共享外壳：StudioTopMenu、StudioRightDrawer、StudioHub、motionTokens
  brand/         NaiwaThinking（奶蛙思考动画）
services/
  browserAgentKernel.ts / browserAgentRuntime.ts   内置 Agent 内核（pi-agent-core）
  agentToolPolicy.ts       审批：read / write / exec 分级 + spend / delete 硬闸
  agentSpendMandate.ts、generationGate.ts、generationPlan.ts、runApproval.ts   费用授权、预估、计划卡
  agentTaskStore.ts、browserAgentTasks.ts           后台任务台账（IndexedDB）
  cut/            cutStore、timeline、actions、agentTools（iris_cut_*）、render / exportTarget（Mediabunny、OPFS）
  reverse/        逆向拆解纯函数
  aiGateway.ts、providerAdapter.ts、runningHub*.ts、geminiService.ts   Provider 适配
stores/          Zustand 全局 store（useWorkspaceStore 等）
styles/          全部 CSS（token 在 index.css，见 DESIGN.md）
tools/iris/      Node CLI（cli.js）、canonical 命令注册表（registry.js + contracts/runtime/command-registry.v1.json）、
                 stdio MCP（mcp-server.js）、Agent 工具名（agent-tools.js）、视频流水线（pipeline/）
agent/           本机 Agent 服务（index.js：HTTP + SSE，/agent/iris/*；task-store.js 任务台账 ~/.iris/agent-tasks.json）
src-tauri/       桌面壳与 Rust Runtime（src/runtime/：任务、worker、Provider、pipeline trace、迁移）
worker/index.ts  Cloudflare Worker：静态资源 + 无状态 /api/llm-proxy/*（网页版没有其他服务端）
server/          Vite 开发期的 LLM 代理插件
integrations/    studio/（Resolve、Premiere、Photoshop、After Effects 面板）、workbuddy/、teleagent/
dsh-plugin/      DeepSeek Harness 插件（独立 package，自己的 npm ci / build）
extension/       浏览器扩展
skills/iris/     canonical Agent Integration Skill（.agents/skills/iris、.claude/skills/iris 是投影）
remotion/        Remotion 合成（故事版预览、流水线渲染）
eval/            评测：规则层、judge/、aigc/、red-team.mjs
tests/           Vitest（*.test.ts / .tsx / .js）
third_party/opencut/  Cut 编辑器 UX 来源说明（见 docs/adr/cut-editor.md）
```

旧 Go 后端（`backend/`）已于 2026-11-17 删除（回滚点 tag `go-backend-final`）；不要再引入服务端数据库。需要服务端逻辑时，用 TypeScript 在 Worker 里无状态实现。CLI 帮助文本里残留的 “Vite/Go/Docker” 字样是过时字符串，不代表 Go 服务仍存在。

### 3.1 Canvas-first Agent 的落点（复用现有文件，不建并行系统）

下列路径均已在仓库中核对存在（2026-11-24）；“落点”列是**设计目标**，不是已实现能力。

| 功能 | 复用的现有文件 | 落点 |
| --- | --- | --- |
| 会话权威 / 稳定 session ref（P0） | `services/browserAgentKernel.ts`（pi-agent-core session，localforage key `iris.agent.sessions.<projectId>`）、`components/agent/IrisAgentPanel.tsx`（`activeSessionId`） | Agent Session、Turn Card 只引用这里的 session id / turnId。`WorkflowProject.agentSessions`（`components/workflow/types.ts`）是项目格式里的旧字段，当前代码只初始化为空、不写入，**不要**把它扩成第二份会话库 |
| 轮次切分 / Turn Context（P0、P2） | `components/agent/agentConversationNavModel.ts`、`AgentConversationNav.tsx`、`agentTranscript.ts`、`agentTurnText.ts`、`agentMessageRefs.ts` | 稳定 turnId 从现有“一轮 = 一条用户消息 + 其后回复”的切分派生；Drawer 定位复用 Conversation Nav |
| Right Drawer / 打开工作台 | `components/studio/StudioRightDrawer.tsx`、`components/agent/AgentDrawerSections.tsx`、`components/workflow/agentDrawerRequest.ts`、`components/agent/AgentWorkspace.tsx` | Drawer = 对话详情；Workbench 是 Agent 视图承载同一 session（替换 / 扩展现有连接页，连接与状态收进 Workbench 的二级入口） |
| 选中素材开始讨论、@ 引用（P1） | `stores/useAgentGroupInboxStore.ts`（`pushAgentGroup`，已有「添加到 Agent」）、`components/agent/AgentReferenceChip.tsx`、`AgentReferencePreview.tsx`、`components/workflow/WorkflowNodeLasso.tsx` | 复用 @ 引用与批量选择 chip；连线即上下文 |
| 画布节点 / 连线 / 布局（P1–P3） | `components/workflow/InfiniteWorkflow.tsx`、`WorkflowNode.tsx`、`WorkflowConnections.tsx`、`arrange.ts`、`agentOps.ts`、`draftAuthority.ts`、`services/workflowAgentBridge.ts` | Agent Session / Turn / Context / Code Project 作为新节点类型进入同一 Workflow（带 revision + 幂等）；就近布局只放新节点 |
| Skill 启动 | `components/agent/ProductionSkillDeck.tsx`、`services/productionSkillLaunch.ts`、`stores/useProductionSkillComposerStore.ts` | 画布行内输入与 Workbench 共用同一 Skill 选择，切视图不重选 |
| 计划 / 预算 / 审批 / 长任务 | `components/agent/agentRunPlanStore.ts`、`AgentRunPlanCard.tsx`、`services/agentToolPolicy.ts`、`services/agentTaskStore.ts`、`services/browserAgentTasks.ts`；本机 `agent/task-store.js` | 并行 Agent 共用一条预算 / 审批条，数据仍走这些台账 |
| 外部 Agent 与工作区 | `agent/workspace-lease.js`（带 revision 的工作区租约）、`agent/host-projection.js`（把 Iris Skill 投影到外部 Agent 宿主——**不是** Turn 投影） | 外部 Harness 写画布仍经租约与 revision |
| 产物登记 | `services/studio/artifactRegistry.ts`、`services/productionProjectionAdapter.ts` | Artifact / CodeProjectNode 的 artifact id 与 run 引用 |
| Cut 与 Agent | `services/cut/agentOps.ts`、`agentTools.ts`、`render.ts`、`exportTarget.ts` | Cut 内的范围评论走现有 `iris_cut_*` 操作 |
| Storyboard 迁移 | `components/reverse/IrisStoryboardPage.tsx`、`components/workflow/WorkflowStoryboardView.tsx`、`productionBible.ts`、`stores/useReverseStore.ts`、`services/reverse/` | 数据迁成画布 Storyboard 节点，能力留作 Skill / 工具 |

## 4. 命令（都来自 package.json / Makefile / CI）

| 目的 | 命令 |
| --- | --- |
| 安装 | `npm install`（CI 用 `npm ci`）；Node.js ≥ 22.19.0。DSH 插件另需 `npm --prefix dsh-plugin ci` |
| 开发（UI + 本机 Agent） | `npm run iris:cli -- start --source --web --open`；隔离端口：`--web-port=0 --agent-port=0 --no-open --json` |
| 只起 Vite | `npm run dev`（默认 37522）；Docker：`make up`（1635） |
| 单测 | `npm test`（`vitest run`）；单文件 `npx vitest run tests/<name>.test.ts`；关键套件重复跑 `npm run test:critical` |
| 类型检查（本仓库没有 ESLint / Prettier，tsc 就是 lint） | `npx tsc --noEmit` |
| 文档契约 | `npm run docs:check`（Skill 投影一致、文档里的命令都在注册表、版本号一致） |
| 构建 | `npm run build`；扩展 `npm run ext:build`；宿主包 `npm run studio:build`；DSH `npm --prefix dsh-plugin run build` |
| Rust Runtime | `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` |
| 发布前检查 | `npm run version:check`、`npm run release:red-team`、`npm run release:secret-audit`、`git diff --check` |
| 流水线 e2e | `npm run e2e:pipeline`（`:parity`、`:remotion`、`:capture`） |
| 浏览器冒烟 | `npm run test:browser:chrome`（Chrome for Testing、隔离 profile 与端口；不要用 `--open`） |
| 评测 | `npm run eval:validate`、`eval:core`、`eval:agent`、`eval:judge`、`eval:aigc` |

验证匹配风险：纯文档跑 `docs:check`；代码跑相关测试 + `tsc`；宿主 / 原生效果必须进真实应用。缺 SDK / 宿主 / 依赖时写 `NOT_RUN locally` 并说明原因。完整 IrisBench、依赖审计、CodeQL、全平台安装包属于 main / 定时 / 发布流程，不是普通 PR 前置。

**改了命令注册表**（`tools/iris/contracts/runtime/command-registry.v1.json` 或 `registry.js`）时，同步 `src-tauri/tests/runtime_contract.rs` 里钉住的 registry hash、`release-red-team` 的公开面白名单，以及 `skills/iris/` 与 `.agents/skills/iris/` 的命令文档（两者必须逐字节一致，`docs:check` 会查）。

## 5. 安全规则（代码里真实存在的闸门，不得绕过或削弱）

- **付费生成要批准。** `services/agentToolPolicy.ts` 把工具分为 `read` / `write` / `exec`，并有两个硬闸：`spend`（可能产生费用，只有生效中的付费授权能放行）和 `delete`（永远逐次确认）。即使 `yolo` 模式也不跳过硬闸。新付费工具必须声明为 spend，并在计划卡 / 预估（`workflow.cost.estimate`、`planGenerationGate`）中可见。
- **只读和写入分开。** 只读命令（inspect、nodes.search、cost.estimate、node.tool.list、`iris_cut_get_*` 等）不弹确认；任何写入走审批。新增工具时在 policy 里给出正确 tier，不要把写入伪装成 read。
- **Agent 自填的批准无效。** `budgetConfirmed` / `confirmed` 只接受 CLI 或界面的一次性批准；无人值守（委派）回合里任何需要询问的调用直接拒绝（fail closed）。
- **提交状态未知时先查询，不重试扣费。** 后台任务按 command + 参数哈希去重；`unknown_submit` 需要显式确认才可重提；会话预算提交前原子预留。
- **Workflow 修改**必须带目标、revision 与幂等键；晚到结果不能覆盖用户已选的版本。临时 URL、聊天消息、base64 不是持久产物。
- **宿主只走官方 API。** Resolve 面板经 Media Pool `ImportMedia` 导入候选（`integrations/studio/resolve/main.js`）；**不要直接读写 Resolve 工程数据库或解析私有 .drp / .drx / Project.db 来宣称工程理解**。写回分级：P0 Add to Media Pool → P1 新轨道 → P2 Replace / Commit，后两级需真机验证与明确审批。
- **内置 Agent 不开放任意执行**：没有 shell、任意文件读写或任意 ffmpeg 参数；本地文件只经用户授权的文件夹（`iris_local_folder` / `iris_grep`）；网页截图录屏只走 `capture.ui`（localhost / 授权页面，需确认）。
  Workbench（规划中）里的终端 / 工具日志只展示外部 Harness 或本地 Runtime 的真实输出，不因此给内置 Agent 开 shell；代码动画只在沙箱 iframe（不含 `allow-same-origin`）里执行。
- **凭据**：API Key 只在本机加密存储（`utils/keyVault.ts`）或安全存储；不得进入提示词、日志、Skill、宿主工程、素材 metadata 或仓库。Agent / CLI 只拿脱敏后的就绪状态。外部 Agent 不得直接写 React / Zustand 状态、浏览器存储、Runtime 数据库或 Provider 私有 API。
- 发版、打 tag、推送、商店上架、生产签名只在用户明确要求时做。

## 6. 工程约定

- **一份业务实现。** CLI / MCP / DSH / 宿主面板 / 内置 Agent 只做参数、权限、结果转换；新能力先写业务函数，再登记 canonical registry 与各投影。确定性工具直接执行，不交给第二个模型重新解释。
- **短路径。** 只有出现第二个真实复用、独立状态所有权或进程 / 凭据边界时才抽模块；不加只转发的 Manager / Facade / Coordinator / Repository。
- **不因“精简”删掉**目标绑定、revision、幂等、取消、错误恢复、费用授权、素材持久化或权限校验。
- 技术栈：React 19 + TypeScript + Vite + Tailwind 4 + Ant Design + Zustand（以 lockfile 为准）；动效库 `motion`（GSAP 未经决定不得加依赖）；桌面 Tauri / Rust；CLI / 本机 Agent 为 Node ESM。
- 浏览器业务数据用 localforage / IndexedDB，localStorage 只放极小配置；存储形态变化同步 [backend-database.mdx](docs/content/docs/backend/backend-database.mdx)。
- RunningHub 保持内置（含预设模型与线路）；其他第三方站点优先做成用户自定义脚本，并随配置导出。
- `.editorconfig`：UTF-8、LF、末尾换行。提交信息用 Conventional Commits（`feat(cut): …`、`fix(agent): …`、`docs(…): …`）。不顺手改无关文件，保护已有用户改动。
- 代码注释和文档多为中文，保持所在文件的语言。

## 7. UI 约定（细节见 DESIGN.md）

- 只用 DESIGN.md 里的 token（`--isl-*`、`--space-*`、`--motion-*`、`--spring-*`）；不写裸 hex、不加 `rounded-2xl` / `border-2` / `font-extrabold`、不自定义过冲曲线。
- 玻璃只给浮动 chrome（工具条、左右停靠面板外壳、菜单、弹窗外壳），不进节点主体、正文、trace、表格；必须有 `prefers-reduced-transparency` / `prefers-contrast` / 无 `backdrop-filter` 的实底回退。动效遵守 `prefers-reduced-motion`。
- 弹性布局是硬要求：按组件自身宽度用 `@container` 逐级降级，被收起的功能保留入口。新 `className` 必须有对应 CSS。
- 新 UI 必须挂到真实入口；mock-only 面板不算交付。持续任务显示真实状态，不能用动画掩盖失败或未知提交。
- UI 验收：真实入口截宽 / 中 / 最小三档 + 收起态，亮暗各一组，截图附在 PR。设计或动效改动前先查参考（Inspora、Awwwards、GSAP Showcase、Refero），在 [references.md](docs/design/references.md) 登记出处。
- **卡片即内容**（Canvas-first，规划中）：画布上的 Agent / Turn / 产物卡默认不显示徽标、模型名、时间戳、版本、来源列表、按钮行，只在选中 / 悬停时出现；嵌入对话固定尺寸，未选中时滚轮缩放画布、选中后才滚动消息。细则见 DESIGN.md「Canvas-first Agent（规划中）」。
- 奶蛙（`components/brand/NaiwaThinking.tsx`）是 Agent 的形象：只头部 + 托腮的手，用于思考 / 工作状态，不改造型与关键帧。

## 8. 文档放在哪

| 内容 | 位置 |
| --- | --- |
| 当前产品与系统设计（current truth） | `docs/design/`，上限 12 份 Markdown；产品变化改 00、交互改 01、视觉改 DESIGN.md、模块变化改 10–15 |
| 架构决策 | `docs/adr/`（如 `cut-editor.md`）；被取代时在文件头标 Superseded，不删 |
| 进行中的计划 / 提案 | `docs/plans/`，标状态；完成或作废即归档 |
| 用户指南 | `docs/overview/`（中文为主，`quick-start.en.md` 是英文版） |
| 对外进度 | `docs/content/docs/`：`features(.en).mdx` 已有功能、`progress/todo.mdx` 只放未完成、`progress/pending-test.mdx` 已实现待验证 |
| 单轮评测 / 排障记录 | `docs/quality/<日期>-*.md`，写“trace 现象 → 根因 → 修复 → 测试”，并在 docs/index.md 留指针；问题修完或转入 todo 后归档 |
| 评测方法 | `eval/eval.md` 与 `eval/judge/rubrics/`，不另起方法文档 |
| 支持等级 | `SUPPORT_MATRIX.md`（唯一能升级支持状态的地方） |
| 历史 | `docs/archive/<日期>-<主题>/`，用 `git mv` 移入，在 [docs/archive/README.md](docs/archive/README.md) 写一行“是什么 / 为什么归档 / 被谁取代”，并修好所有入链（含代码注释） |

- README 以中文为主（`README.zh-CN.md`），`README.md` 是同步的英文版，`README.en.md` 只是指向 `README.md` 的跳转页。README 区分“已实现”与“规划中”，严格跟随 Support Matrix，不复制内部端口细节或过时测试数字。
- 不新增并列的 CURRENT / TARGET / AUDIT / GOAL / HANDOFF / 对标报告类文档。
- 不宣传未验证的实时生成、宿主 Stable、完全离线、云同步、无缝 Agent 登录态迁移或跨平台等价。

## 9. 视频流水线与 run（Experimental）

现状以 `SUPPORT_MATRIX.md` 与 `tools/iris/pipeline/`、`src-tauri/src/runtime/` 为准；历史方案见 [archive/2026-11-24-agentos-alignment/16-agent-video-pipeline.md](docs/archive/2026-11-24-agentos-alignment/16-agent-video-pipeline.md)。

- trace 唯一权威是本地 Runtime（run → step → tool call → artifact → version → review round），Step 由命令边界自动记录，不让模型“写日志”；画布、Cut、会话只存 `runId` / version 引用。
- 产物（截图、干声、转写、静帧、每版渲染）都是带 sha256 的 artifact；被否版本标 rejected 保留；修补基于版本号，不改 locked 片段。
- Remotion 渲染、转写、ffmpeg 在本机执行；依赖缺失返回 `CAPABILITY_UNAVAILABLE`，不静默跳过。run 级预算一次确认，范围变化重新确认。

## 10. 提问与执行

只在答案会实质改变产品范围、不可逆数据、费用或发布行为时提问，一次一个关键问题并给出建议。用户已要求直接执行时，常规编辑、验证与收尾不重复索要许可。报告真实验证结果，标明哪些没跑。
