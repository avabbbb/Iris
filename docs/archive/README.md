# 归档索引 · Archive index

> 只读历史。这里的文档只解释“当时为什么”，不定义今天的产品、架构或支持等级——当前口径只看 [docs/index.md](../index.md) 列出的 current truth、[SUPPORT_MATRIX](../../SUPPORT_MATRIX.md) 与代码。归档文件里的 “Flovart”“Iris tab / 个人 Agent”“逆向 / Reverse”“Table” 都是旧名或旧方案（2026-11-20 起产品名为 Iris，顶栏为 Canvas｜Cut｜Agent）。
>
> Read-only history. Nothing here overrides the current docs listed in [docs/index.md](../index.md), the [Support Matrix](../../SUPPORT_MATRIX.md) or the code.

约定：每批归档放在 `docs/archive/<日期>-<主题>/`，保留原相对结构，用 `git mv` 移入以保留历史；每批目录里有自己的 README（逐份原因表）。较早批次的文件内相对链接按原位置书写，可能失效。

## 2026-11-24 · 文档整理（[2026-11-24-docs-refresh/](2026-11-24-docs-refresh/)）

| 文档 | 一句话 | 归档原因 → 取代者 |
| --- | --- | --- |
| [quality/2026-11-15-basic-function-eval.md](2026-11-24-docs-refresh/quality/2026-11-15-basic-function-eval.md) | 外部 Agent 经 CLI 驱动画布的一轮评测与当日修复 | 无遗留 → [eval/eval.md](../../eval/eval.md) |
| [quality/2026-11-15-dsh-connection-ui.md](2026-11-24-docs-refresh/quality/2026-11-15-dsh-connection-ui.md) | DSH 链接错误分类与连接面板 UI 排障 | 已修复 → [DSH 工作台计划](../plans/dsh-workbench.md)、[12 Agent](../design/12-agent.md) |
| [quality/2026-11-16-batch-alternates.md](2026-11-24-docs-refresh/quality/2026-11-16-batch-alternates.md) | 多结果改“首图 + 备选”，修复拖走批次后的残影 | 已实现并有测试 → [01](../design/01-interaction.md)、[10](../design/10-canvas-workflow.md) |
| [quality/2026-11-16-eval-judge.md](2026-11-24-docs-refresh/quality/2026-11-16-eval-judge.md) | 评测总纲与 LLM-as-a-Judge 的建设日志 | 一次性日志 → [eval/eval.md](../../eval/eval.md) §13 |
| [blog/2026-11-03-extension-web-canvas-bridge.md](2026-11-24-docs-refresh/blog/2026-11-03-extension-web-canvas-bridge.md) | 更名前开发日志：插件 × 网页画布配对、导入、密钥同步 | Flovart 时期一次性日志 → [15](../design/15-web-community-extension.md)、[extension/README](../../extension/README.md) |

## 2026-11-24 · AgentOS 定位对齐（[2026-11-24-agentos-alignment/](2026-11-24-agentos-alignment/)）

| 文档 | 一句话 | 归档原因 → 取代者 |
| --- | --- | --- |
| [11-iris.md](2026-11-24-agentos-alignment/11-iris.md) | 把顶栏第二入口定义为独立 “Iris Personal Agent / 逆向工作台” 的旧模块文档 | 与已实现的 Cut 剪辑器不符 → [11 Cut / Creative AgentOS](../design/11-iris.md) |
| [01-interaction.md](2026-11-24-agentos-alignment/01-interaction.md) | 改版前的交互设计全文（对话首页、多 Agent 光标飞入、旧 Iris UI） | 保留原稿备查 → [01 交互设计](../design/01-interaction.md)（现行版本） |
| [16-agent-video-pipeline.md](2026-11-24-agentos-alignment/16-agent-video-pipeline.md) | 2026-11-13–15 的 Agent 视频流水线能力矩阵与 P0–P2 计划 | 阶段性矩阵不代表现状 → [00](../design/00-overview.md) §8、`tools/iris/pipeline/`、[SUPPORT_MATRIX](../../SUPPORT_MATRIX.md) |

## 2026-11-17 · Iris 定位（[2026-11-17-iris/](2026-11-17-iris/)）

