# 提案：Agent 驱动的产品宣传片流水线（Agent Video Pipeline）

> 状态：**PROPOSAL**（2026-11-13；§6 放置同日修订为“逆向 = 全能助手主场”；2026-11-17 逆向改名 Iris，改为对话优先、画布为产出面）。本文是提案，不是 current truth；被接受后按 AGENTS.md §9 蒸馏进 [00 总体设计](00-overview.md)、[12 Agent](12-agent.md)、[13 Generation & Runtime](13-generation-runtime.md)、[10 Canvas / Workflow](10-canvas-workflow.md)，再归档本文。
> **实施进度（2026-11-15）**：P0 的工具层与 trace 已在 `main` 实现并端到端跑通（见 §12）：trace 在 Runtime 共用的 `flovart-state.db`（migration 5）；Remotion 文字 / 字幕 / 音频轨、`capture.ui`、MCP 投影、CJK 字体已上线；配音经 RunningHub 调 MiniMax speech 已真实实测。Canvas 抽屉 run 卡片与画布版本分组是轻量入口，Iris 对话栏与 Agent 光标、DSH 投影、直连 MiniMax 与 WhisperX 实测尚未完成，本文仍是提案。桌面级真实操作录制另见 [录制与剪辑 Hub 计划](../plans/recordly-capture-hub.md)。
> 标注约定沿用总纲：**已实现** = 代码在主干；**已验证** = 有 Support Matrix 证据；**设计目标** = 尚未实现；**假设** = 待真实环境确认。本文“Iris 今天”一列全部来自 2026-11-13 `main`（`b92e29b`）真实代码核对，不来自旧文档。

## 0. 一句话

让 Iris **内置 Agent** 在用户本机，从 brief 到成片自由调用工具，跑完一条可审计的 trace：取真实素材 → 写稿分镜 → 生成实景 / 配音 → 对齐 → 代码合成 → 渲染 → **看真实帧做评审 → 只改指定秒数 → 再渲染**，多轮迭代并把每一版、每条音轨、每次评审归档。外部 Agent（Codex、Claude Code、DSH）通过 Skill + CLI / MCP 调用**同一批操作**，写进**同一条 trace**。

## 1. 参考流水线（BaiFu《连做 4 条百万曝光产品宣传片》方法拆解）

参考文章的分工：Codex / Claude Code 读产品仓库、注入演示数据、运行产品截取真实 UI、导出原生动效、跑脚本、调用配音与视频接口、测音频时长；Claude 负责审美、分镜、镜头接力与剪辑节奏；Seedance 生成实景底片（含“黑屏设备”合成底片）；MiniMax speech 生成干声；Remotion 用代码合成；ffmpeg 处理；按真实渲染帧一版一版改（作者从 v1 磨到 v51），并把成片、工程与独立音轨归档。文章给出的“六轮对话”是：备料 → 三栏脚本 + 静态关键帧 → 两种声线试听并测动作时间戳 → 首条 MP4 小样 → 锁住满意部分只改具体秒数、另存新版对比 → 以小样为模板扩成完整片并归档。

从中抽出的能力步骤（C 编号供下文引用）：

| # | 能力 | 文章中的具体动作 |
| --- | --- | --- |
| C1 | Brief / 定位 | 给谁看、发在哪、看完记住哪一句；画幅、语言、时长 |
| C2 | 参考片拆解 | 拆关键帧与镜头关系，说明“学哪一点、不学哪一点” |
| C3 | 读产品仓库 | 读源码，找支撑卖点的真实功能与最顺路径 |
| C4 | 演示数据注入 | 往测试环境注入干净的公开演示数据，避免私人信息 |
| C5 | 真实 UI 采集 | 运行产品 / 模拟器截图、录屏，导出源码里的原生动画 |
| C6 | 素材盘点 | 分成“项目里可取 / 代码动画可做 / 需要生成”三组，汇报缺口 |
| C7 | 三栏脚本与分镜 | 旁白 / 屏幕短字 / 画面操作三栏；先出静态关键帧定版面 |
| C8 | 显示稿与口播稿分离 | 字幕显示原拼写，送 TTS 的口播稿用谐音 |
| C9 | 图像 / 视频生成 | Seedance 实景底片、黑屏设备底片；先出 1 条小样再批量 |
| C10 | TTS 配音 | MiniMax speech-2.8-hd，两种声线 A/B 试听，锁定 voice_id / 语速 / 音高 |
| C11 | 音频时长与词级时间戳 | 测干声时长，标出“提问 / 输入 / 点开”落在第几秒 |
| C12 | 字幕 | 底部字幕、安全区、不遮挡 UI |
| C13 | 音乐 / 音效 / 闪避 | 干声、音乐、音效三轨分开；有人声时自动压低音乐 |
| C14 | 代码合成（Remotion） | 按音频时间戳排镜头、推拉、卡片展开、转场 |
| C15 | 屏幕跟踪合成 | 黑屏底片四角跟踪、透视变换、轨迹平滑、手指前景遮罩、保留玻璃反光 |
| C16 | ffmpeg 处理 | 转码、裁剪、拼接、抽帧、混音、探测（黑帧 / 静音） |
| C17 | 渲染导出 | 小样 / 成片 MP4，横竖版 |
| C18 | 帧级评审 | 静音看一遍、开声音看一遍、缩小看一遍；抽“接触前 / 中 / 后”放大帧；无黑帧、无字幕遮挡 |
| C19 | 批评 → 定向修补 | 把“感觉不好”拆成“第 8 秒切太快”；锁住满意部分只改指定秒数 |
| C20 | 版本追踪与对比 | 另存新版、保留上一版、左右同步对比 |
| C21 | 素材库与归档 | 成片、工程、独立音轨、废片、声线试听统一归档 |
| C22 | 费用与审批 | 限制单轮生成次数，小样确认后再批量 |
| C23 | 长流程编排 | 多轮对话、可中断、可恢复，全程可追溯 |

## 2. 能力矩阵：需要什么 vs Iris 今天有什么

“今天”列：**有** = 已实现且内置 Agent 能调用；**部分** = 代码有但缺关键一段或 Agent 调不到；**缺** = 没有实现。

