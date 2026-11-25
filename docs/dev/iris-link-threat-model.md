# Iris Link 威胁模型

范围：`iris login web` 配对、`/api/link/*` 中继（Cloudflare Worker + Durable Object）、线上 Iris 标签页里的执行宿主，以及本机 loopback 上同一套 link 命令。协议见 `docs/dev/iris-link-protocol.md`。

## 要保护的东西

| 资产 | 在哪 | 目标 |
| --- | --- | --- |
| 模型 / 服务 Key（BYOK） | 只在用户浏览器（keyVault） | 永远不离开浏览器：不进中继、不进 CLI、不进任何 link 返回值 |
| 用户的钱 | 付费生成、付费工具 | 只有用户本人在页面上能批准；CLI 不能代批 |
| 画布内容 | 浏览器 IndexedDB | 中继不存；只回给发起命令的那一个 CLI |
| 画布完整性 | 浏览器 | 写操作走现有 Tool Policy / 审批 / Session Authority，带幂等键 |
| 配对凭证 | CLI `~/.iris/link.json`、标签页 localStorage | 短期、可撤销、与房间绑定 |

## 信任边界

1. **CLI 机器 ↔ 中继**：公网 HTTPS / WSS。CLI 可能运行在不受信的沙箱里（这正是设计目标）。
2. **中继 ↔ 标签页**：同上；标签页是唯一执行者。
3. **页面里的其它脚本**：与 Iris 同源的脚本能读 localStorage（XSS 时标签页令牌和 Key 一样暴露），见残余风险。
4. **本机 loopback**：沿用本地 Agent 服务的既有边界（持久令牌 + 无 Origin 才是可信本地 CLI）。

## 威胁与对策

### 中继被攻破或运营方作恶

- 中继只看帧头（`t / id / cmd`）做 scope 与大小检查，不解析 `args`，不持久化任何帧；房间存储只有配对元数据（CLI 名字、掩码后的 IP、国家 / 城市、申请与授予的范围、时间）和令牌的 SHA-256。
- Key 从不经过中继：模型请求由标签页直接发往服务商（或经现有 `/api/llm-proxy`，与 Link 无关）；`link.status` 只回模型 id 与 provider，不回 Key、不回 baseUrl。
- 残余：中继能看到经过它的命令参数和结果（例如 `agent.trace` 里的回复摘录、`agent.tools.invoke` 的结果）。这些数据只在内存里转发；不想让中继看到时用本机 loopback（`--target local`）。

### 钓鱼配对（攻击者把带自己配对码的链接发给受害者）

- 确认页显示 CLI 名字、客户端标识、来源 IP（前两段）与国家 / 城市、申请时间、申请的每一项权限；「终端里显示的配对码就是 XXXX-XXXX」必须勾选才能允许——受害者的终端里根本没有这个码。
- 默认只授予 `agent.read` / `agent.run`；`agent.approve`、`tools.invoke` 要主动勾选。即使误批，攻击者也**不能花用户的钱**：付费 / 删除确认只能由用户在页面上批准。
- 配对码 10 分钟过期、一次性；发起配对按 IP 限速（每分钟 10 次）。设备码流程由用户手动输入码，天然防这种钓鱼。
- 已连接的 CLI 常驻在右下角「CLI 连接」列表，可随时断开（服务端撤销）。

### 跨站请求 / 恶意网页

- 页面接口（`pair/info`、`pair/decide`、标签页 WebSocket、标签页令牌的 `revoke` / `status`）要求允许列表里的 Origin（`iris.avabbbb.com`、请求自身 origin、`LINK_ALLOWED_ORIGINS`）；同源 GET 不带 Origin 时只认浏览器声明的 `Sec-Fetch-Site: same-origin`。恶意网页不能替用户批准配对，也不能用标签页令牌连中继。
- CLI 接口（`pair/start`、`pair/poll`、`token/refresh`、CLI WebSocket）拒绝带陌生 Origin 的请求：网页偷到 CLI 令牌也不能在浏览器里用。
- 所有响应 `cache-control: no-store`；配对确认是带 JSON body 的 POST。

