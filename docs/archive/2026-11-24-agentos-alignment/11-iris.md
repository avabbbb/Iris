# 模块：Iris（全能后期助手 · Personal agent）

> 状态：**Current truth**（2026-11-05 由 Table 改为 Reverse；2026-11-13 定位改为“全能助手”；2026-11-17 改名 **Iris**，定位为独立的 Web 个人 Agent、宿主连接器可选。§0 是定位与设计目标，§1–§7 的逆向拆解工具逐项标注已实现 / 设计目标）。总纲见[总体设计](00-overview.md)，交互规则见[交互设计](01-interaction.md)，宿主连接器见 [14 Creative Hosts](14-creative-hosts.md) §7。

## 0. 定位（2026-11-17 定案）

顶栏第二个 tab 是 **Iris**（原名 逆向 / Reverse）：全能后期助手，即用户的 **Personal agent**。产品名仍是 Iris；Iris 只是 surface 名，不指代 Iris 本身（旧代号见 [00](00-overview.md) §10）。

- **Web 版独立可用（设计目标）**：Hark 式、对话优先的个人 Agent，Iris 无限画布是它的产出面。用户用一句话说目标；Agent 把计划、素材、版本落到画布上（每次 `workflow.*` 调用以带标签的 Agent 光标可见地执行），用户在画布上直接改、选、对比。trace、计划 / 待办与审批跟在对话里。不装任何剪辑软件也完整可用，素材可拖入或上传。
- **可选的宿主上下文连接器（设计目标）**：用户连上本地插件 / 宿主后，Iris 同步剪辑工程上下文（时间线、选择、素材、标记），免手动上传。顺序：DaVinci Resolve 先，Premiere、剪映 / CapCut 后续；只读起步，写回走 14 号文档的安全输出（Resolve 先 Add to Media Pool）。没有连接器时 Iris 不阻塞、不降级成“请先连接”。剪映 6.0+ 草稿加密，外部可能无法读取（**待验证**），见 [14](14-creative-hosts.md) §7。
- **核心主张**（自 2026-11-15 远景草案吸收，草案已归档）：Agent 读的是完整工程上下文（图层、合成、关键帧、标记、素材），而不只是一张截图或一段提示词；输出是可编辑的工程改动或画布节点，不是烤死的成片；每一步可撤销、可比较、可回溯，最终选择留在创作者手里。
- **与 Canvas / Agent 的分工**：Canvas + Agent 是 Iris 的 Workflow 生产工具。Iris 调用 Canvas 与 Generation 的同一命令，使用 Agent 页供应的 Agent 与模型；Canvas Assistant 抽屉的多步任务“在 Iris 中继续”，进入同一个 run（同一 runId）。不复制第二套 Workflow、任务或素材模型。
- **现状（已实现，2026-11-18 v1）**：tab 是 **Iris 故事版**（`components/reverse/IrisStoryboardPage.tsx`，`data-testid="iris-storyboard"`）：左「项目素材」按 文本（剧本 / 其他）、图片（角色 / 场景 / 物品 / 其他）、视频（视频片段 / 成片）分类，右侧是同一个 `IrisAgentPanel`（Iris 页里抽屉不挂对话）。素材与画布是**同一份数据**：分类从当前 Workflow 项目的节点派生（`irisStoryboard.ts`），手改的分类写在节点 `metadata.storyboardTag`；在 Iris 里新建剧本 / 上传图片视频 = 在画布上建真节点并按类成行自动排（反推画布），编辑文本 = 改同一个文本节点；双击或「定位」跳到画布并聚焦该节点。写入走 `commitWorkflowProjectPatch`（可撤销）。版式参照用户截图，视觉与动效参照 Hark（见 [references.md](references.md)）。`components/reverse/ReverseWorkbench.tsx` 仍在仓库里但没有被任何地方挂载；Canvas 上的逆向子画布（`subgraph`）、双击回到 Iris 的入口与 `services/reverse/` 纯函数层已实现。内部标识（`canvasView: 'reverse'`、`components/reverse/`、`services/reverse/`、`useReverseStore`）在单独迁移前保持不变。
- 完整交互见 [01 交互设计](01-interaction.md) §11–§12，视觉见 [DESIGN.md](DESIGN.md)，run / trace 数据模型见 [16（PROPOSAL）](16-agent-video-pipeline.md)。

下面 §1–§7 描述的 Hypit 式逆向拆解**保留为 Iris 的一组工具（“逆向拆解”）和一个面板**，不是独立工作台：
- 工具：转写 → 对齐 → Timeline → 字幕 / 视觉 / 音频轨，各自作为 run 的 Step 出现在 trace；“转为 / 同步到画布”是其中一个写入工具（仍是一次 `workflow.apply`）。
- 面板：“逆向拆解”面板显示 Script、转写证据、对齐与 Timeline；点击片段高亮画布上对应元素。迁移期间未挂载的工作台可作为面板内容复用，不新增第二套数据模型。

## 1. 逆向拆解职责

逆向拆解是**按 Hypit 代码架构与功能复刻**的视频逆向能力（原 Table 的位置）：把一条参考（爆款）视频拆成 Script → 转写证据 → 对齐 → Timeline → 字幕 / 视觉 / 音频轨，再用用户自己的数字人角色与素材批量生成变体。