| 能力 | 用于 | Iris 今天 | 差距 / 需要的工作 | 优先级 |
| --- | --- | --- | --- | --- |
| C1 Brief / 定位 | 全片目标、画幅、时长 | **部分**：`iris_ask` 表单提问、`iris_web_search`（`services/browserAgentKernel.ts`、`agent/todo.js`）；没有结构化 Brief | 定义 `brief` 作为 run 的第一个 artifact（受众、渠道、核心一句、画幅、语言、时长、预算） | P0 |
| C2 参考片拆解 | 学镜头关系 | **部分**：Iris 逆向拆解纯函数层（`services/reverse/narrative.ts`、`align.ts`、`caption.ts`、`composition.ts`）、节点工具 `video-extract-frame`、`reverse-prompt`、`iris_workflow_media_view` 抽任意秒数帧 | Reverse 拆解结果可作为 run 输入（`reverseProjectId`）；Agent 侧有读取 Reverse 工程的只读入口 | P1 |
| C3 读产品仓库 | 找卖点与路径 | **部分**：`iris_grep` 只搜已授权本地文件夹的文本（`services/agentLocalGrep.ts`）；内置 Agent 提示词明确“不得访问 Shell、任意文件” | 内置 Agent 保持只读授权目录；需要跑脚本 / 启动项目时交给外部 Coding Agent（见 §6） | P1 |
| C4 演示数据注入 | 干净的演示状态 | **缺**（属于用户产品仓库，不是 Iris 能力） | 不在 Iris 内实现；由外部 Coding Agent 在用户仓库完成，Iris 只记录为 trace 中的外部步骤 | P2 |
| C5 真实 UI 采集 | 截图 / 录屏 / 原生动效 | **缺**：Agent 无截图 / 录屏工具；仓库有 `playwright` 依赖但只用于测试 | 新增 Runtime 能力 `capture.ui`（本机 Playwright 打开用户给的本地 URL，按步骤截图 / 录屏 → durable artifact）；P0 先用“外部 Agent 或用户放进授权文件夹 → `asset.import`” | P1（P0 走导入） |
| C6 素材盘点 | 缺口清单 | **部分**：`asset.list`（CLI，Agent 内置工具不可用）、本地文件夹引用（`services/localFolderSource.ts`） | `asset.list` 支持按 run / tag 过滤并进入 pipeline 工具集 | P0 |
| C7 三栏脚本与分镜 | 镜头规划、静态关键帧 | **部分**：`script` 节点与 `ScriptNodeEditor.tsx`、`services/shotPlanning.ts`、`components/workflow/productionBible.ts`、`WorkflowStoryboard.tsx`、`batch.plan` | 脚本行增加 `narration / displayText / speechText / visual` 字段；静态关键帧 = 合成 spec 的单帧渲染（复用 C17） | P0 |
| C8 显示稿 / 口播稿分离 | 防读错品牌名 | **缺** | 同上字段；TTS 只读 `speechText`，字幕只读 `displayText` | P0 |
| C9 图像 / 视频生成 | 实景底片 | **有**：`workflow.node.run` → `services/workflowGeneration.ts` → `services/aiGateway.ts`；Seedance 经 RunningHub（Beta 待认证）或直连（Experimental）；Runtime `generate.image` / `generate.video` | 生成结果需落成 run 内 durable artifact（见 C21）；内置 Agent 已可调 | — |
| C10 TTS 配音 | 干声、声线 A/B | **部分**：`services/voiceCatalog.ts` 有 MiniMax / OpenAI 音色，配置面板可选音色（`WorkflowConfigPanel.tsx`），但浏览器执行直接返回“音频生成暂未支持”（`services/workflowGeneration.ts`）；Runtime `audio.tts` 只走 Windows 语音引擎（`src-tauri/src/runtime/worker/local_media.rs`） | 在 `services/providerGenerationAdapter.ts` 增加 TTS 路由（MiniMax speech 优先），Runtime `audio.tts` 改为按 route 分派（Windows 引擎降为离线兜底）；输出带时长与参数 | **P0** |
| C11 时长与词级时间戳 | 镜头卡点 | **部分**：`services/reverse/evidence.ts` 能导入 WhisperX / `hypit.transcript@1` JSON；`align.ts` 做叙事↔词对齐；没有转写执行器 | Runtime 新增 `audio.transcribe`（本机 WhisperX 或用户自装 hypit CLI），产出证据 artifact；ffprobe 测时长 | **P0** |
| C12 字幕 | 底部字幕 | **部分**：`services/reverse/caption.ts`（CaptionDocument + Timing）；Runtime `media.render` 用 ffmpeg 烧字幕；Remotion `ProductionVideo.tsx` 不画字幕 | 合成 spec 增加 caption 轨，Remotion 组件渲染并保留安全区 | P0 |
| C13 音乐 / 音效 / 闪避 | 混音 | **缺**：`production.rs` 中 `audio.music` 直接 `CAPABILITY_UNAVAILABLE`；无 ducking | 合成 spec 支持多音轨（voice / music / sfx）与音量包络；音乐先只支持导入，不做生成 | P1 |
| C14 代码合成（Remotion） | 时间线 | **部分**：`remotion/Root.tsx` + `components/reverse/ProductionVideo.tsx` 只按镜头顺序铺图片 / 视频；`services/reverse/productionSpec.ts` 的 ProductionSpec V1 只从逆向工程派生，无音频 / 文字 / 动画 | ProductionSpec V2（= 合成 spec）：视频 / 图片 / 文字 / 字幕 / 音频轨、镜头 `locked`、关键帧；可由 Agent 修订 | **P0** |
| C15 屏幕跟踪合成 | 真实 UI 长进实景 | **缺** | P1 先支持手动四角关键帧 + 透视（Remotion 内实现）；自动跟踪、手指遮罩 P2 | P2 |
| C16 ffmpeg 处理 | 剪、拼、抽帧、探测 | **部分**：浏览器 ffmpeg.wasm 节点工具（trim / merge / extract-frame / av-split / audio-trim / speed / pitch / stem-split，`components/workflow/operationRegistry.ts`、`services/videoTools.ts`、`services/audioTools.ts`）；Runtime 原生 ffmpeg / ffprobe 只用于 `media.render` | 增加受控 `media.probe`（时长、编码、黑帧、静音、响度）；不开放任意 ffmpeg 命令行 | P0 |
| C17 渲染导出 | MP4 | **部分**：`scripts/render-production.mjs`（Remotion `renderMedia`）存在但没有任何调用方；Runtime `media.render` 是 ffmpeg 拼接 + 字幕 + 旁白（`local_media.rs`） | `composition.render` = Runtime 任务，engine 选 `remotion`（调用上述脚本）或 `ffmpeg-concat`；结果是 durable artifact | **P0** |
| C18 帧级评审 | 看真实画面 | **部分**：`iris_workflow_media_view`（`services/agentMediaView.ts`）可对图片 / 视频节点按秒抽帧（单次 ≤6 张）；只认画布节点，不认 Runtime artifact；没有音频理解 | `media.frames` 支持 artifact、时间列表、两版并排；`media.probe` 自动检查黑帧 / 静音；音频评审靠转写回读（C11） | **P0** |
| C19 批评 → 定向修补 | 多轮修 | **部分**：`ProductionShotV1.locked` 已有“锁定镜头”语义；`workflow.apply` 有 revision + 幂等；没有结构化评审记录 | `review.submit`（发现项：时间点 / 层 / 问题 / 修法 / 结论）+ `composition.patch`（基于版本号的局部修改，尊重锁） | **P0** |
| C20 版本追踪与对比 | v1 → vN | **部分**：节点批次候选与 `set_batch_primary`、晚到结果作为新版本、`draftLog`（200 条）、会话分支 `branchSession`；Runtime 表 `production_spec_revisions` 已存在 | 合成 spec 的每次修订 = 一个版本，复用 `production_spec_revisions`；每次渲染挂在版本上；画布上用一个分组显示各版成片 | **P0** |
| C21 素材库与归档 | 可回溯、可交付 | **部分**：Runtime 内容寻址 artifact（`artifact.locate`、sha256）；浏览器 `services/studio/artifactRegistry.ts` 仅 30 分钟 TTL、最多 64 条；`projectTransfer.ts` 导出为 dataUrl JSON；Reverse 左侧库有 Tasks / Artifacts | run 内所有产物都进 Runtime artifact store；`run.archive` 输出归档清单（成片、spec、音轨、废片、评审）到用户目录 | P1（P0 先保证全部是 durable artifact） |
| C22 费用与审批 | 控制花费 | **有（部分）**：`services/agentSpendMandate.ts`（自动模式任务数 / 金额上限）、`services/agentToolPolicy.ts`（OMP 式审批：read/write/exec tier + always-ask/write/yolo 模式 + 按工具策略 + 会话授权；不是沙箱）、Runtime `production_gates` / `run_budgets` / `usage_ledger` | run 级预算（任务数、金额、最大评审轮数）一次授权，范围变化重新确认 | P0 |
| C23 长流程编排 / trace | 多轮、可恢复 | **部分**：会话按项目存 localforage（`services/browserAgentKernel.ts`）；运行日志 `useAgentActivityStore.ts`（内存 200 条）；Runtime `runtime_events` / `production_runs` / `stage_runs` 持久；内置 Agent 工具只有 `AGENT_BROWSER_COMMANDS`（`tools/iris/agent-surface.js`）+ 节点工具 + 搜索 / grep / ask / 看图 / todo，**调不到** `task.*`、`artifact.locate`、`asset.list`、`generate.*`、`production.*` | 新增 run → step → tool call → artifact → version → review round 的持久 trace（§4），由命令边界自动记录；内置 Agent 在 run 内按需加载 pipeline 工具集 | **P0** |

