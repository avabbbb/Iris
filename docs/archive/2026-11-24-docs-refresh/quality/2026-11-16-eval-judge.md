# 2026-11-16 评测体系与 LLM-as-a-Judge

评测方法的总纲见 [eval/eval.md](../../../../eval/eval.md)，本记录只写这一轮做了什么、怎么验证、还差什么。

## 做了什么

1. **eval.md 总纲**：五层评测对象（L1 Prompt / Skill、L2 SOP、L3 执行、L4 创作效果、L5 Benchmark）；规则、LLM-Judge、实验三层方法；六层漏斗 Rubric（CTX / SCOPE / HONEST / TOOL / CONTENT 串行短路，RED 并联一票否决）；Auto Rubrics；四步归因；准入、灰度、监控三阶段门禁。参考了数字人复盘、AIGC 工作流演变、春晚工作流三份 SOP，大淘宝两篇评测文章，以及公开 benchmark（τ-bench、HealthBench、PaperBench、Seed 系列报告）。外部文章原文不进仓库，`eval/references/` 只留链接。
2. **执行成功率**：借鉴购物助手的「路由 × 回复」，按 Iris 的链路拆成四段：路由（走对能力面）× 调用（先看后改、幂等、参数）× 产出（每张分镜、每个镜头在 L4 Rubric 上通过）× 回复（如实说明）。Rubric 子项用 `stage` 标注，报告按段给出条件通过率，四段相乘等于端到端成功率。
3. **Judge 层** `eval/judge/`：`run.mjs` 提供 validate / compile / judge / pairs / screen / gate / sample-size；清洗（四层 + 跨轮隔离 + 脱敏）、输出解析三层防线、多轮一致（不一致不投票，标为不稳定）、成对比较位置交换、kappa 与 Wilson 区间。6 份 Rubric：agent-run（L3）、prompt-static（L1）、sop-recall（L2）、image-output、video-shot、digital-human（L4）。`--replay` 可不调模型复现。
4. **`workflow.node.run --wait-seconds <n>` / `--no-wait`**：到时未完成返回 `status: running` 回执，生成继续；用同一幂等键再调一次会接上进行中的 run，不会重复扣费。
5. **清理**：SKILL.md 与 workbuddy 文档里的「打开 Iris」改为 Iris；`dsh-plugin` 测试与构建通过。

## 怎么验证

- `tests/evalJudge.test.ts` 19 项（含执行成功率漏斗）；`npm run eval:judge:demo` 回放 7 条合成样本，路由 80%、调用 100%、产出 50%、回复 50%，执行成功率 16.7%。合成样本只验证管线，不代表真实质量。
- `tests/irisNodeRunWait.test.ts` 5 项；`tests/agentRunReceiptsIntegration.test.ts` 新增端到端用例：`--wait-seconds 1` 先拿到 running，同键再调拿到结果，执行器只跑一次。
- `npm run test:critical` 57 项通过；`docs:check` 通过。

## 还差什么

见 eval.md §13：「设为首图」偏好事件、视频抽帧脚本、真实 Judge 模型上的首批人工标注（每份 Rubric ≥100 条）、`gate` 接入 CI。RunningHub 生成前估价（`price-preview`）未接入计划卡。
