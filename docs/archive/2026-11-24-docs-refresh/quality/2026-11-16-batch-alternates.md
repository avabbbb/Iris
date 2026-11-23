# 2026-11-16 多结果（批次）改为“首图节点 + 备选”，修复拖走批次后原位残留

范围：画布上一次生成多张图片 / 多条视频（含图片、视频混合）后的展示、选择、拖动与旧项目迁移；`MediaPreviewModal` 画廊模式；Agent 的 `set_batch_primary` / `workflow.batch.pick` 与流水线版本分组。

复现方式：沙箱内 Vite dev server（`#/app`），Playwright（Chromium headless shell，zh-CN）在页面里 `import('/services/workflowGeneration.ts')` 跑真实 `runWorkflowGeneration`（`count: 4`，注入 fake `executeMedia` / `ingestMedia`，图片 `flovart:gpt-image-2`、视频 `flovart:veo-3.1-fast`），再用鼠标拖动批次。截图不入库。

## 一、拖走 4 张批次，原位留下一张点不中的

| 现象 | 根因 | 修复 | 测试 |
| --- | --- | --- | --- |
| 生成 4 张后拖动叠放批次：数据里 4 个节点都移动了，但原位置还留着一个 `[data-workflow-node-id=root]` 元素（opacity 0、`pointer-events:auto`、`scale` 一直在 0.90–1.01 之间呼吸），点不中也拖不动，还挡住它下面的点击。图片、视频批次都能复现 | 源节点在同一次提交里从 `loading` 变成 `success` 并被批次隐藏（从 `renderNodes` 移除）。`AnimatePresence` 用它最后一次的 props 播放 `exit`，`exit` 没有自己的 `transition`，于是沿用组件 `transition.scale`——加载态的 `{ duration: 1.8, repeat: Infinity }`。无限循环的退出永远不结束，元素不会被卸载 | `WorkflowNode` 的 `exit` 改为 `WORKFLOW_NODE_EXIT`（自带 140ms 有限过渡，DESIGN §14.2 退出档）。另外新模型下多结果不再隐藏源节点，这条路径本身也不再出现 | `workflowNodeExit.test.tsx`（把旧写法放回去会失败；rebase 到 a6ecc5b 后主线已去掉整节点呼吸，测试改为断言缩放过渡无 repeat、退出自带有限过渡）；浏览器复现：只打这一处修复时，同样的 4 张图片 / 4 条视频生成后原位残留元素数 1 → 0 |
| 已保存项目里残留的叠放兄弟节点（尤其是后来连了线的）在画布上被批次隐藏 / 叠在首图下面，选不中 | 叠放批次是 N 个同位节点 + 指针 `primaryImageId`，可见封面与带连线的节点可能不是同一个 | 加载 / 导入时 `foldResultBatches` 迁移（见下）；有连线的成员变成普通节点并挪到首图右侧的空位（避开其它节点和首图下方的备选区，被占时顺延到下一行 / 下一列），能点、能拖 | `batchAlternates.test.ts` › turns a member with edges into a normal, reachable node、places a detached member in free space；浏览器：导入带 4 张叠放批次的旧项目后，连了线的成员可单独选中并拖动 |

## 二、数据模型：首图节点 + 备选

- 首图就是原来的节点（原位替换的那个）：普通节点，PromptBar、图片 / 视频工具条、连线、prompt / 模型 / Take 记录都在它身上；单击就是选中它本身，不再选中整组。
- 其余结果存在 `metadata.alternates: WorkflowMediaAlternate[]`（`id`、`type: image | video`、`batchId`、`batchIndex`、尺寸、媒体与来源字段），不是画布节点；`metadata.mediaVariantId` 记录节点当前那份媒体的稳定 ID（换下去时作为备选 ID）。
- “设为首图” = `set_batch_primary`（`nodeId` 指向备选 ID）→ `promoteAlternate`：只交换媒体字段（含图片 / 视频类型），保持节点宽度与中心、按新比例换高；节点 ID、连线、prompt、配方、Take 不动；旧首图换进同一槽位，再点一次即还原。一条操作，撤销一步。Agent 与 UI 走同一条操作。
- 生成：`count > 1` 时第一份原位写入，其余作为备选放到最前（新一批在前，旧备选保留，所以先图片后视频的节点会自然变成混合备选）。Take 的 `outputNodeIds` 仍记录这些结果的稳定 ID。运行中用户换了媒体时（`detachedResult`），所有结果照旧另存为连线的独立节点，不带批次字段。
- 流水线版本：同一 run 的版本收在一个节点上，最新版本是节点本身，旧版本是备选（`batchId = pipeline-<runId>`）；重复插入按 artifactId 去重（包括备选）。
- 旧数据迁移（`migrateWorkflowProject` → `foldResultBatches`，加载与导入都会走）：同 `batchId` 且都带 `batchIndex` 的结果批次折叠到 `batchIndex 0` 的首图；旧指针指向别的成员时先换成首图（用户看到的封面不变）；有连线 / 非媒体 / 隐藏的成员改成普通节点；手动打组与分镜 / 批量命令建的分组（没有 `batchIndex`）不动。
- Agent：`workflow.inspect` 全量里能读到 `metadata.alternates`，summary 给 `alternateCount`；`workflow.batch.pick` 的候选 = 首图 + 同 `batchId` 的备选，产出的 `set_batch_primary` 由画布执行交换。

## 三、界面

