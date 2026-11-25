# Iris Link 协议（CLI ↔ 中继 ↔ 浏览器标签页）

Iris Link 让任何机器上的 `iris` CLI —— 包括没有模型 Key 的沙箱 —— 驱动用户浏览器里已经打开的 Iris（默认 https://iris.avabbbb.com）：发起 Agent 回合、跟踪轨迹、审批、取消、列出和调用工具。**命令在标签页里执行，模型 Key（BYOK）始终留在浏览器里。**

同一套命令也可以走本机 loopback（本地 Agent 服务 `127.0.0.1` → 标签页），用 `--target local|web|auto` 选择，默认自动检测（本机有已连接的 Iris 页面就用 local，否则有 `~/.iris/link.json` 就用 web）。

常量的唯一来源：`tools/iris/link/protocol.js`。改协议先改它，再改本文。

## 组成

| 部分 | 文件 | 职责 |
| --- | --- | --- |
| 中继 | `worker/linkRelay.ts`（`/api/link/*`，Durable Object `IrisLinkRelay`） | 配对、签发 / 刷新 / 撤销令牌、转发 WebSocket 帧。不解析 args、不存画布、不接触 Key |
| CLI | `tools/iris/link/*`（`cli-link.js`、`agent-commands.js`、`transports.js`、`web-link-client.js`、`link-store.js`） | `iris login web` / `logout` / `link status` / `agent …` |
| 标签页 | `services/link/*`（`webLinkHost.ts`、`agentLinkCommands.ts`、`agentLinkRuns.ts`、`agentLinkHost.ts`）、`components/link/IrisLinkOverlay.tsx` | 配对确认页、执行命令、审批托盘、连接列表 |
| 本机 loopback | `services/workflowAgentBridge.ts` 的 `tool_call` 分支 | 本地 Agent 服务转进来的 link 命令走同一个处理器 |

## 配对

### 浏览器确认（`iris login web --open`）

1. CLI `POST /api/link/pair/start {clientName, clientAgent, scopes, mode:'open'}`（不带 Origin）。中继按来源 IP 限速（每分钟 10 次），新建房间 `room:<roomId>`（roomId 128 位随机），生成 8 位配对码（`XXXX-XXXX`，去掉易混字符）和只给这个 CLI 的轮询令牌 `ilk_p_<roomId>_<secret>`。返回 `verificationUrlComplete = <origin>/link?code=XXXX-XXXX`，有效 10 分钟。
2. CLI 打开这个地址。它就是 Iris 本身：页面照常加载，`IrisLinkOverlay` 弹出确认框，`GET /api/link/pair/info?code=`（必须带允许列表里的 Origin）显示 CLI 名字、客户端标识、来源（IP 前两段 + 国家 / 城市）、申请时间、申请的权限。
3. 用户核对「终端里显示的配对码就是 XXXX-XXXX」（必勾），逐项勾选权限后点「允许」：`POST /api/link/pair/decide {code, approve, scopes}`。中继只授予 CLI 申请过的范围（页面可以少给），给标签页签发 `ilk_t_<roomId>_<secret>`；配对码随即作废。标签页把 `{roomId, tabToken, clientName, scopes, baseUrl}` 存进 localStorage `iris.link.pairings.v1`，执行宿主立即连上中继。
4. CLI 每 2 秒 `POST /api/link/pair/poll {pollToken}`：202 等待、403 `PAIR_DENIED`、410 `PAIR_EXPIRED`；批准后的第一次轮询签发 `accessToken`（`ilk_a_…`，15 分钟）和 `refreshToken`（`ilk_r_…`，30 天，轮换），之后同一个轮询令牌作废。CLI 写入 `~/.iris/link.json`（目录 0700、文件 0600，原子写入）。

### 设备码（`iris login web --device`，沙箱）

同上，只是 CLI 不开浏览器：打印配对码和 `verificationUrl`。用户在任意已打开 Iris 的浏览器里访问 `/link`，输入配对码，同样核对、勾选、允许。stdout 第一行是机器可读的 `{event:"pairing", data:{code, verificationUrl, …}}`，外部 Agent 可以把它转给用户。