### 2.1 2026-11-15 复核（上表“今天”列为 11-13 基线，以本节为准）

| 能力 | 现状 | 依据 |
| --- | --- | --- |
| C5 真实 UI 采集 | **部分**：网页截图 / 录屏已实现；桌面 App、模拟器、真实光标与点击事件未覆盖 | `capture.ui`（§12.3）；桌面录制见 [Hub 计划](../plans/recordly-capture-hub.md) |
| C8 显示稿 / 口播稿分离 | **有** | `audio.tts` 读 `speechText`，字幕读 `displayText` |
| C10 TTS 配音 | **有**：fake / minimax / runninghub 路由，RunningHub 已真实实测 | `voice.js`、`npm run trial:runninghub-tts` |
| C11 时长与词级时间戳 | **部分**：`audio.transcribe` + `timeline.align` 已实现，WhisperX / hypit 未实测 | §12.3 |
| C12 字幕 / C14 代码合成 | **有**：ffmpeg 与 Remotion 两条引擎都画文字、字幕、音频 | `render.js`、`ProductionVideo.tsx` |
| C13 音乐 / 闪避 | **部分**：音乐导入与固定 25% 闪避；无音乐生成、无可调包络 | §12.3 |
| C15 屏幕跟踪合成 | **缺** | P1 / P2 |
| C16–C21 | **有**：`media.probe`、`composition.render`、`media.frames`、`review.submit` + `composition.patch`、版本与画布分组、`run.archive` | §12.1 |
| C23 trace | **有**：命令边界自动记 Step；Iris 中的 trace UI 未做 | §12 |
| 三级镜头 / 设备样机 / 点击圈 / 卡片展开 | **缺** | 与 Hub 计划 H1 同一组能力 |

矩阵要点：

1. **生成能力不是瓶颈**：图像 / 视频生成、节点工具、看帧、费用授权都已经在内置 Agent 手里。
2. **断在“后半程”**：TTS 不能执行、没有转写、Remotion 渲染脚本没人调、合成 spec 只能画镜头、评审与版本没有结构化记录。
3. **最大的结构缺口是 trace**：现在的会话、运行日志、Runtime 任务三处各记一段，没有一条把“这一轮做了什么、产出哪一版、评审说了什么”串起来的权威记录。

## 3. 建议的 Agent 工具集

原则（与 AGENTS.md §3、§4 一致）：

- 每个工具**只包装一份已有业务函数**；没有现成实现的先实现业务函数，再在注册表 `tools/iris/contracts/runtime/command-registry.v1.json` 登记，CLI / MCP / DSH / 内置 Agent 都从注册表投影。
- 这些工具组成 **pipeline 工具集**，只在一个 run 激活时加载给内置 Agent；**不加入**稳定 baseline（`status`、`workflow.inspect`、`workflow.selection.get`、`workflow.apply`、`workflow.node.run`），认证后再按 Support Matrix 升级。
- 所有写操作带 `runId` + `mutationId`；同 ID 同载荷返回原结果，同 ID 不同载荷拒绝。
- 付费调用走现有 spend mandate 与 Runtime gate；本地计算（渲染、转写、探测）不收费但要显示进度、可取消。