| 文档 | 一句话 | 归档原因 → 取代者 |
| --- | --- | --- |
| [README.draft.zh-CN.md](2026-11-17-iris/README.draft.zh-CN.md) | 2026-11-03 的中文 README 草稿（含“案例”结构） | 定位被取代、多处资源失效 → [README.zh-CN.md](../../README.zh-CN.md) |
| [vision-three-tracks.md](2026-11-17-iris/vision-three-tracks.md) | 三条产品线远景草案（录制 / 视频逆向 / 宿主上下文） | 线 B、C 并入当时的 Iris 定位 → [00](../design/00-overview.md)、[14](../design/14-creative-hosts.md) |

## 2026-11-16 · 评测文档蒸馏（[2026-11-16-eval-distill/](2026-11-16-eval-distill/)）

| 文档 | 一句话 | 归档原因 → 取代者 |
| --- | --- | --- |
| [2026-11-11-agent-tool-eval.md](2026-11-16-eval-distill/2026-11-11-agent-tool-eval.md) | Agent / 工具链迭代记录（文本节点、裁剪 v2、视频工具、`--dryRun`） | 改动已实现 → [eval/eval.md](../../eval/eval.md)、[10](../design/10-canvas-workflow.md)、[12](../design/12-agent.md) |
| [2026-11-12-agent-tool-eval-2.md](2026-11-16-eval-distill/2026-11-12-agent-tool-eval-2.md) | 上一份的增量记录 | 同上；遗留项并入 [todo.mdx](../content/docs/progress/todo.mdx) |

## 2026-11-13 · 设计语言与文档树清理（[2026-11-13-design-refresh/](2026-11-13-design-refresh/)）

| 文档 | 一句话 | 归档原因 → 取代者 |
| --- | --- | --- |
| [30-competitive-replication.zh-CN.md](2026-11-13-design-refresh/30-competitive-replication.zh-CN.md) | 14 项竞品机制复刻计划 | 已全部实现 → [10](../design/10-canvas-workflow.md) §5.1 |
| [31-notion-compact-ui.zh-CN.md](2026-11-13-design-refresh/31-notion-compact-ui.zh-CN.md) | Notion 式紧凑 UI token 清单 | 已实施 → [DESIGN.md](../design/DESIGN.md) |
| [32-stream-usage.zh-CN.md](2026-11-13-design-refresh/32-stream-usage.zh-CN.md) | 流式输出与用量统计设计稿 | 已在 `services/sse.ts` 等实现 → [13](../design/13-generation-runtime.md) §6.1 |
| [AGENT_CANVAS_VS_LIBTV.md](2026-11-13-design-refresh/AGENT_CANVAS_VS_LIBTV.md) | 2026-11-04 与 LibTV 的一次性对标 | 对方资料未核实；落地项已在代码 → [12](../design/12-agent.md) |
| [LIBTV_BENCHMARK_OPTIMIZATION.md](2026-11-13-design-refresh/LIBTV_BENCHMARK_OPTIMIZATION.md) | “面试版” LibTV 对标优化报告 | 一次性；P0/P1 已实现 → [12](../design/12-agent.md)、[13](../design/13-generation-runtime.md) |
| [2026-11-07-plan-card-design.md](2026-11-13-design-refresh/2026-11-07-plan-card-design.md) | 生成计划卡设计稿 | 已实现（`components/GenerationPlanCard.tsx`）→ [13](../design/13-generation-runtime.md) §4 |
| [beta-readiness-0.3.0.md](2026-11-13-design-refresh/beta-readiness-0.3.0.md) | 0.3.0 内测上线清单 | 阶段性清单 → [SUPPORT_MATRIX](../../SUPPORT_MATRIX.md)、[pending-test](../content/docs/progress/pending-test.mdx) |
| [dsh-author-form.md](2026-11-13-design-refresh/dsh-author-form.md) | DSH 作者表单填写文案 | 一次性文案，无取代者 |
| [immersive-translate-benchmark.md](2026-11-13-design-refresh/immersive-translate-benchmark.md) | 沉浸式翻译插件上架方案调研 | 一次性调研 → [15](../design/15-web-community-extension.md) |
| [demo-scenarios.zh-CN.md](2026-11-13-design-refresh/demo-scenarios.zh-CN.md) | 面试演示场景与数字 | 一次性，数字随版本过时 → [SUPPORT_MATRIX](../../SUPPORT_MATRIX.md) |