在 Hypit 之上的二次开发：**一个逆向工程可一键转成 Canvas 上的子画布节点**。子画布里是镜头、台词、参考帧与生成节点；双击子画布回到 Iris。Iris 与 Canvas 通过同一 `workflow.apply` mutation 边界联动，不形成第二份 Workflow 权威。

## 2. 复刻边界（许可）

- 参照：`_ref/hypit`（gitignored 本地克隆，只读）。对齐其包分层、数据模型、术语与端到端数据流。
- 代码全部在 `services/reverse/` 自写。**不复制 Hypit 源文件、不把 `@hypit/*` 打进 bundle**：Hypit 为附加条件的 Apache-2.0（衍生品须同许可、不得商业再分发或多租户托管），与本仓库 MIT 冲突。
- WhisperX、ffmpeg、HTML 光栅化等本地能力：走 Iris 本地 Runtime，或调用用户自装的 hypit CLI（`hypit transcribe` → `hypit.transcript@1`），结果作为 durable artifact 导回。浏览器内只跑纯 TS 层。

## 3. 模块映射（Hypit 包 → Iris 实现）

| 层 | Hypit 包 | Iris 文件 | 核心类型 / 函数 |
| --- | --- | --- | --- |
| L1 时间 | timeline, temporal | `services/reverse/temporal.ts` | `Timeline{id,frameRate,frameCount}`、`TemporalInstant`、`TemporalWindow`（半开）、`LocalTemporalDomain` |
| L1 叙事 | narrative, script | `services/reverse/narrative.ts`（已实现，扩展） | `parseReverseScript`：Segment、Role Cue、Selection `@{n}…@{/n}`、Moment `@{n!}`；Token 带 surface |
| L2 证据 | speech-evidence | `services/reverse/evidence.ts`（由 transcript.ts 演进） | `AlignedTranscriptEvidence{domainId,words}`；导入 WhisperX JSON / `hypit.transcript@1` |
| L3 对齐 | narrative-speech-alignment | `services/reverse/align.ts`（已实现） | 单调 M:N DP → `NarrativeAlignment` |
| L2 投影 | narrative-temporal | `services/reverse/projection.ts` | Alignment + Domain + Window → 绝对 Instant / Window |
| L2/L3 字幕 | caption, narrative-caption | `services/reverse/caption.ts` | `CaptionDocument`（无时间）+ `CaptionTiming`（按 Token 身份绑定） |
| L2 合成 | composition | `services/reverse/composition.ts` | `VisualTrack` / `AudioTrack`，`Present{span,order,z,elements}` |
| L5 运行 | run, result | `services/reverse/run.ts` | 变体矩阵 → 候选 / 复用 → 输出引用（durable artifact） |
| 二开 | —（Hypit 无节点图） | `services/reverse/canvas.ts` | `reverseToSubgraph` / `syncSubgraph`：逆向工程 ↔ Workflow 子画布 |

纯函数层不依赖 React / store；UI 只消费这些函数的结果。

## 4. 拆解面板（对齐 Hypit Studio；在 Iris 中作为面板呈现）

- 左：库（Source 参考视频与脚本 / Tasks 生成任务 / Artifacts 产物网格）。
- 中：参考视频预览 + 帧对齐播放头。
- 下：时间线 lane：每个 Projection 一条（Segment 行 + 词证据行）、公共 Instants 行、字幕 / 视觉 / 音频轨。
- 右：Inspector，编辑字段回写 Script / 工程状态并重新对齐。
- 顶部主 CTA：**转为画布**（已转过则为**同步到画布** / **在画布中打开**）。在 Iris 中，上述布局收进“逆向拆解”面板（库与 Inspector 折叠为抽屉），预览复用画布上的预览播放器（01 §12.6）。

## 5. 与 Canvas 联动

- Workflow 新增内置节点类型 `subgraph`：metadata 记 `reverseProjectId`、`collapsed`；子节点用可选字段 `parentId` 指向它。文档仍是扁平 nodes + connections。
- 一键转换：一次 `workflow.apply`（带 `projectId` / `expectedRevision` / `mutationId`）打包 subgraph 节点 + 子节点（script、镜头 text / image / video）+ 连线。
- 同步：子节点以稳定 key（镜头 / 槽位）对应逆向工程；重新同步只增改变化项，不覆盖用户在画布上已选的新版本。
- 双击 subgraph → 切到 Iris 并打开对应工程；Iris 内「在画布中打开」→ 切回 Canvas 并定位。
- 持久化：Workflow 持久化升版本并给旧节点补默认值；workspace 视图枚举 `table` 迁移为 `reverse`。
- 产物复用只认「已完成且可定位」（`status: completed` 且带 `path`/`artifactId`，并与 `workflowProjectId` 一致）；「转为画布」只登记 `planned` 计划，不写完成语义，也不进入复用缓存。v3 → v4 迁移把历史占位降级为 `planned`。

## 6. 游戏素材替换（暂缓）

游戏方向已于 2026-11-05 从 Reverse（现 Iris）撤下：原作素材情况复杂，待单独设计后再接入，届时不混入视频逆向的数据模型。旧持久化的 game 工程在 reverse store v3 迁移时丢弃。

## 7. 验证

逆向纯函数单测（解析、对齐、投影、字幕定时、转画布映射）；`tsc --noEmit`；Playwright：导入参考 → 对齐 → 转为画布 → 双击回到 Iris，0 console error。