| 工具（注册表名） | 输入 | 输出 | 包装的业务实现 | 审批 / 费用 | 幂等键 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `pipeline.run.start` | projectId、brief、budget{maxTasks, maxCost?, maxRounds}、reference?{reverseProjectId \| artifactIds} | runId、briefArtifactId | Runtime `production_sessions` / `production_runs`（新增 run kind `agent`） | 创建时一次性确认预算 | mutationId | 设计目标 |
| `pipeline.run.get` | runId、since? | run 摘要、steps、versions、rounds、spend、blockers | Runtime store 读取 | 只读 | — | 设计目标 |
| `asset.import` | source：授权文件夹引用 \| 浏览器导入项 \| Runtime 授权路径；tags | artifactId、sha256、媒体信息 | `ingestWorkflowMedia` / `services/browserImportArtifacts.ts` / Runtime artifact store | 无 | 内容哈希 | 部分（实现分散，需统一出口） |
| `asset.list` | runId?、tags?、kind? | artifact 列表 | 现有 `asset.list` 扩展过滤 | 只读 | — | 部分 |
| `capture.ui` | url（仅 localhost / 用户授权）、steps[]、viewport、mode: screenshot \| video | artifactIds | 新增 Runtime 执行器（本机 Playwright） | 启动本地进程前确认一次 | mutationId | 已实现（Node 边界） |
| `workflow.*` / `workflow.node.run` / `workflow.node.tool` | 现有 | 现有 | 现有 | 现有 | 现有 | 已实现 |
| `audio.tts` | lines[{speechText, displayText}]、voice{route, voiceId, speed, pitch}、variants? | 每条 artifactId、durationMs、参数快照 | 新 TTS provider 路由（`providerGenerationAdapter.ts`）+ Runtime `audio.tts` 分派 | 付费；按条数计入 mandate | 输入摘要（文本 + 声线参数） | 设计目标（P0） |
| `audio.transcribe` | artifactId、engine: whisperx \| hypit、language | evidenceArtifactId（`hypit.transcript@1`） | 新 Runtime 执行器 + `services/reverse/evidence.ts` 解析 | 本地免费 | 文件哈希 + 引擎版本 | 设计目标（P0） |
| `timeline.align` | script 行、evidenceArtifactId | 每行 / 每个动作词的毫秒时间 | `services/reverse/align.ts` + `projection.ts`（纯函数） | 只读计算 | — | 部分（函数已实现，未暴露） |
| `composition.patch` | runId、baseVersion、ops[]（增删改轨道 / 片段 / 文字 / 字幕 / 关键帧）、locks[] | version（vN）、diff 摘要 | ProductionSpec V2 + `production_spec_revisions` | 免费；修改锁定片段需显式 `unlock` | mutationId，baseVersion 冲突要求重读 | 设计目标（P0） |
| `composition.render` | runId、version、preset: still \| draft \| final、atSec?（still） | taskId → artifactId | Runtime `media.render` 增加 engine `remotion`，执行 `scripts/render-production.mjs` | 本地免费；可取消 | (version, preset, atSec) | 部分（脚本存在、无调用方） |
| `media.probe` | artifactId | 时长、编码、分辨率、黑帧区间、静音区间、响度 | Runtime ffprobe / ffmpeg 滤镜（受控参数） | 只读 | 文件哈希 | 设计目标（P0） |
| `media.frames` | artifactId 或 nodeId、times[]、compareWith?（另一版本）、zoom? | 图片（≤6 张 / 次） | `services/agentMediaView.ts` 扩展到 Runtime artifact | 只读 | — | 部分 |
| `review.submit` | runId、version、findings[{atSec \| range, layer, severity, issue, fix}]、verdict: pass \| revise \| block、reviewer: agent \| user | roundId | 新 Runtime 记录 | 无 | mutationId | 设计目标（P0） |
| `run.archive` | runId、include[final, spec, stems, rejected, reviews] | archive 清单 artifact、目录路径 | Runtime artifact store + 导出 | 写用户目录前确认 | runId + 版本集 | 设计目标（P1） |
| 现有辅助 | `iris_ask`、`iris_web_search`、`iris_grep`、`task.get` / `task.cancel` | — | 现有 | 现有 | 现有 | 已实现（`task.*` 需加入内置工具集） |

不提供：任意 shell、任意 ffmpeg 参数、任意文件读写、直接写 React store。需要这些的步骤（跑用户仓库、注入演示数据）属于外部 Coding Agent，结果用 `asset.import` 带回。

## 4. Trace 模型

### 4.1 层级

```text
Run（一次宣传片制作；durable identity = runId）
├─ brief（artifact）
├─ Step[]（按序；每一步 = 一次工具调用）
│   ├─ tool、caller（built-in / codex / claude-code / dsh / user）、argsDigest、mutationId
│   ├─ status：queued → running → succeeded | failed | canceled | unknown_submit
│   ├─ taskId?（Runtime 任务）、cost?（预估 / 实际）
│   └─ artifactIds[]（产出）
├─ Version[]（v1…vN；= 合成 spec 的一次修订）
│   ├─ specRevisionId、parentVersion、locks[]、diff 摘要
│   └─ Render[]（preset、artifactId、probe 结果）
└─ ReviewRound[]（挂在某个 Version 上）
    ├─ findings[]（atSec / range、layer、severity、issue、fix）
    ├─ verdict：pass | revise | block
    └─ fixedBy：下一个 Version
```

### 4.2 存储与归属

- **Run / Step / Version / ReviewRound 由本地 Runtime（SQLite）保存**，复用 `production_sessions`、`production_spec_revisions`、`production_runs`、`runtime_tasks`、`runtime_events`、`usage_ledger`、`run_budgets`；新增一张 `run_steps` 与一张 `review_rounds`（迁移脚本放 `src-tauri/src/runtime/migrations/`）。不建第二套任务系统。
- **Step 由命令边界自动写**：`tools/iris/operation-gateway.js` / `services/workflowAgentBridge.ts` 在执行带 `runId` 的命令时记录，模型不负责“记账”，也就无法漏记或伪造。
- 内置 Agent 会话仍在浏览器 localforage（现状），会话只保存 `runId` 引用；外部 Agent 的会话留在 Codex / Claude / DSH 自己那里。
- 画布侧只保存引用：run 的各版成片以视频节点出现在一个分组里（复用批次候选 + `set_batch_primary` 语义），节点 metadata 记 `runId` / `version`。

### 4.3 评审循环

```text
composition.render(vN, draft) → media.probe → media.frames(关键时间点 + 与 vN-1 对比)
→ review.submit(vN, findings, verdict)
   ├─ pass  → 可进入 final 渲染 / 扩写 / 归档
   ├─ revise→ composition.patch(baseVersion=vN, ops 只动 findings 对应的片段, locks 保持) → vN+1 → 再渲染
   └─ block → 停下，用 iris_ask 问用户（缺素材、需付费、方向分歧）
```

- 每轮 findings 必须引用具体时间点或片段 ID；“整体不好”不是合法 finding。
- 用户在画布或对话里给的意见也写成 `review.submit(reviewer: user)`，与 Agent 评审同一结构。
- 循环上限 = `budget.maxRounds`；达到上限或连续两轮 findings 相同即停，报告卡点，不无限重试。

### 4.4 重试与恢复