### 令牌泄露

- 访问令牌 15 分钟；refresh 30 天、每次刷新轮换（旧的立即失效）；轮询令牌只能换一次令牌。
- 令牌与房间绑定（格式里带 roomId，房间只认自己签发的哈希）；比较用定时安全比较。
- WebSocket 令牌放在子协议头里，不进 URL、不进代理 / 访问日志。
- `~/.iris/link.json` 0600、目录 0700、原子写入；`link status` / `login` 输出只显示令牌前缀。
- 撤销：`iris logout`（refresh 令牌，访问令牌过期也能撤）或页面「断开」（标签页令牌）。撤销清空房间、所有连接以 4401 关闭，标签页删除本地记录。

### CLI 越权（沙箱里的 Agent 试图做超出授权的事）

- scope 在中继拦一次、标签页按「自己保存的授予 ∩ 中继附带的授予」再拦一次。
- 付费 / 破坏性：`cliApprovable` 只在非付费、非破坏性、未受阻、非 exec 级时为 true，拿不到确认请求按 false；`agent.approve` 对其它情况一律 `APPROVAL_REQUIRES_USER`。没有任何「--approve / --yes」绕过。本机 loopback 的可信 CLI 同样受这条限制。
- 回合由面板的后台运行时执行，沿用用户在面板里设定的审批模式与按工具策略（deny 绝对；allow 不能越过硬闸）；Spend Mandate（用户自己给的付费上限）照常生效；Session Authority 保证同一会话不会被两个运行时同时写。
- `agent.tools.invoke` 默认只做 dry-run（schema + 策略解析）；`--execute` 需要 `tools.invoke` 并走同一个 guard 与确认。
- 写命令必须带幂等键，重试不重复发起回合或落写；标签页按键去重（`agent.send` 同一个键 = 同一个 run、`--canvas` 只建一张卡）。

### 拒绝服务 / 资源滥用

- 每个 CLI 连接令牌桶（60 / 每秒 20）、每个房间最多 4 个 CLI 连接、单帧 256 KB、配对按 IP 限速；空闲房间休眠，心跳由运行时自动回复不唤醒房间。
- 未批准的房间 10 分钟后由 alarm 清空；refresh 过期的房间同样清空。
- 标签页侧：link 发起的非画布回合最多并行 2 个；run 记录最多 64 条、每个 run 最多 4000 个事件。

### 标签页丢失 / 被替换

- 标签页关闭：中继立即向 CLI 广播 `TAB_OFFLINE`，在途请求立即失败（不干等超时）；写操作用同一个幂等键重试。
- 同一配对的第二个执行标签页（另一台设备）接管时旧的收到 `REPLACED` 并停止重连；同一浏览器内多个标签页用 Web Locks 只保留一个执行者。
- Agent 面板关闭 / 换线路：link 自己调度的回合标为 `interrupted`，CLI 在轨迹里看到原因。

## 残余风险与假设

- **XSS**：与 Iris 同源的恶意脚本能读 localStorage 里的标签页令牌（与 BYOK Key 的暴露面相同）。缓解：令牌只能连中继执行已授予范围内的命令，付费仍需人点；页面可随时断开。
- **中继可见明文命令与结果**：见上。敏感项目用本机 loopback。
- **页面主动授予 `agent.approve`**：CLI 可以批准非付费的写画布确认（例如写备注、改节点）。这些都是可撤销的 ChangeSet，但仍是对画布的修改；只在信任这个 CLI 时勾选。
- **IP / 地理位置展示**：来自 Cloudflare 请求元数据，可被代理 / VPN 改变，只作辅助判断，主要依据是配对码核对。
- **Durable Object 内存状态**：限速桶挂在连接 attachment 上，配对发起限速存在存储里；房间被驱逐后的连接会重新建立（CLI 自动重连由下一次命令触发）。