- 结果总数 ≤4（首图 + ≤3 个备选；阈值是 `batchAlternates.ts` 的单个常量 `ALTERNATE_STACK_MAX_TOTAL = 4`，按总数算）：恢复原来的斜叠卡片（`WorkflowAlternatesStack`）。外观沿用旧 `WorkflowBatchStack` / `WorkflowBatchGallery`：后层用 `.workflow-batch-stack__layer` + `ImageFan` 的 `fanPose` / `FAN_SPRING`（左右斜出、悬停散开），右上角 `.workflow-batch-stack__expand` 的“N 张”胶囊；展开用 `.workflow-batch-cell` 外观，以首图为左上角铺 2 列网格，每格的出场 / 收回姿态与弹簧抽到 `batchStackMotion.ts`，与分镜分组的 `WorkflowBatchCell` 共用。格子带 下载 / 设为首图（锁定节点不显示），点格子进画廊，首图标“首图”，胶囊变“收起”。图片与视频一样处理（视频用封面 + 时长）。
  - 数据模型不变：备选仍是首图节点 `metadata.alternates` 里的数据，后层卡片与展开格子都是首图节点 DOM 的子元素（后层 `z-index:-1` 落在节点自身叠放上下文里，排在节点内容之下），不是画布节点、不是分组、不进 `batchId` 分组框。拖首图、后层卡片或展开格子都走 `startNodeDrag`，只移动这一个节点，整摞跟着走；拖过之后松手不算单击（不打开画廊）。展开时节点 `z-index:29` 浮在其它节点之上（拖动中的 30 仍最高），展开范围计入 PromptBar 定位与画布裁剪。
  - 原来的节点下方缩略图条（≤4 个备选）已删除：总数 ≤4 走叠放，总数 ≥5 走网格，条带模式不再有使用者。
- 总数 >4：节点下方停靠网格，宽度 = 节点宽度，最多露出 2 行半，内部滚动（滚轮不缩放画布）；每格复选框，表头全选 / 计数徽标；选中后表头变成 对比预览 / 导出 / 拆成独立节点 / 删除；可收起。`@container wfalt`：≤420px 批量操作只留图标，≤220px 标题只留计数。
- 画廊（`MediaPreviewModal` 的 `gallery` 参数）：大图 + 缩略条，←/→ 切换（焦点在视频控件上时让给控件），显示 n / N，视频原生控件，非首图条目有“设为首图”。不传 `gallery` 时单节点预览行为不变。
- 选中首图时 PromptBar 放在备选区下面，不压住缩略图。备选区是节点附属内容（第 1 层实底 + 发丝线），不用玻璃。

## 三点五、生成路径审计（2026-11-16，叠放改版时复查）

- `runWorkflowGeneration`（节点 / PromptBar 生成，`count` 上限 4）：多张时第一份原位写进源节点，其余只作为 `metadata.alternates`；不建节点、不打组。只有运行期间用户换了该节点媒体（`detachedResult`）时，结果才另存为连线的普通节点，且清掉 `batchId` / `batchIndex`，不成组。8 / 16 张是多次生成累积在同一节点上的备选（新一批在前）。
- 流水线版本导入（`WorkflowWorkspace` → `planPipelineVersionNodes`）：最新版本是节点本身，其余是备选，不打组。
- 仍会打组（`group_nodes`，`source: 'auto'`）的两条路径都不是“同一次生成的多结果”，而是多个不同内容的独立节点：分镜脚本“批量生成”（每个镜头一个节点，`handleScriptBatchGenerate`）与批量命令（每条不同提示词一个节点，`InfiniteWorkflow` 批量命令处理）。它们仍用原来的叠放 / 展开 / 生成历史展示，本次未改。手动打组（`source: 'manual'`）同样保留。

## 四、验证

- `npx tsc --noEmit`：仅剩本机未装 `dsh-plugin` 依赖的既有错误。
- 相关 vitest：`batchAlternates`（含混合图片 / 视频多次“设为首图”后画廊 ID 不重复，即无重复 React key）、`workflowNodeExit`、`mediaPreviewModal`、`batchPick`、`pipelineCanvasVersions`、`pipelineRuns`、`workflowGeneration`、`workflowMigration`、`workflowNodeOverlays`、`workflowGenerationLoader`，以及引用 ops / dispatcher / InfiniteWorkflow 的其余 31 个文件；`npm run test:critical` 10/10；`npm run docs:check`；`npm run build`。
- 截图（亮 / 暗）：2 / 4 / 9 张图片、4 条视频、混合、网格多选、画廊（选中项对比 + 混合含视频）、拖动后、旧项目迁移后。
- 叠放改版：`workflowAlternatesStack.test.tsx`（阈值、展开几何、设为首图 / 预览 / 收起、锁定、拖叠放 = 一次写入只移动一个节点且备选随行、>4 走网格）；截图（亮 / 暗）2 / 3 / 4 张收起与展开、悬停散开、混合图片 / 视频（展开、悬停操作、设为首图后变视频首图）、从格子进画廊、8 / 16 张网格、展开状态下拖格子后、收起状态拖动后。

## 五、已知限制

- 备选不参与画布上的连线与引用（要单独用，先“拆成独立节点”）。
- 分镜 / 批量命令建的 `auto` 分组（多个不同节点）仍用原来的叠放展示，本次未改。
- 展开的叠放格子占画布空间但不参与碰撞 / 自动排版，可能盖住右下方的节点（展开时整摞置顶）；收起即恢复。
- 单击带生成配置的节点会弹出“该操作没有修改 Workflow Draft：写入内容与当前节点完全一致”并使 rev +1：在 origin/main（a6ecc5b）上用同一场景同样复现，不是本次引入，本次未改。
- 迁移在加载时进行，不单独写撤销记录；持久化版本升到 v4，升级时整份旧状态先写入 `iris:workflow:projects:backup`。