- Runtime 任务沿用现有语义：UI 关闭不取消；重启先恢复；`unknown_submit` 先查询不重提。
- 页面刷新后：Iris 读取 `pipeline.run.get`，从最后一个未完成 Step 继续；已完成 Step 不重放（幂等键命中返回原结果）。
- 晚到结果作为新产物挂在原 Step 上，不覆盖用户已选版本。

## 5. 素材管理与归档

- **一切中间产物都是 durable artifact**：截图、录屏、生成底片、干声、转写证据、静帧、每一版渲染。临时 URL、base64、`artifactRegistry` 的 30 分钟缓存都不算。
- Artifact 元数据：runId、stepId、version?、kind（capture / generated / voice / evidence / render / still / archive）、tags、sha256、媒体信息、来源（provider route 或本地引擎及版本）、非秘密参数快照（例如声线 voice_id / 语速 / 音高）。
- **废片保留**：被评审否掉的版本、未选中的声线试听不删除，标记 `rejected` 并保留评审原因——参考文章的经验是“废片库”本身有价值。
- **锁**：版本中被用户确认的片段（镜头、声线、字体）标记 locked；`composition.patch` 修改 locked 片段必须显式解锁并在 trace 中留痕。
- **归档**（`run.archive`）：在用户选定目录生成 `<run 名>/final/`、`spec/`（各版合成 spec JSON）、`stems/`（voice / music / sfx）、`rejected/`、`reviews.md`、`manifest.json`（sha256 清单）。归档复制字节；画布与 Runtime 只存引用。
- 用户授权文件夹仍是引用语义（`local-folder:<folderId>/<相对路径>`），进入 run 时由 `asset.import` 生成指纹，文件变化时提示重新定位。

## 6. 放在哪里：Iris（原 逆向）是主场

> **2026-11-17**：顶栏第二个 tab 由 逆向 改名 **Iris**（个人 Agent），交互改为对话优先、画布为产出面（[01](01-interaction.md) §12）。下文已按新名更新；侧栏分区的描述以 01 §12.5 为准。
>
> **2026-11-13 修订**：本节原结论“在 Canvas 的 Assistant 抽屉里发起和驱动 run”已被 2026-11-13 的产品放置决定取代。下文为现行方案；原结论与代码依据保留在 §6.4 作为历史，不再生效。产品地图见 [00](00-overview.md) §3.1，交互见 [01](01-interaction.md) §11–§12。

### 6.1 结论

- **Iris（顶栏中间，个人 Agent）是 run 的主场**：从对话发起（可拖入参考视频，或由已连接的宿主带入上下文）；画布是产出面（与 Canvas 同一 Workflow），也是 Agent 的工具之一——`workflow.inspect / apply / node.run / viewport.set` 以带标签的 Agent 光标可见地执行；trace、计划 / 待办与审批作为卡片出现在对话栏；评审修补以版本 v1…vN 呈现。
- **画布 Canvas**：GenAI 生成与 Workflow 基本盘；被 run 调用；节点上带 `runId` / `version` 与 `origin=agent`。
- **Agent 页**：供应 run 使用的 Agent、模型 / Provider 路由与 Runtime 健康；不放对话、不放 run 编辑。
- **Canvas Assistant 抽屉**：保留为轻量上下文入口（就地问答、单步操作）；多步请求或已有 run 时显示 run 条与“在 Iris 中继续”，切换后进入**同一个 run**（同一 runId，不复制会话）。
- **逆向拆解**（Hypit 式转写 / 对齐 / timeline）是 run 的一组工具和一个面板，不再是独立工作台；“用作宣传片参考”即把参考视频拖进 Iris 对话。

### 6.2 为何改变（相对原抽屉方案）

| 原方案的局限 | 新方案 |
| --- | --- |
| 抽屉宽度有限，trace + 计划 + 审批 + 对话 + 待处理卡挤在一列（见 01 §19.4 D10） | docked 侧栏可加宽、分区可见；画布占主体 |
| run 的过程只在列表里，画布上的写入“突然出现” | 每次写入都是可见光标动作，trace 与元素双向高亮 |
| 多 Agent / 外部 caller 无法区分谁在做什么 | 每个子 Agent / caller 一个带标签的光标与 trace 徽标 |
| 与“全页聊天禁令”的边界不清 | Iris 对话优先，但每个 run 的计划、素材与版本都落到画布上；没有画布产出的纯聊天页不算 Iris（AGENTS.md §2） |

### 6.3 各面的职责

- **Iris（主场）**：对话发起 run；对话里的计划卡显示 Step 清单与审批（预算一次确认）；run 卡片展开“运行”trace（Step、caller、版本、评审轮，点开定位到画布元素 / 帧）与“逆向拆解”面板。外部 Agent 驱动时，其写入作为带 caller 徽标的 Step 与光标出现在 Iris。
- **Canvas**：同一份可见生产状态（素材节点、各版成片分组）；抽屉显示 run 条与跳转。
- **Agent 页**：Runtime 是否在线、ffmpeg / Node / Remotion 浏览器 / WhisperX 是否就绪、TTS / 视频 Provider 路由就绪、外部 Agent（Codex / Claude Code / DSH）连接；可选只读“最近 run”跳转（跳到 Iris）。

### 6.4 历史：原抽屉方案的代码依据（已被 6.1 取代）

| 证据 | 位置 | 说明 |
| --- | --- | --- |
| 抽屉只在 Canvas / Reverse 打开 | `App.tsx`：`open={canvasView !== 'agent' && rightOpen}`，内含 `IrisAgentPanel` | 新方案中该组件在逆向里以 docked 侧栏形态复用，在 Canvas 里保留轻量模式 |
| 抽屉已有“对话 / 连接指引 / 连接状态 / 运行日志”四个分区 | `components/agent/AgentDrawerSections.tsx` | 新方案收为“计划 / 运行 / 对话 / 逆向拆解”，连接类分区移到 Agent 页 |
| 内置 Agent 内核按项目持有 | `services/browserAgentRuntime.ts` | 不变：run 与项目同生命周期 |
| Agent 页明确不含内置助手 | `components/agent/AgentWorkspace.tsx` | 不变 |
| Reverse 已有 Script → 证据 → 对齐 → 字幕 → 合成的纯函数，以及“转为画布” | `services/reverse/*`、`services/reverse/canvas.ts` | 新方案中作为 run 的工具复用 |
| 生成结果、节点工具、看帧都以画布节点为单位 | `browserAgentKernel.ts` 工具定义 | 不变：编排在画布上发生，用户随时能看到、能手改 |

## 7. Runtime：本机执行，云端只做生成