## 2026-10-19 · Beta 评估（[2026-10-19/](2026-10-19/)）

| 文档 | 一句话 | 归档原因 → 取代者 |
| --- | --- | --- |
| [evaluation/FLOVART_BETA_EVALUATION.zh-CN.md](2026-10-19/evaluation/FLOVART_BETA_EVALUATION.zh-CN.md) | Flovart 画布产品评估、测试与优化反馈报告 | 一次性报告 → [todo.mdx](../content/docs/progress/todo.mdx)、[eval/eval.md](../../eval/eval.md) |

## 2026-10-07 · 文档重构（[2026-10-07/](2026-10-07/)）

重构前 `docs/` 下的设计、ADR、开发契约与 RC 证据；仍有效的结论已蒸馏进 [docs/design](../design/)，ADR 决策摘要见 [00 总体设计](../design/00-overview.md) §5。

**ADR（[adr/](2026-10-07/adr/)）** —— 决策仍有效、原文退役，统一由 00 §5 的决策表承接：

| ADR | 一句话 |
| --- | --- |
| [0002](2026-10-07/adr/0002-local-first-production-execution.md) | 制作执行保持本地优先，网站后端不做生成中转 |
| [0010](2026-10-07/adr/0010-use-content-addressed-local-artifacts.md) | Artifact 用稳定 ID + 内容寻址 |
| [0023](2026-10-07/adr/0023-centralize-production-execution-contract.md) | 所有入口共用一份生成任务实现 |
| [0027](2026-10-07/adr/0027-use-schema-driven-route-mapping.md) | Schema 驱动的 Route Mapping（PromptBar 与 Preflight 同一 schema） |
| [0037](2026-10-07/adr/0037-separate-distribution-channels-over-one-core.md) | 插件与工作区共用一份本地能力 |
| [0049](2026-10-07/adr/0049-build-a-minimum-real-creator-community.md) | 最小创作者社区：发布真实作品与可选 Remix Bundle |
| [0059](2026-10-07/adr/0059-lock-visual-style-to-approved-reference.md) | 以已批准样图锁定跨镜头风格（风格锚点） |
| [0060](2026-10-07/adr/0060-use-a-desktop-authoritative-browser-import-bridge.md) | 浏览器扩展走桌面权威的受限导入桥 |
| [0063](2026-10-07/adr/0063-dsh-browser-workflow-authority.md) | DSH Browser 工具保持明确项目绑定 |
| [0065](2026-10-07/adr/0065-idempotent-revisioned-workflow-mutations.md) | Workflow 修改带 projectId + expectedRevision + mutationId，幂等 |
| [0068](2026-10-07/adr/0068-first-safe-generation-boundaries.md) | 首次生成渐进配置并确认实际范围；工具权限 ≠ 费用授权 |
| [0069](2026-10-07/adr/0069-native-effects-with-one-generation-path.md) | 原生效果：一条生成路径 + 独立本地渲染 |
| [0070](2026-10-07/adr/0070-contract-first-cli-mcp-native-projections.md) | CLI / MCP / Native 都是同一 canonical contract 的投影 |
| [0071](2026-10-07/adr/0071-local-folder-reference-media.md) | 本地文件夹素材用引用语义，不复制字节 |
| [0072](2026-10-07/adr/0072-project-use-is-a-browser-activation.md) | `workflow.project.use` 是浏览器激活命令（延迟修复决定） |

**设计与开发契约**：

