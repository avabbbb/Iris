# 2026-11-15 DSH 链接错误与连接面板 UI

范围：浏览器画布 ↔ 本机 Iris Agent（Workspace Operator，DSH / Codex / CLI 都经它连到可见画布）的连接链路；Agent 抽屉里的「连接指引 / 连接状态 / 运行日志」三页；DSH 嵌入页头部状态。

复现方式：沙箱内 Vite dev server + 本地 mock Agent（`/health`、`/hosts`、`/events` SSE、`/crew/protocol`、`/activity`），分别模拟正常、SSE 永不 hello、token 失效、端口无服务、协议版本不同；Playwright（Chromium headless shell，zh-CN）在 360 / 768 / 1440 宽与抽屉最小 280 宽截图。截图不入库。

## 一、链接错误

| # | 现象 | 根因 | 修复 | 测试 |
| --- | --- | --- | --- | --- |
| 1 | DSH 里画布偶发停在「连接已失效，请重新从启动器打开画布」，宿主刚发过新 token | `bootstrapLocalAgentConnection` 只有一个 in-flight：应用启动时用 sessionStorage 里的旧 session token 重试，DSH 随后发来的新一次性 token 直接拿到旧的 promise 被吞掉；旧 token 401 后清掉凭证 | 带 `location`（嵌入新 token）或 `force`（用户点重新连接）的调用总是新开一轮，并用 generation 让被取代的旧轮不再写 store / binding / sessionStorage | `agentLinkIssue.test.ts` › lets a fresh DSH bootstrap token supersede a stale session retry |
| 2 | Workspace Operator 没启动时，DSH 嵌入页显示「凭证失效」 | `/bootstrap/exchange` 网络层失败（无 HTTP 响应）也被当成 `AUTH_FAILED` | 只有真实 HTTP 拒绝才算 auth；无响应时诊断并标为离线（未运行 / 不可达 / 超时） | › treats an unreachable Agent during the one-time exchange as offline |
| 3 | Agent 启动比页面慢时，之后怎么点都是「未连接」，刷新也没用 | 启动器参数在 URL 里被立即擦除，但凭证只在验证成功后才写 sessionStorage；8 次重试失败后凭证彻底丢失 | 换得凭证后先存 sessionStorage（401 时清除）；「重新连接」以 `force` 重跑 bootstrap 复用它 | › keeps the launcher credential when the Agent is still starting |
| 4 | Operator 重启 / session 过期后，状态在「连接中断」与「连接中」之间每 15s 来回跳，永远不恢复 | EventSource 错误不带状态码，bridge 只会指数退避重连；session token 存在 Operator 内存里，重启即失效，401 永远重试 | 流错误后用两个探针分类（见下）；凭证失效 / 来源被拒 / 版本不符属于终止类，停止无效重连并显示原因；DSH 嵌入页自动向宿主重新申请一次性 token（节流 15s） | › turns a stream error with an expired credential into auth_failed…；› asks the DSH host for a fresh credential…；`dshEmbedBridge.test.ts` › asks the host for a fresh one-time token, throttled |
| 5 | 状态卡在「正在连接…」 | SSE 连接建立但从不发 `hello`（代理缓冲、半死进程）时既无 hello 也无 error | `hello` 10s 超时即按超时失败并退避重连 | › does not stay "connecting" when the stream opens but never says hello |
| 6 | 画布同步失败后状态仍显示「已连接」；或显示错误后不再恢复 | `publishLatest` 的 catch 只回调外部 `onStatus`，没更新 store；也没有恢复路径 | 同步失败写入 `sync_failed`（或探针结果）；下一次成功发布自动回到 ready | › recovers from a failed canvas sync on the next successful publish |
| 7 | 每次启动都闪一下「未连接 / 还没有连接本机 Agent」 | Adapter 在 bootstrap 还没设置 binding 时就把状态写成 offline | bootstrap 进行中时 Adapter 不覆盖状态，由 bootstrap 决定结果 | 截图 `connecting-*-log`：日志只有「正在连接…」 |
| 8 | DSH 头部在 iframe 还没连上时就显示「已连接」 | `IrisFrame` 把「已把 token 交给 iframe」当成连接成功 | 交出 token 后显示「正在连接画布」；嵌入页把真实 `status + issue kind` 通过 `flovart:dsh-link` 回传（不带 URL / token / 报错原文） | `dshEmbedBridge.test.ts` › reports the real link state to the host |
| 9 | 连接失败提示「无法连接到该 AI 服务」「API Key 无效」 | Host discovery 的网络错误走了 Provider 用的 `displayError` | 改为链接分类文案 | 代码审查 |

**分类探针**（`services/agentLinkIssue.ts`）：浏览器拿不到 EventSource 的状态码，CORS 拒绝与端口拒绝都表现为 `TypeError`，所以用访问规则不同的两个端点区分：