```text
用户 PC
├─ Iris Web / Tauri 窗口：Iris（个人 Agent）+ Canvas（内置 Agent 内核，LLM 走用户配置的文本路由）
├─ Local Runtime（Rust，src-tauri/src/runtime/）
│   ├─ SQLite：tasks / events / production_* / run_steps / review_rounds / usage_ledger
│   ├─ Artifact store（内容寻址）
│   ├─ 执行器：ffmpeg / ffprobe（现状：`local_media.rs` 直接按名字启动，启动失败才报错，没有事先就绪检测）、Node + Remotion（scripts/render-production.mjs）、
│   │          WhisperX 或 hypit CLI（用户自装）、Playwright（capture.ui，P1）
│   └─ 控制服务（control_server.rs）：CLI / MCP / DSH 插件经此调用
└─ 云端 Provider（用户 BYOK）：Seedance（RunningHub / 直连）、MiniMax speech、文本 LLM
```

- 浏览器只跑纯 TS 层与 ffmpeg.wasm 小工具；渲染、转写、长视频处理一律在 Runtime。线上 HTTPS 演示页连不到本机 Runtime（`AgentWorkspace.tsx` 已说明），pipeline 只在本地工作区可用，界面要明确提示。
- Provider Key 只在本机安全存储，不进入 trace、artifact 元数据、Skill 或日志。
- 本地依赖缺失时，对应工具返回结构化 `CAPABILITY_UNAVAILABLE` + 一键诊断动作，不静默跳过。
- **假设**：Remotion 渲染所需的无头浏览器可在用户机器上自动准备；WhisperX 需用户自装 Python 环境或 hypit CLI。两者都要在 Windows 实机验证。

## 8. 外部 Agent 与 DSH 如何接入同一条 trace

- pipeline 工具登记在同一注册表后，自动出现在 CLI（`tools/iris/cli.js`）、stdio MCP（`tools/iris/mcp-server.js`）与 DSH 插件（`dsh-plugin/src/tools.ts` 的 `iris_*` 映射）中，参数与权限一致。
- 推荐分工（对应参考文章）：**Codex / Claude Code** 在用户产品仓库里跑项目、注入演示数据、截图录屏、导出原生动画，然后 `asset.import` 到当前 run；**内置 Agent 或外部 Agent** 负责编排（脚本、配音、合成、评审、修补）。两者都写同一个 runId，trace 里 `caller` 区分是谁做的。
- `agent.turn`：外部 Agent 可把“评审这一版”委派给内置 Agent 跑一轮（现有：默认只读、只回摘要、同一 mutationId 幂等）。
- Skill（`skills/iris/`）新增一个 pipeline 命令文档，只写已登记、已验证的命令；`.agents/`、`.claude/` 投影随 canonical 同步，不手改。

## 9. 分阶段实施

### P0：本机最小端到端 trace（不依赖付费也能跑通）

目标：内置 Agent 在 Iris 里，从 brief + 两张授权文件夹里的真实截图出发，跑出 15–20 秒小样，并完成至少一轮“评审 → 定向修补 → 重渲染”。

1. **Trace 存储**：Runtime 新增 `run_steps`、`review_rounds` 迁移；命令边界自动记 Step；`pipeline.run.start` / `pipeline.run.get`。
2. **内置 Agent 工具集**：run 激活时追加 pipeline 工具与 `task.get` / `task.cancel`、`asset.list`；系统提示词增加评审循环规则（findings 必须带时间点、锁不可越权、轮数上限）。
3. **合成 spec V2 + Remotion**：ProductionSpec V2（视频 / 图片 / 文字 / 字幕 / 音频轨、locked、关键帧）；`ProductionVideo` 渲染文字、字幕与音频；`composition.patch`（基于版本、尊重锁）。
4. **渲染**：Runtime `media.render` 增加 engine `remotion` 调用 `scripts/render-production.mjs`，产出 durable artifact；支持 `still`（单帧静态关键帧）与 `draft`。
5. **TTS**：MiniMax speech 路由 + Fake Provider fixture；输出时长与参数快照；`speechText` / `displayText` 分离。
6. **时间戳**：`audio.transcribe`（WhisperX / hypit；测试用 fixture 证据）+ `timeline.align` 暴露。
7. **评审工具**：`media.probe`（时长、黑帧、静音）、`media.frames`（支持 artifact 与两版对比）、`review.submit`。
8. **Iris UI**：对话发起；对话栏的计划卡与 run 卡片按 run 显示 Step / 版本 / 评审轮；画布上以带标签光标执行写入；成片版本以节点分组出现在画布。
9. **预算**：run 级预算一次确认（任务数 / 金额 / 最大轮数），复用 spend mandate 与 `run_budgets`。

### P1：贴近参考文章的完整制作

~~`capture.ui`~~（已实现，见 §12.3；桌面级录制转入 [Hub 计划](../plans/recordly-capture-hub.md)）；多音轨与 ducking、音乐导入；`run.archive`；逆向拆解 → run 输入；手动四角关键帧的屏幕合成；声线 A/B 变体对比卡；从 15 秒小样扩成完整片（模板化复用已锁定的风格）；Skill 增加 pipeline 命令文档；Agent 页显示 pipeline 依赖就绪状态。

### P2：进阶

自动屏幕跟踪 + 轨迹平滑 + 手指前景遮罩；音乐生成（`audio.music`）；横竖版自动重排；多 run 批量变体；真实宿主（Resolve）把成片 / 音轨作为 Media Pool 素材导入。

## 10. 验收标准与测试计划

### 10.1 P0 验收（“trace 端到端跑通，且至少一轮 批评 → 修补”）

前置：本机 Runtime 在线；Fake Provider 提供图像 / 视频 / TTS fixture；授权文件夹内有 2 张产品截图；转写用 fixture 证据（另做一次真实 WhisperX 冒烟）。

1. 在 Iris 对话里输入 brief（可拖入参考）→ 画布出现并在对话里出现计划卡，预算确认一次，`pipeline.run.get` 返回 runId 与 brief artifact。
2. Agent 自主完成：`asset.import`（2 张截图）→ 三栏脚本（含 `speechText` / `displayText`）→ `audio.tts` → `audio.transcribe` → `timeline.align` → `composition.patch`（v1）→ `composition.render(still)` → `composition.render(draft)`。
3. Agent 调用 `media.probe` 与 `media.frames` 后提交 `review.submit(v1, verdict=revise)`，至少一条 finding 带具体时间点（例如“第 8 秒结果停留不足 0.8 秒”）。
4. Agent 调用 `composition.patch(baseVersion=v1)` 生成 v2：**只有** findings 涉及的片段变化，locked 片段的 spec 与 v1 字节一致。
5. 渲染 v2 → `media.frames(compareWith=v1)` → `review.submit(v2, verdict=pass)`。
6. trace 中 Step 顺序完整、每步有 status 与产物；v1、v2 两版渲染都是带 sha256 的 durable artifact，都可在画布分组中打开；Fake 路径费用为 0 且 `usage_ledger` 记录与 Step 一致。
7. **恢复**：在第 2 步渲染进行中刷新页面，run 从未完成 Step 继续，不重复提交已完成任务；对 `composition.render` 用同一 mutationId 重放返回同一 taskId。
8. **边界**：缺 ffmpeg / Node / Remotion 浏览器时返回 `CAPABILITY_UNAVAILABLE`，run 进入 block 并提示诊断；超出 `maxRounds` 自动停下并说明。
9. **同一操作外部可用**：用 CLI 对同一 runId 读取 `pipeline.run.get`、提交一条 `review.submit(reviewer=user)`，Iris trace 实时出现该条（caller=cli）。

