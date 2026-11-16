# Changelog

## Unreleased
- Agent 上下文压缩（omp 风格 `/compact`）：输入框打「/」时斜杠菜单里新增 `/compact [聚焦说明]`（排在 Skill 前面，键盘可选；只对内置 Agent 显示），例如 `/compact 保留接口设计的讨论`，聚焦说明拼进摘要要求；手动压缩保留最近 2 轮原文，其余整理成摘要；面板里压缩记录改为「已压缩」卡片，显示压缩前后大概 token 数（约 96K → 14K）、聚焦说明与触发原因，压缩进行中先显示「正在压缩」。自动压缩阈值改为按模型上下文窗口计算（约 80%，且不超过窗口减预留）：窗口读模型对象上可选的 `contextWindow`，没有时按 128K。工具调用循环里新增回合中途压缩：工具结果写回后、下一次调用模型前估算超阈值就先压缩再继续（保留当前这一步原文，压不动时本轮不再重试）。服务商报「maximum context length is N tokens」一类错误时学习真实窗口与输出上限（按 baseUrl + 模型记在本机 30 天），下调 `max_tokens`（原来写死 16384）后重试一次，之后的阈值与 `max_tokens` 都按学到的值算；输入本身超窗时不做无用重试，交给溢出压缩重试。新增 `services/agentContextLimits.ts`、`components/agent/AgentCompactionCard.tsx`、`components/agent/agentSlashCommands.ts`；测试 `tests/agentCompactCommand.test.ts`、`tests/agentCompactCommandUi.test.tsx`。未接真实模型验证。
- 界面：右侧 Agent 对话面板改为磨砂玻璃（半透明底 + 面板内柔和环境光：顶部薄荷、右侧淡紫、底部蜜桃 + 模糊 + 白色内高光），输入框、提示卡、生成计划卡改为磨砂卡；应用其余部分不变；系统开启“减弱透明度”/高对比或浏览器不支持 backdrop-filter 时回退实底（`styles/ambientGlass.css`）。