### 刷新与撤销

- `POST /api/link/token/refresh {refreshToken}` → 新的 access + refresh，旧 refresh 立即失效。CLI 在访问令牌剩 60 秒内或 WebSocket 以 4440 关闭时自动刷新。
- `POST /api/link/revoke`（`Authorization: Bearer` access / refresh / tab 令牌）→ 房间清空、所有连接以 4401 关闭。`iris logout` 用 refresh 令牌撤销后删除 `link.json`；页面上「CLI 连接 → 断开」用标签页令牌撤销。
- `GET /api/link/status`（Bearer access）→ `tabOnline`、标签页的项目、已授予范围、refresh 到期时间。

## 令牌

格式 `ilk_<kind>_<roomId>_<secret>`，kind = `a` access / `r` refresh / `t` tab / `p` 配对轮询，secret 是 32 字节随机数（base64url）。roomId 让 Worker 不查表就能路由到房间；房间只存 SHA-256，令牌只在签发它的房间里有效（把 A 的令牌改成 B 的房间号得到 401）。WebSocket 令牌放在子协议里：`Sec-WebSocket-Protocol: iris-link.v1, bearer.<token>`，中继回显 `iris-link.v1`，令牌不进 URL、不进访问日志。

## 权限范围（scope）

| scope | 允许 |
| --- | --- |
| `agent.read` | `link.status`、`agent.sessions`、`agent.trace`、`agent.tools.list`、`agent.tools.invoke`（dry-run） |
| `agent.run` | `agent.send`、`agent.cancel`、`agent.deny`（拒绝只会减少花费） |
| `agent.approve` | 处理**非付费、非破坏性、未受阻、非 exec 级**的工具确认 |
| `tools.invoke` | `agent.tools.invoke --execute` |

默认申请 `agent.read,agent.run`；页面上 `agent.read`、`agent.run` 默认勾选，`agent.approve`、`tools.invoke` 要用户主动勾。中继按授予拦命令（`SCOPE_DENIED`），标签页再取「自己保存的授予 ∩ 中继附带的授予」复核一次。本机 loopback 的可信 CLI 拿到全部四个范围——但付费 / 破坏性确认对任何 CLI 都不开放。

## WebSocket 帧

都是 UTF-8 JSON 文本帧，单帧上限 256 KB（`LINK_MAX_FRAME_BYTES`）。

| 方向 | 帧 |
| --- | --- |
| CLI → 中继 | `{t:'req', id, cmd, args, idem?}`（id ≤ 64 字符） |
| 中继 → 标签页 | `{t:'req', id:'<sid>:<id>', cmd, args, idem?, grant:{scopes, clientName}}` |
| 标签页 → 中继 → CLI | `{t:'res', id, ok, data?, error?}`（中继按 sid 找回发起的 CLI 连接，去掉前缀） |
| 标签页 → 中继 | `{t:'hello', tab:{title, projectId}}`（只给 `link status` 显示） |
| 中继 → 两端 | `{t:'sys', code}`：`TAB_ONLINE`、`TAB_OFFLINE`、`LINKED`、`REPLACED`、`REVOKED` |

中继在转发前检查：帧格式、大小（超限回 `FRAME_TOO_LARGE`）、访问令牌是否过期（回 `TOKEN_EXPIRED` 并以 4440 关闭）、每个 CLI 连接的令牌桶（容量 60、每秒补 20，超出回 `RATE_LIMITED`；`--follow` 遇到限速自动退避续读）、scope、标签页是否在线（不在线立即回 `TAB_OFFLINE`）。标签页断开时中继向所有 CLI 广播 `TAB_OFFLINE`，CLI 把在途请求立即失败。限速状态挂在连接的 attachment 上，房间休眠后也在。

同一个配对同一时刻只有一个执行标签页：新的标签页连上时旧的收到 `REPLACED`（4409）。同一个浏览器里多个 Iris 标签页用 Web Locks（`iris-link:<roomId>`）选出一个；它关掉后锁自动转给下一个。