### 10.2 测试分层

| 层 | 内容 | 命令 / 位置 |
| --- | --- | --- |
| 纯函数 | spec V2 修订与锁、diff、对齐映射、字幕定时 | 现有 Vitest 套件旁新增用例 |
| Runtime | 迁移、Step 记录、幂等、恢复、`remotion` 引擎调用、probe | `cargo test --manifest-path src-tauri/Cargo.toml` |
| 注册表 / 文档 | 新命令 schema、Skill 投影一致 | `npm run docs:check` |
| 浏览器 | Iris 对话首页 → 对话栏 + 画布转场、trace 分组、光标写入、画布版本分组，0 console error | Chrome for Testing + Playwright |
| 端到端 | §10.1 全流程（Fake Provider） | 新增 e2e 脚本，产物放 `.tmp/` / `artifacts/` |
| 真实 Provider | 一次 MiniMax TTS + 一次 Seedance 小样，用户批准的预算内；记录扣费、429、取消、unknown-submit | 人工 trial，证据进 Support Matrix |

### 10.3 不算完成

- 只在 mock 下通过、或渲染产物是临时 URL；
- 评审没有具体时间点、修补改动了 locked 片段；
- trace 由模型自己“写日志”而非命令边界记录；
- 只在线上 HTTPS 演示页验证。

## 11. 与现有规则的关系

- 不新增顶级 surface（复用顶栏中间的 Iris），不引入只有聊天的整页、Tasks / Artifacts 工作区、Production Crew / Director / Operator 必经层；run 是一个可选的长流程容器，单步生成照旧不需要 run。
- 不复制 Hypit 代码；转写走用户自装的 WhisperX / hypit CLI，结果作为 artifact 导回（逆向拆解的许可边界不变）。
- 单一权威：trace 在 Runtime，Workflow 图在 Browser Workflow，会话在各自 Agent；彼此只存引用。
- 对外口径：P0 完成前不宣传“一键成片”或“自动做完宣传片”；完成后也只能说“Agent 协助迭代制作”，并跟随 Support Matrix。

## 12. P0 实施状态（2026-11-14）

本节记录已落到 `main` 的 P0 切片，以及与 §4.2 / §9 的偏离。**已实现** ≠ **已验证**：支持状态只看 `SUPPORT_MATRIX.md`。

### 12.1 已实现

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 命令边界与 trace | `tools/iris/pipeline/index.js` | 每次命令自动写 Step（caller、argsDigest、mutationId、status、attempts、产物）；同 mutationId 同载荷重放原结果、不同载荷拒绝；进程中断后的 `running` / `unknown_submit` Step 由同一 mutationId 续跑，`pipeline.run.get` 返回 `resumeFrom` |
| 持久层 | `tools/iris/pipeline/store.js`、`src-tauri/src/runtime/pipeline_trace.rs` | 与 Runtime 共用 `flovart-state.db`（migration 5，`pipeline_*` 表）+ 内容寻址 artifact 目录（sha256）；Node 写，Rust `pipeline.run.get` 只读 |
| 合成 spec V2 | `tools/iris/pipeline/spec.js` | visual / text / captions / audio 四轨；`locked` 片段修改须显式 `unlock` + reason；修订绑定评审轮时只允许改 findings 涉及的片段（`PATCH_OUT_OF_SCOPE`）；`baseVersion` 过期返回 `VERSION_CONFLICT` |
| 渲染 | `tools/iris/pipeline/render.js` | 受控 ffmpeg filtergraph（镜头、文字、字幕、旁白、音乐 sidechain 闪避），preset still / draft / final；`final` 需要该版本已有 pass 评审；Remotion 引擎（`engine: remotion`）画面 / 文字 / 字幕 / 音频轨齐全，draft 按 0.5 缩放，still 仍走 ffmpeg |
| 评审工具 | `media.js`、`review.js` | `media.probe`（时长、黑帧、静音、LUFS）、`media.frames`（≤6 帧，可与上一版并排）；`review.submit` 拒绝没有时间点 / 修法的 finding，Agent 评审前必须看过该版本的帧，重复 findings 返回 `REPEATED_FINDINGS`，超过 `maxRounds` 自动 block |
| 声音 | `voice.js` | `audio.tts` 路由 fake / minimax / runninghub（runninghub = RunningHub 标准模型 API 上的 MiniMax speech 02 / 2.6 / 2.8，提交后轮询 `/openapi/v2/query`，超时报 `PROVIDER_UNKNOWN_SUBMIT` 不重提；真实 trial 用 `npm run trial:runninghub-tts`，2026-11-15 已跑通，单句约 3.3 秒、计费约 0.004 元；`speechText` 与 `displayText` 分离，输出时长与参数快照）；`audio.transcribe` 引擎 whisperx / hypit / fixture；`timeline.align` 用 LCS 对齐 + 插值 |
| 预算与门禁 | `index.js` | run 级预算（maxTasks / maxCost / maxRounds）在创建时一次确认；付费步 reserve → confirm / release 写入 run 账本 |
| 注册表 / CLI | `command-registry.v1.json`、`tools/iris/cli.js` | 13 条命令登记为 available；写命令强制 `--mutation-id`；结构化参数用 `--args-json` 或 `--file` |
| 内置 Agent | `agent/tools.js`、`agent/kernel.js`、`agent/pipeline-rules.js`、`agent/session.js` | pipeline 工具不经浏览器租约；非入口工具只能作用于本会话的活动 run；注册了 pipeline 工具时追加评审循环规则 |

### 12.2 验证