- 生成计划卡随会话保存：用户做出选择的计划卡按「项目 + 会话」存本机（只存命令、节点 id、门禁明细、选择、时间与轮次，进度回来后按画布实时节点重新推导），切换会话、刷新页面后挂回原来那一轮；删除会话时一起清掉。
- 托管 Agent 的计划卡选择：「创建后手动生成 / 调整后再创建」不再是笼统的 `DENIED`，bridge 回 `DEFERRED_BY_USER` 并带给 Agent 的说明（节点已保留、不要重试或重复创建）；其余确认的拒绝不变。
- 点选主体 wasm 体积：没有 WebGPU 时 ONNX Runtime 改用普通版 `ort-wasm-simd-threaded.wasm`（约 14.3 MB），不再一律下载 transformers.js 默认的 asyncify 版（约 26.9 MB）；普通版低于 Cloudflare Pages 单文件 25 MiB 上限，可用 `VITE_SEGMENTATION_WASM_BASE_URL` 自托管。默认 CDN 钉到打包进来的 onnxruntime-web 版本；有 WebGPU 时仍用 asyncify 版。
- Agent 对话面板四项交互（参考 RunningHub）：① 生成计划卡——`workflow.node.run` 的批量生成确认改成计划卡（本批提交模型、标题 + 状态「待生成 → 生成中 n/N → 已完成」、可展开的资产列表即原计划明细、目标编组、画布工作流节点 chips、「创建并自动生成 / 创建后手动生成 / 调整后再创建」三个选择与一行说明），仍走同一个确认请求：只有「创建并自动生成」批准，另两个以带说明的拒绝回给 Agent（节点保留、不要重复创建），「调整后再创建」把焦点交回输入框；付费授权（上限内自动运行）改为卡内勾选；推导不出的模型 / 编组行不显示；卡片挂在发起它的那一轮末尾，切换会话后不保留。② 对话轮次时间轴——消息区左缘每轮一道刻度，当前可视轮高亮，悬停预览提问与回答开头，点击平滑滚回。③ 回到最新消息——离底超过 1/3 屏时输入框上方出现圆形向下按钮；在底部自动跟随，上翻后流式输出不再把视图拉回底部。④ 引用回复——助手消息操作栏新增引用按钮，输入框上方显示引用条（可取消），发送时引文以 `> ` 引用块（最多 2000 字）拼在用户消息前进入模型上下文，用户气泡里以引用块显示。纯逻辑在 `agentRunPlan` / `agentConversationNav` / `agentQuote`，均有 vitest；未在真实浏览器中验证。
- Agent 渐进式技能加载：系统提示词只带技能索引，新增只读工具 `flovart_skill_read`（分页、越界拦截、会话内去重，已读列表跨压缩保留）；手动绑定的技能改为「强制使用」，首轮完整注入 SKILL.md（移除 2000 字截断）。本机 Agent 服务新增 `GET /api/skills/:id/file`（只读 SKILL.md、references/、commands/，拦截越界与符号链接逃逸）。
- Agent 自动压缩上下文：发送前超阈值先压缩，上下文溢出时压缩后重试一次（拒答、限流不重试，溢出不再被翻译成「参数不被接受」）；会话菜单新增「压缩上下文」。
- Agent 项目记忆工具 `flovart_memory`：按项目本机保存，最多 100 条、淘汰最旧，写入前脱敏；摘要注入系统提示词，会话菜单可查看与删除。
- 区域引用「点选主体」M1：新增主体蒙版纯函数（点位归一化、SAM 提示坐标换算、候选选择、外接框外扩、框内 alpha 蒙版与 PNG 编码）与懒加载的 SlimSAM 分割 Worker 原型（`@huggingface/transformers` + `Xenova/slimsam-77-uniform`，WebGPU 优先、WASM 兜底，模型来源可用 `VITE_SEGMENTATION_MODEL_BASE_URL` 指向镜像）；`region.pick` 可选字段进入校验但不参与身份键。暂无 UI，未经真实浏览器验证。
- Agent `media_view` 附带实测尺寸：图片写「原始 W×H，比例≈16:9」，视频帧网格说明里加原始分辨率，Agent 反推 / 复刻时不用看图猜比例。
- 分组框跟随成员自动伸缩：成员移动、改尺寸、加入 / 移出、删除后，所在分组框（含嵌套分组，由内向外）贴合成员包围盒；拖动时实时跟随，松手与成员改动记在同一个 ChangeSet 里，一步撤销。折叠的分组不动；只手动拉大框本身不会被拉回。
- 风格锚点编号前缀统一为 T（`nodeSearch` 原来用 F，与锚点批准、类型注释不一致）；旧写法 F01 仍按 T01 解析。
- 多结果备选：Agent `media_view` / `workflow.inspect` 能按备选 id 取到画面与来源（不再报“节点不存在”），只接受画布节点的命令遇到备选 id 时说明它属于哪个首图节点；本地副本缺失时先从 Runtime 产物或原始链接取回。
- Agent `flovart_grep`（对齐 OMP grep 语义）：path 不存在报 `Path not found`，不再回落成“没有匹配”；没有连接文件夹、权限失效、文件夹已被移动 / 删除分别直接报错；省略 path、`.`、`./` 都表示根目录；path 支持单个文件、`;` 分隔多个范围与文件夹名前缀；遍历中途目录消失不再中断整次搜索。
- CLI: `video.status` → `task.get`, `export.project` → `workflow.inspect`; `generate.images-batch` submits one Runtime `generate.image` per item with derived idempotency keys (no more file-state shadow).
- Pipeline: image clips take `motion` (push / pull / pan / tilt / shake / impact, flash), rendered by Remotion; `beatGridCuts` helper.
- New bundled Skill `still-mad` (静止系 MAD): beat-cut still images through the pipeline.