| 文档 | 一句话 | 取代者 |
| --- | --- | --- |
| [design/flovart-native-effects.md](2026-10-07/design/flovart-native-effects.md) | 旧主设计：创作宿主与 Agent 协作、原生效果 | [00](../design/00-overview.md)、[14](../design/14-creative-hosts.md) |
| [design/agent-integration.md](2026-10-07/design/agent-integration.md) | 旧 Agent 连接中心设计 | [12 Agent](../design/12-agent.md) |
| [design/adaptive-layout.md](2026-10-07/design/adaptive-layout.md) | 容器驱动布局的原始说明 | [DESIGN.md](../design/DESIGN.md) §15 |
| [design/product-story-agent-onboarding.md](2026-10-07/design/product-story-agent-onboarding.md) | Flovart 产品故事与 Agent onboarding 参考提案 | [00](../design/00-overview.md) |
| [dev/node-plugin-sdk.md](2026-10-07/dev/node-plugin-sdk.md) | Workflow Node Plugin SDK 契约 | `components/workflow/nodePluginSdk.tsx`、[10](../design/10-canvas-workflow.md) |
| [dev/prompt-asset-contract.md](2026-10-07/dev/prompt-asset-contract.md) | PromptAsset 契约 | `services/promptAsset.ts`、[13](../design/13-generation-runtime.md) |
| [dev/provider-extension-contract.md](2026-10-07/dev/provider-extension-contract.md) | Provider 扩展两层（正式 / 用户脚本） | [13](../design/13-generation-runtime.md) |
| [dev/runninghub-route-catalog.md](2026-10-07/dev/runninghub-route-catalog.md) | RunningHub 首期 Route Catalog | `services/runningHubRouteCatalog.ts`、[13](../design/13-generation-runtime.md) |
| [branding/IRIS_MIGRATION.md](2026-10-07/branding/IRIS_MIGRATION.md) | 更早一次“Iris”品牌迁移的记录（当时定位为“专业剪辑工具的 AI 创作层”，画布不是产品前提）；与 2026-11-20 的 Flovart → Iris 更名不是同一次 | [CHANGELOG](../../CHANGELOG.md) 0.1.1、[AGENTS.md](../../AGENTS.md) §0 |
| [maintenance/agent/CONTEXT.md](2026-10-07/maintenance/agent/CONTEXT.md) | Flovart 时期的领域术语表 | [00](../design/00-overview.md) §10 |
| [maintenance/readme/DEMO_RECORDING.md](2026-10-07/maintenance/readme/DEMO_RECORDING.md) | 2026-09-16 README 演示录制记录（`scripts/record-feature-clips.mjs` 注释仍引用） | README 的 90 秒演示片 |

**发行候选证据（[evidence/release-candidate/](2026-10-07/evidence/release-candidate/)）** —— Flovart RC 阶段的本地认证快照，已被 [SUPPORT_MATRIX](../../SUPPORT_MATRIX.md) 取代为唯一发布口径；Codex 5 次真实 trial 证据（`CODEX_TRIAL_EVIDENCE.md`）仍被 Support Matrix 引用：