- `node scripts/e2e-pipeline-trace.mjs`（`npm run e2e:pipeline`）：brief + 2 张授权文件夹截图 → TTS → 转写 → 对齐 → v1 → still / draft → probe + frames → revise（finding：第 10.1 秒结果卡片只停留 0.5 秒）→ 定向修补 v2（只有 `shot-result-card` 变化，locked 片段与 v1 字节一致）→ draft → pass → final → CLI 以 `reviewer=user` 写入同一 runId → archive。35 项检查，含恢复（中断后续跑原 Step、mutationId 重放同一结果）、缺依赖 blocked → 恢复、轮数上限、预算超限、越权修补被拒。产物在 `.tmp/pipeline-trace/`。
- Vitest：`tests/pipelineSpec.test.js`（spec / 锁 / diff / 对齐）与 `tests/pipelineTrace.test.js`（上面的全流程）。

### 12.3 与提案的偏离和未完成项

- **存储（已对齐 §4.2，2026-11-14）**：trace 表由 migration 5 建立，Rust Runtime 与 Node pipeline 执行同一份 SQL（`tools/iris/contracts/runtime/migrations/0005_agent_pipeline.sql`）、共用 `runtime_migrations` 账本和 `flovart-state.db`。表名加 `pipeline_` 前缀，避免与 Runtime 的 `artifacts` 概念冲突；仍未复用 `production_*` / `usage_ledger`，预算走 `pipeline_usage_ledger`。写入只在 Node 命令边界，Rust 侧提供只读 `pipeline.run.get`，`npm run e2e:pipeline:parity` 校验两边输出逐字段一致。
- **Canvas（2026-11-14）**：抽屉“运行日志”顶部新增“视频流水线”分区（`components/agent/AgentPipelineRunsSection.tsx`），每个 run 一张卡片：状态、head 版本、最近一轮评审、Step 数与失败数、blocker；展开看逐步 trace（tool / caller / 状态 / 错误码 / 重试次数）、各版本的锁定片段与结论、可继续的 Step。“放到画布”把每个版本最好的一份视频渲染（final 优先于 draft，跳过 rejected 与单帧 still）放进同一个自动批次 `pipeline-<runId>`（`batchIndex = 版本号 - 1`），叠放主图指向最新版本；已在画布上的 artifact 不重复插入。数据只读取本机 agent 的 `GET /pipeline/*`。按 §6 修订，这里是 Canvas 侧的轻量入口；“在逆向中继续”与逆向 docked 侧栏尚未实现。
- **Remotion 三轨（2026-11-14）**：ProductionSpec V1 增加可选 `texts` / `captions` / `audio`（帧为单位），`components/reverse/ProductionVideo.tsx` 绘制文字层（top 10% / center / bottom 底边 78%）、底部字幕（底边 88%、半透明底框）与音频（music 在 voice 出声帧闪避到 25%，增益封顶 0 dB）；字体栈中文优先（Noto CJK / 苹方 / 雅黑）。本地 artifact 链接进 bundle 的 `publicDir`，以 `static:<文件名>` 经 `staticFile` 供给。`npm run e2e:pipeline:remotion` 用真实 run 的 v2 spec 出 540×960 draft，检查音频流、时长与缩放并截字幕帧和文字帧。
- **capture.ui 与 MCP（2026-11-14）**：`capture.ui`（`tools/iris/pipeline/capture.js`）只开 localhost / 回环地址或授权文件夹内的 `file://`，每个 `goto` 步骤同样校验；2026-11-22 起页面内部也受同一边界约束：浏览器上下文里每个请求（子资源、跳转、重定向、弹窗、WebSocket）按同一规则放行，越界子资源直接拦截，越界导航或绕过拦截拿到的越界响应让整次采集以 `PATH_NOT_AUTHORIZED` 失败；`file://` 先解析符号链接再判断是否在授权文件夹内；禁用 Service Worker、下载与权限；除 localhost 外的主机名解析一律失败。Chromium 沙箱默认开启，只有显式设置 `IRIS_CAPTURE_NO_SANDBOX=1` 才关闭；启动浏览器前要用户确认（2026-11-22 起：CLI 直接带 `--confirmed`，内置 Agent 与 MCP 自填的 `confirmed` 不生效，改为返回 `CONFIRMATION_REQUIRED` 和 `approvalId`，由用户在 Agent 页「视频流水线」里批准后同参数重试，见 `tools/iris/pipeline/approvals.js`）。浏览器依次取 `IRIS_CAPTURE_BROWSER`、Playwright 自带 Chromium、Remotion 已下载的 headless shell。截图为 PNG；录屏用 CDP screencast 收带时间戳的帧，本机 ffmpeg 按真实间隔拼成 30fps H.264 MP4（不依赖 Playwright 自带 ffmpeg）。`npm run e2e:pipeline:capture` 14 项检查。stdio MCP（`tools/iris/mcp-server.js`）把 14 条 pipeline 命令投影为 `iris_<命令>` 工具，参数 schema 来自注册表，`agentIdentity` 记为 Step 的 caller；Skill 增加 `commands/pipeline.md`。
- **CJK 字体（2026-11-14）**：`resolveFontInfo` 依次取 `IRIS_FONT_FILE` → 已知中文字体路径（雅黑 / 苹方 / 冬青 / Noto CJK / 思源 / 文泉驿）→ `fc-list :lang=zh` 选无衬线常规体 → 拉丁兜底；要画的文字含中日韩字符却只剩拉丁兜底时报 `CAPABILITY_UNAVAILABLE`（capability `font`，附安装提示），不再渲染方框。Remotion 引擎把同一字体文件放进 publicDir 以 `FontFace` 嵌入（`delayRender` 等就绪，加载失败中止），两条引擎用同一字体、不依赖渲染机的浏览器字体。
- **付费未知提交与用户审批（2026-11-22）**：付费 Step 处在 `running` / `unknown_submit` 时每次重试都要 `confirmResubmit`（CLI `--confirm-resubmit`）；provider 报 `PROVIDER_UNKNOWN_SUBMIT` 时 Step 记为 `unknown_submit` 并保留预算预留。`pipeline.run.start` 的 `budgetConfirmed`、`capture.ui` / `run.archive` 的 `confirmed` 只接受 CLI 或界面批准：审批一次性、10 分钟过期，绑定命令 + runId + 参数摘要；`POST /pipeline/approvals/:id/grant` 只接受已授权的 Iris Origin。
- **未做**：DSH 插件的 pipeline 投影。
- **未实测**：直连 MiniMax TTS（RunningHub 路由已实测）与真实 WhisperX / hypit（只按文档形状实现）；真实 Windows / macOS 渲染机上的字体选择只按路径表实现，未在真机验证。
- `cargo test --lib` 已在 Linux 沙箱运行（含 pipeline_trace 单测与 Node/Rust 一致性测试）。`rust-ini` 锁定到 0.21.1：0.21.3 给 `ParseOption` 加了字段，`tauri-plugin-deep-link` 2.6.2 会编译失败。