- Agent 工具面补齐：`workflow.node.tool`（裁剪 / 放大 / 去背景 / 剪辑 / 抽帧 / 反推提示词等）进入外部 Agent 公开面，MCP 工具 `flovart_workflow_node_tool`，付费工具仍在浏览器侧确认；Skill 命令（list / manifest / hub.list / validate / init / draft / install / uninstall）与新命令 `receipts.list` 写入 Runtime 注册表并投影为 MCP 工具 `flovart_skill_*` / `flovart_receipts_list`。
- 画布转 Skill：`skill.draft --from-project <projectId>` 直接读取可见 Workspace 里的任意工程（含历史画布）与共享回执生成草稿，不再需要手工拼快照；Skill 增加 `commands/skill.md`。
- 修复 release red-team 公开面白名单与实际公开命令不一致。
- Agent 视频流水线 P0（实验性）：13 条 pipeline 命令（run / 素材 / TTS / 转写 / 对齐 / 合成修订 / 渲染 / 探测 / 抽帧 / 评审 / 归档），命令边界自动记 trace，评审 → 定向修补（locked 片段不变）→ 重渲染可端到端跑通（`npm run e2e:pipeline`）。
- 流水线 trace 迁入桌面 Runtime 共用的 `flovart-state.db`（migration 5，表名 `pipeline_*`）；Rust Runtime 新增只读 `pipeline.run.get`，与 Node 输出逐字段一致（`npm run e2e:pipeline:parity`）；agent 新增只读 `GET /pipeline/runs`、`/pipeline/runs/:id`、`/pipeline/artifacts/:id`。
- 流水线配音新增 RunningHub 路由（MiniMax speech，通过 RunningHub Key 调用），附真实 trial 脚本。
- 流水线中文字体：自动找系统中文字体（含 fontconfig），找不到时明确报错而不是渲染方框；Remotion 引擎嵌入同一字体文件。
- 流水线新增 `capture.ui`：本机无头浏览器打开 localhost 页面按步骤截图或录屏，产物直接进 run；pipeline 命令同时投影为 MCP 工具（`flovart_capture_ui` 等），Skill 增加流水线命令文档。
- 流水线 Remotion 引擎支持文字层、底部字幕与音频轨（音乐随人声闪避），中文字体优先；`npm run e2e:pipeline:remotion` 端到端验证。
- Canvas 抽屉“运行日志”新增视频流水线 run 卡片（状态、版本、评审结论、逐步 trace）；“放到画布”把各版本渲染收进同一组叠放，最新版本在最上面。
- 修复 Linux 构建：`rust-ini` 锁定 0.21.1（0.21.3 与 `tauri-plugin-deep-link` 2.6.2 不兼容）。
- 本地文件夹重新授权后自动重读画布节点，并通过 BroadcastChannel 同步其他标签页；权限失效节点提供“重新连接文件夹”。

## 0.3.0 — Closed beta / 内测版 (2026-11-06)

- Canvas 多标签页：用 navigator.locks 选出唯一写入标签页，其余标签页只读；只读页不落盘、不清理媒体、不接管中断节点，避免互相覆盖或误删刚生成的媒体。
- Canvas 持久化：保存失败时常驻提示，可重试或导出项目；配额不足单独提示。
- Agent：未完成的工具调用自动补“已取消”结果，停止或中断后可继续对话；停止时关闭待确认卡；workflow.apply 含删除节点时与单独删除一样需要确认。
- API Key 加密存储 v2：密钥派生不再依赖 userAgent，浏览器升级后仍可解密；解密失败时保留原密文，不再被空列表覆盖。
- 删除 Agent 离线浏览模式与武侠风示例模板。
- 逆向工作台暂时显示「正在优化，后续上线」，代码与已保存数据保留；登录 / 注册显示「内测版本，账号功能后续更新」。
- 版本号统一为 0.3.0（package.json / tauri.conf.json / Cargo.toml）。