关闭码：4401 已撤销、4409 被接管、4413 帧过大、4429 限速、4440 访问令牌过期。

## 命令（在标签页里执行）

所有命令返回 `{ok:true, data}` 或 `{ok:false, error:{code, message, retryable?, details?}}`。写命令必须带幂等键（CLI `--idempotency-key`，帧里的 `idem`）：同一个键在标签页里只执行一次，重复调用拿到同一个结果（`agent.send` 返回同一个 runId，`--canvas` 只建一张卡）。

| 命令 | 参数 | 结果 |
| --- | --- | --- |
| `link.status` | — | 协议版本、来源、授予、当前项目、`agent.ready`、模型 `{id, provider}`（没有 Key、没有 baseUrl）、审批模式 |
| `agent.sessions` | — | 当前项目的内置会话（是否在跑）+ link 发起的 run |
| `agent.send` | `prompt`、`sessionId?`、`canvas?` | `{runId, phase, sessionId?, cardNodeId?}` |
| `agent.trace` | `runId`、`afterSeq?`、`waitMs?`（≤ 25 秒长轮询） | `{phase, seq, done, events[], approval?, code?:'APPROVAL_PENDING', reply?}` |
| `agent.approve` / `agent.deny` | `runId`、`approvalId?`（默认当前那一项） | `{decision}`；付费 / 删除 / 受阻 → `APPROVAL_REQUIRES_USER` |
| `agent.cancel` | `runId` | `{cancelled, phase}` |
| `agent.tools.list` | — | 每个工具的 tier、命令、按当前 Tool Policy 的解析（allow / prompt / deny）、硬闸（spend / delete） |
| `agent.tools.invoke` | `tool`、`args`、`execute?` | dry-run：schema 校验 + 策略解析 + 是否付费；`execute`：建一个 run 立即返回 runId，轨迹里看结果（`done.result`） |

### 执行路径（复用，不平行）

- `agent.send` 交给 Agent 面板登记的后台运行时工厂（`IrisAgentPanel` → `registerAgentLinkHost`）：与画布会话卡同一个 `BrowserAgentRuntime.connect({register:false, session})`、同一条文本线路与系统提示、`createBrowserAgentTools` 的 Tool Policy、共用的 Spend Mandate、Session Authority（会话认领，同一会话同一时刻只有一个运行时写入）。非画布回合由 link 自己的 `CanvasSessionRunners` 调度（最多并行 2 个、同会话串行、每个会话一条审批队列），`--canvas` 回合先用 `createAgentSessionCard` 建卡，再交给面板自己的调度器，卡片照常显示轨迹、审批和停止。
- `agent.tools.invoke --execute` 用 `createBrowserAgentTools` 生成的同一个工具执行：同一个 guard（审批模式 + 按工具策略 + 硬闸）、同一个浏览器契约 / 调度器、同一套计划确认；付费确认先看共用的 Spend Mandate。幂等键作为 ChangeSet id 传给调度器。
- Agent 面板没打开时返回 `AGENT_PANEL_CLOSED`（`link status` 里 `agent.ready=false` 并给出提示）。
- 本机 loopback：CLI → 本地 Agent 服务 `/api/tools`（可信本地 CLI：持久令牌、无 Origin）→ SSE `tool_call` → `WorkflowAgentBridge` → 同一个 `handleAgentLinkCommand`。

### 审批

run 进入 `awaitingApproval` 时轨迹里先出现 `approval.pending {approvalId, summary, kind, tier, paid, destructive, blocked, cliApprovable}`，`agent.trace` 的结果带 `code:'APPROVAL_PENDING'`。

- `cliApprovable` 只在 **非付费（不是 generation、没有 spend 硬闸）、非破坏性、未被预算 / 提交前检查挡住、tier 不是 exec** 时为 true；拿不到确认请求时按 false（fail closed）。
- `agent.approve` 需要 `cliApprovable` **且** 授予了 `agent.approve`；否则 `APPROVAL_REQUIRES_USER` / `SCOPE_DENIED`。没有 `--approve` 之类的绕过开关。
- `agent.deny` 只需要 `agent.run`。
- 用户在页面上处理：画布回合在会话卡上批；非画布回合与工具调用在右下角的「CLI 回合等你批准」托盘里批。付费授权（Spend Mandate）在上限内照常自动批准（轨迹里记 `approval.auto`）。
- 结果写回轨迹：`approval.resolved {approvalId, approved, by:'cli'|'page'}`。

