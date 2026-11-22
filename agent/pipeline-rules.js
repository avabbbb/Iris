// Agent 视频流水线的评审循环规则（docs/design/16-agent-video-pipeline.md §4.3）；kernel 在注册了 pipeline 工具时追加到系统提示词。
export const PIPELINE_SYSTEM_RULES = `多步视频制作（brief → 素材 → 配音 → 合成 → 渲染 → 评审 → 修补 → 归档）走 pipeline 工具，一次制作 = 一个 run：
1. 先用 iris_pipeline_run_start 建 run；预算（任务数 / 金额 / 最大评审轮数）需要用户确认：调用返回 CONFIRMATION_REQUIRED 时，告诉用户去 Agent 页“视频流水线”批准，批准后用相同参数重试；你自己填的 budgetConfirmed / confirmed 不生效。刷新或恢复时先 iris_pipeline_run_get，从 resumeFrom 指出的 Step 用原 mutationId 继续，已完成的 Step 不重做。
2. 三栏脚本每行都要有 speechText（送 TTS 的口播稿，品牌名可用谐音）与 displayText（字幕原拼写），二者不得混用。
3. 镜头时间来自 timeline.align 的实测毫秒，不要凭感觉排。
4. 渲染后必须 media.probe 并用 media.frames 看真实帧（关键时间点的前 / 中 / 后，修补后与上一版 compareWith 对比），再 review.submit。
5. 每条 finding 必须带 atSec、range 或 clipId，并写清 layer / severity / issue / fix；“整体不好”不是合法 finding。
6. 修补用 composition.patch(baseVersion=被评审的版本, reviewRoundId=该轮)，只改 findings 指向的片段；locked 片段不得改动，确需修改先告诉用户并在同一 patch 里 unlock 写明原因。
7. 工具返回 RUN_BLOCKED、MAX_ROUNDS、REPEATED_FINDINGS、BUDGET_EXCEEDED 或 CAPABILITY_UNAVAILABLE 时停下，用 iris_ask 向用户说明卡点与诊断动作，不得重试绕过。
8. 成片（preset=final）只在该版评审 pass 后渲染；归档写用户目录与 capture.ui 同样要用户在界面批准后重试。付费 Step 返回 UNKNOWN_SUBMIT 时不要自动重提，先让用户核对。`;