## 0.2.0 — Closed beta / 内测版 (2026-10-19)

- Canvas: align, distribute, duplicate (Ctrl/Cmd+D), arrow-key nudge with one undo entry per held key, pane context menu, Alt+Shift+F auto layout, F to focus the selection.
- Fix Delete inside dialogs and menus removing canvas nodes; flush pending project writes on pagehide.
- Coalesce wheel pan/zoom into one viewport write per animation frame.
- Add a local, redacted, offline crash log and AppErrorBoundary with diagnostics export.
- Gate GitHub Pages deploys on npm ci, docs:check, tsc and tests; unify the version to 0.2.0 across all release sources.

## 0.1.0-beta.2 — Closed beta / 内测版 (2026-10-15)

- Restore the Flovart product name across Canvas, Table, Agent, desktop, host panels and current documentation; preserve persisted IDs and protocol compatibility.
- Consolidate the shell, documentation, Workflow run-state/version/handoff, Resolve Inspector and non-blocking Canvas simplification PRs into main.
- Add the 60-second concept film and bilingual, outcome-first README; distinguish the vision from verified capabilities.
- Automatically build Windows x64 EXE and macOS Apple Silicon / Intel DMGs on main; tagged builds are published only after release and security checks.
- This is a prerelease. Creative hosts remain Experimental and paid-provider certification remains pending. macOS uses ad-hoc signing, without Apple notarization; Windows Authenticode is not configured. This version resets the public beta numbering and is not an automatic downgrade from 0.3.x previews.

## Unreleased