### 轨迹事件

全部从画布会话卡同一份归约（`reduceAgentSessionTrace`）逐条 diff 出来，`seq` 单调递增，`afterSeq` 续读不丢不重。只给 provider 真实返回 / 工具真实执行的内容：思考摘要只在模型给了 reasoning 时出现；token 只在 provider 上报时出现。

`phase` · `thinking {summary, active, ms?}` · `tool.start {toolCallId, tool, label, kind:'tool'|'skill'|'memory', target?}` · `tool.end {toolCallId, tool, status, ms?, error?, conflict?}` · `skill {id}` · `memory {count, titles}` · `context {items}` · `budget {tokens?, paidRuns}` · `artifact {nodeId, label, nodeType?}` · `approval.pending` · `approval.auto` · `approval.resolved` · `error {message}` · `text {excerpt}` · `done {phase, sessionId?, cardNodeId?, error?, result?}`

## CLI

```
iris login web [--open | --device] [--url https://iris.avabbbb.com] [--name <label>] [--scopes agent.read,agent.run,agent.approve,tools.invoke]
iris logout
iris link status [--target local|web|auto]
iris agent sessions
iris agent send --prompt "<text>" [--session <id>] [--canvas] [--follow] --idempotency-key <key>
iris agent trace --run <runId> [--follow] [--after-seq <n>]
iris agent approve|deny --run <runId> [--approval-id <id>] --idempotency-key <key>
iris agent cancel --run <runId> --idempotency-key <key>
iris agent tools list
iris agent tools invoke --tool <name> [--args-json '<json>'] [--execute --idempotency-key <key>]
iris agent e2e [--out <dir>] [--only answer,tool,tool-error,approval,parallel,cancel] [--allow-real-model]
```

stdout 每条结果一行 JSON（`--pretty` 缩进），`--follow` 时每个轨迹事件一行 `{ok, command:'agent.trace', runId, event}`，最后一行是命令结果；进度走 stderr。点分写法（`iris agent.send …`）同样可用；不带子命令的 `iris agent` 仍然启动本机 Agent 服务。

`agent e2e` 跑六个脚本化场景（普通回答、调工具、工具失败、审批、两会话并行、取消），写出 `agent-e2e-report[.mock].json` 和 `.md`。标签页用真实模型时默认拒绝（会花钱），要跑加 `--allow-real-model`；模型 id 含 `mock` 时报告标注 **Mock**。

## 本地联调

```
npx wrangler dev --port 8787                                     # 中继（worker/index.ts + DO，本地 workerd）
IRIS_LINK_DEV_RELAY=http://127.0.0.1:8787 npm run dev            # vite 把 /api/link（含 WS）转给中继
node tools/iris/cli.js login web --open --url http://127.0.0.1:37522
```

wrangler dev 时用 `--var LINK_ALLOWED_ORIGINS:http://127.0.0.1:37522 --var LINK_PUBLIC_URL:http://127.0.0.1:37522` 让配对页地址和来源校验指向 vite。端到端（Mock）：`npm run e2e:cli-link -- <outDir>`。

## 部署

- `wrangler.jsonc` 新增 Durable Object 绑定 `IRIS_LINK → IrisLinkRelay` 和迁移 `v1-iris-link`（`new_sqlite_classes`）。首次 `wrangler deploy` 会执行这个迁移；以后新增 / 改名 DO 类要追加新的 tag，不能改已发布的。
- 可选变量：`LINK_ALLOWED_ORIGINS`（额外允许的页面来源，逗号分隔，例如预览域名）、`LINK_PUBLIC_URL`（配对页对外地址，默认取请求 origin）。
- 静态资源层不变：只有 `/api/*` 进 Worker。