| 文档 | 一句话 |
| --- | --- |
| [RELEASE_TRUTH_MATRIX.md](2026-10-07/evidence/release-candidate/RELEASE_TRUTH_MATRIX.md) | RC 声明与门禁总表 |
| [RC_FINAL_CERTIFICATION.md](2026-10-07/evidence/release-candidate/RC_FINAL_CERTIFICATION.md) / [RC_BASELINE.md](2026-10-07/evidence/release-candidate/RC_BASELINE.md) / [RC_VERSION_TRUTH.md](2026-10-07/evidence/release-candidate/RC_VERSION_TRUTH.md) | 本地认证快照、基线与版本一致性 |
| [CODEX_CERTIFICATION.md](2026-10-07/evidence/release-candidate/CODEX_CERTIFICATION.md) / [CODEX_TRIAL_EVIDENCE.md](2026-10-07/evidence/release-candidate/CODEX_TRIAL_EVIDENCE.md) | Codex 认证包与 5 次连续 `codex exec` 真实 trial |
| [REAL_PROVIDER_CERTIFICATION.md](2026-10-07/evidence/release-candidate/REAL_PROVIDER_CERTIFICATION.md) / [RC_PROVIDER_RESILIENCE_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_PROVIDER_RESILIENCE_EVIDENCE.md) | 真实 Provider 认证矩阵与 Provider 韧性 |
| [THREAT_MODEL.md](2026-10-07/evidence/release-candidate/THREAT_MODEL.md) / [GITHUB_REPOSITORY_SECURITY_CHECKLIST.md](2026-10-07/evidence/release-candidate/GITHUB_REPOSITORY_SECURITY_CHECKLIST.md) / [RC_SECURITY_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_SECURITY_EVIDENCE.md) / [RC_SECURITY_AUTOMATION_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_SECURITY_AUTOMATION_EVIDENCE.md) / [RC_CODEQL_TRIAGE.md](2026-10-07/evidence/release-candidate/RC_CODEQL_TRIAGE.md) / [RC_DEPENDENCY_AUDIT.md](2026-10-07/evidence/release-candidate/RC_DEPENDENCY_AUDIT.md) / [RC_RED_TEAM_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_RED_TEAM_EVIDENCE.md) | 威胁模型、仓库安全设置、安全自动化、CodeQL、依赖审计与红队 |
| [LINK_IMPLEMENTATION_BASELINE.md](2026-10-07/evidence/release-candidate/LINK_IMPLEMENTATION_BASELINE.md) / [RC_BROWSER_LAUNCH_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_BROWSER_LAUNCH_EVIDENCE.md) / [RC_HOST_CHAOS_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_HOST_CHAOS_EVIDENCE.md) | Link 2.0 基线、浏览器启动与端口隔离、宿主 / 浏览器混沌测试 |
| [RC_CANVAS_STRESS_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_CANVAS_STRESS_EVIDENCE.md) / [RC_PERFORMANCE_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_PERFORMANCE_EVIDENCE.md) / [RC_RESOURCE_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_RESOURCE_EVIDENCE.md) | 画布压力、性能与资源生命周期 |
| [RC_INSTALLER_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_INSTALLER_EVIDENCE.md) / [RC_UPDATER_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_UPDATER_EVIDENCE.md) / [RC_ARTIFACT_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_ARTIFACT_EVIDENCE.md) / [RC_PACKAGED_UI_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_PACKAGED_UI_EVIDENCE.md) / [RC_CI_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_CI_EVIDENCE.md) | Windows 安装包、更新器、发布产物、打包 UI 首次使用与 CI |
| [RC_MIGRATION_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_MIGRATION_EVIDENCE.md) / [RC_OFFLINE_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_OFFLINE_EVIDENCE.md) / [RC_DIAGNOSTICS_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_DIAGNOSTICS_EVIDENCE.md) / [RC_PLUGIN_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_PLUGIN_EVIDENCE.md) / [RC_ACCESSIBILITY_EVIDENCE.md](2026-10-07/evidence/release-candidate/RC_ACCESSIBILITY_EVIDENCE.md) | 数据迁移、离线、诊断导出、插件隔离与无障碍 |

## 更早的散件

| 路径 | 一句话 | 归档原因 |
| --- | --- | --- |
| [historical-design/2026-09-23-canonicalization.md](historical-design/2026-09-23-canonicalization.md) | 2026-09-23 多代 Agent / Crew / Production Skill 设计的蒸馏快照 | 旧架构（Crew / Director / Operator）已退役 → [00](../design/00-overview.md) |
| [historical-design/2026-09-23-readme-launch-audits.md](historical-design/2026-09-23-readme-launch-audits.md) | 2026-09-23 README 与上线审计快照 | 一次性审计 → 现行 README |
| [artifacts/vox-ai-datacenter-theft-2026-08-03.json](artifacts/vox-ai-datacenter-theft-2026-08-03.json) | `flovart.production-spec/1` 格式的一份制作 spec 样例（AI 数据中心题材，30 秒） | 旧 spec 样例，仅追溯 |
| [assets/workflow-canvas-state.jpeg](assets/workflow-canvas-state.jpeg) | 2026-09 的 Workflow 画布截图 | 旧 UI |
| [patches/richprompt-lifecycle.patch](patches/richprompt-lifecycle.patch) | `components/RichPromptEditor.tsx` 占位符 / 生命周期的一份补丁文件 | 留作参考，不应直接应用 |

---

**仍在 active tree、但已标注为历史 / 存根的文件**：[docs/design/16-agent-video-pipeline.md](../design/16-agent-video-pipeline.md) 现为指向本目录的存根（代码注释仍引用该路径，故不移动）。ADR [docs/adr/cut-editor.md](../adr/cut-editor.md) 是现行决定，不归档。