- DSH 桌面端连接：bootstrap 接受 `dsh-app://` 协议代理（转发时会去掉 Origin/Sec-Fetch-Site），Workspace Operator 允许 `dsh-app://app` 交换 session；新增 `npm run dsh:desktop` 启动器，先复用/拉起 Workspace Operator 再打开 DSH Desktop（`--ensure-only` 只拉起 Operator）。
- 账号入口弹窗跟随应用深浅色主题（含 DSH 内嵌主题），文案改为账号生态探索中、多端同步后续更新，并加入 GitHub 点赞入口。
- Agent 确认卡重做：一句人话说明动作与对象（节点 ID 换成节点标题，不再显示 `workflow.node.delete：…` 这类内部文本），费用明细收进「详情」；「允许」为唯一主按钮，授权范围用一个下拉选择「仅这次 / 本次对话 / 始终允许此类操作」。删除只能逐次确认，付费生成与付费工具最多到「本次对话」（生成仍受任务上限约束），「始终允许」只覆盖可逆操作，存本机并可在模式菜单撤销；Esc 拒绝；颜色变量带兜底，挂到任何容器都不会透明。
- 内置 Agent 新增 `flovart_workflow_node_tool`：与节点工具条同一实现，可直接截取视频任意秒数的帧（position=current + currentTimeSec）、剪辑、音视频分离、拼接、裁剪、放大、去背景等；工具清单从 Operation 注册表生成，后续新增工具自动对 Agent 可用。`workflow.node.tool` 结果新增 `outputNodeIds`；补齐 Agent 路径上的 `audio-stem-split` 与音视频分离的 `audio` 参数。
- Agent 对话：用户气泡不再显示发给模型的引用上下文（nodeId、附带画面说明），工具卡标题改为「读取画布」「查看画面」等人话。
- Canvas 空状态：按钮不再换行溢出，「图片节点」为唯一主按钮，示例画布改为一行文字链接；去掉虚线框与彩色按钮；点阵淡化、间距 24px。
- 逆向生产渲染：ProductionSpec V1 从 Reverse 项目派生镜头帧窗口与资产，Remotion Player 与 Node 渲染共用同一合成；`node scripts/render-production.mjs --spec spec.json --out out.mp4` 已冒烟输出 320×180 / 20 帧 / 2s H.264。
- Agent 沙箱确认卡：画布外抽屉补齐 workflow 颜色变量作用域（此前背景透明、确认内容与消息和输入框互相透叠）；计划卡恢复网格布局，操作按钮可换行，长内容在卡片内滚动；确认卡改为输入框上方的独立占位，不再覆盖输入区。
- Reverse 替换 Table：顶栏改为 Canvas | 逆向 | Agent；services/reverse/ 按 Hypit 架构分层自行实现（temporal / evidence / narrative / align / projection / caption / composition），不引入 Hypit 代码；旧数据里的 'table' 视图自动迁移为 'reverse'（workspace store v3）。
- Canvas 子画布：新增 subgraph 节点与可选 parentId（Workflow 持久化 v2）；逆向一键「转为画布 / 同步到画布」，一次 workflow.apply，同步保留画布上调整过的位置、尺寸与已选版本；支持折叠、整体拖动（含多选）、整体删除，双击回到对应逆向工程。
- 逆向台词与镜头时长：台词保留原文标点与连字符；无 cue 时镜头边界吸附到句末，镜头时长随句子调整。
- 逆向撤下游戏素材方向：Reverse 只保留视频逆向（Hypit 流程）；删除游戏台账 / 风格圣经 / 相似度门面板与服务，旧 game 工程在 reverse store v3 迁移时丢弃。
- 逆向面板改为渐进式披露：参考 → 拆解 → 目标稿 → 替换与变体 → 画布 5 步；镜头表生成前后 3 步只显示标题和解锁条件，新解锁的步骤自动展开；重新进入工程时，当前步之前已完成的步骤折叠为一行摘要，点标题可展开 / 收起。
- README 精简：中英文 README 只保留 60 秒宣传片，删除旧截图、GIF 与录屏素材。
- Canvas 图层 / 导出 / 快照（参考 ComfyArt）：图层面板支持重命名、显隐、锁定、排序；工具箱可将选区或整张画布导出为 PNG / PDF（零依赖 PDF 封装，超大画布自动降倍率）；历史菜单支持命名快照保存、恢复（走普通 mutation，可撤销）、删除，每项目最多 30 个，快照引用的媒体不会被清理；菜单、选中态增加轻量过渡动画并尊重 prefers-reduced-motion。
- **Docs canonicalization**：把 current product truth 收敛为 7 份核心文档；旧 Agent/Crew/Production Skill/ecosystem/responsive 多代设计蒸馏为单一 historical snapshot，避免 coding agent 从旧稿反向推导产品。
- **Three-surface IA**：Canvas | Table | Agent 为当前顶栏；Agent 只做本地/外部 Coding Agent connection hub；Canvas/Table 右侧保留 Assistant / Context / History。
- **Container-driven Studio layout (#15)**：Studio shell、Workflow、Assistant drawer 与 Table 按容器重排，移除旧 drawer inset math 与 viewport-specific patches。
- **Agent connection hub (#13)**：恢复顶级 Agent surface，同时避免在 Agent 页复制内置 Assistant。
- **README product truth**：中英文 README 与当前 IA、Agent Integration Skill、Support Matrix 口径统一。
- **Browser video/audio tools**：ffmpeg core 使用正确 ESM / core-mt worker 路径并规避 Vite worker 预打包问题。
- **Agent Link bootstrap**：Host discovery 区分 fast/deep probe 并加入短 TTL，避免冷启动探针超时。
- **Real Codex gate**：真实 `codex exec` Golden Task 已有连续通过证据；公开安装包首次启动、真实 Provider 与登录恢复仍是外部门禁。
- **FlovartBench v0.1**：系统级 Agent/Workflow/Runtime eval harness 已建立；外部 Agent 与真实 Provider 结果仍按实测状态分别认证。
- **Release hardening**：Hosted CI、dependency/security、package/signing 与真实 Creative Host/Provider 继续按 Support Matrix / pending-test 作为发布门禁。

历史施工流水由 Git history 与 `docs/archive/historical-design/` 保存，不再继续堆入 Unreleased。