- `/health`（无鉴权、总是可跨源读取）：超时 → `timeout`；快速网络失败 → `refused`（Agent 未运行 / 端口不对）；慢失败 → `unreachable`；HTTPS 线上页 → `blocked_by_page`；非 Iris 应答 → `wrong_service`。
- `/crew/protocol`（需 token、只对已授权来源回 CORS 头）：401 → `auth`；`/health` 通而它网络失败或 403 → `cors`；404 或 `protocolVersion` ≠ 1 → `version`。
- 两者都正常但流仍断 → `stream_lost`（继续自动重连）。

每类都有中英文标题、原因、下一步与可复制命令；`/health` 探针不带 token。

## 二、`tests/dshService.test.ts` 失败与 tsc 17 个错误

不是代码缺陷，是本地环境缺 `dsh-plugin` 的依赖：根 tsconfig 虽然 exclude 了 `dsh-plugin`，但 `tests/dsh*.test.ts` 会把 `dsh-plugin/src` 拉进类型检查，而 `@deepseek-ai/*` 只装在 `dsh-plugin/node_modules`（`tests/dshService.test.ts` 还直接 import `../dsh-plugin/node_modules/@deepseek-ai/cordis`）。CI 在 tsc / vitest 前固定执行 `npm --prefix dsh-plugin ci`。本机执行同一命令后：tsc 0 错误、`tests/dshService.test.ts` 4/4 通过、`dsh-plugin` 自身 `tsc` 与 `npm test`（25 项）通过。本地开发需要先跑 `npm --prefix dsh-plugin ci`。

## 三、连接面板 UI

旧问题：三页是零散 Tailwind 行内样式 + 硬编码 `#e5484d`，没有容器断点；窄宽下标题、徽标、按钮挤成多行，「其他 Agent」卡片文字折行，日志行被 `truncate` 截掉、没有等宽、没有级别；连接状态只有一个颜色点 + 文字，看不出原因。

- **连接指引**：`AgentHostPicker` 改为单一 `agentpicker` 容器；本机连接用徽标（点 + 文字）；选中 Agent 下方是编号步骤 `AgentSetupGuide`（DSH / Codex / WorkBuddy 各自的真实命令，命令单行截断 + `title` + 复制按钮）；连接未就绪时主按钮是「重新连接」，连接中禁用并显示「等待连接」，不再在连接过程中闪「离线」。顶栏 Agent 页的 DSH 步骤复用同一组件，版本口径更新为 DSH 0.2.x。
- **连接状态**：`AgentLinkStatus` —— 徽标（已连接 / 正在连接 / 正在重连 / 未连接 / 连接失败 / 连接中断 / 凭证失效）、状态更新时间、原因卡（标题、原因、下一步、可复制命令）、服务地址（截断 + 复制）、当前操作者、已接入画布窗口；「重新连接」在 ≤420px 变图标按钮；「复制诊断信息」只含状态、分类、地址、时间，不含 token。
- **运行日志**：`AgentRunLog` —— 链接事件与 Agent 每一步按时间合并；等宽字体、`HH:MM:SS` 时间戳、OK / RUN / INFO / WARN / ERR 级别着色；长路径与 URL 用 `overflow-wrap:anywhere` 折行；在底部时自动跟随，向上滚动即暂停并出现「N 条新日志」跳转；筛选（全部 / 连接 / 各 Agent）、复制、清空（清空后历史同步不会把旧行加回来）；≤340px 时一行改两行。链接事件在 store 中去重，退避重连期间不刷屏。
- 断点全部写在 `styles/fluid.css`（每个组件 ≤2 个），基础样式在 `styles/agentLink.css`，只用 DESIGN token；抽屉内卡片标题与抽屉页头重复，改为仅读屏可见。

截图验收（沙箱，非真实 DSH 宿主）：360 / 768 / 1440 宽 × 未连接 / 连接中 / 已连接 / 凭证失效 / 端口无服务 × 三页，外加 1440 宽抽屉拖到最小 280 宽；脚本逐元素检查抽屉内水平溢出，结果为 0。另有暗色主题一组（360 / 1440 宽，已连接与凭证失效），无硬编码颜色发黑发白。

## 四、验证

- 新增 `tests/agentLinkIssue.test.ts`（18）、`tests/agentLinkPanels.test.tsx`（7）；更新 `tests/agentHostPicker.test.tsx`（离线时「重新连接」与 DSH 步骤）、`tests/dshEmbedBridge.test.ts`（重新申请 token、状态回传）。
- 未覆盖：真实 DSH Desktop / 登录态下的端到端（仍是 `docs/plans/dsh-workbench.md` 的外部门槛）；暗色只截了两种状态。
