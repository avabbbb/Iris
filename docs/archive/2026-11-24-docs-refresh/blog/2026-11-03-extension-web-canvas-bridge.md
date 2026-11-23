# 浏览器插件 × 网页画布：配对、导入、密钥同步与插件内反推

> 开发日志 · 2026-11-03 · 范围：extension/、services/ 下的浏览器通道相关模块
>
> 写法参考了大淘宝技术关于 Agent 评估的文章，以及 Anthropic 的 Agent 工程博客：先讲约束和失败模式，再讲取舍，最后只用可复现的证据收尾。没做到的事情按“没做到”写。

## 一、背景

Iris 有两种形态：Tauri 桌面端（Desktop）和网页画布。浏览器插件此前是 Desktop-first 的薄伴侣：用户在网页图片或视频上右键，插件通过 Native Messaging 分块传给 Desktop 的收件箱。

这带来两个缺口：

1. 只用网页画布的用户没有任何通道，右键菜单对他们无效。
2. 更早的版本里，网页与插件之间有一条基于 chrome.storage 的 API Key 双向桥（键名 iris_api_keys_v2），密钥以可读形式存在插件存储里，也没有“谁可以读”的概念。

本周目标：把插件和网页画布之间的通道打通，覆盖配对、右键导入到画布、BYOK 密钥同步、插件内反推四件事，并把旧桥拆掉。

## 二、问题

拆开看是四个问题，每个都有一个“做错了会怎样”的失败模式：

| 问题 | 做错的后果 |
| --- | --- |
| 谁能连上插件、由谁批准 | 任意网页（或被 XSS 的页面）绕过用户拿到 Key 或往画布里塞内容 |
| 大媒体怎么进网页画布 | 半截文件、顺序错乱或被篡改的字节落进 Workflow |
| Key 怎么同步到插件 | 明文落盘；撤销配对后 Key 仍留在插件里 |
| 插件内反推怎么做 | 把网关里的请求构造复制一份，两边很快漂移 |

硬约束：

- MV3 Service Worker 会在空闲时被回收，长等待要靠端口流量续命。
- 插件构建（extension/build.mjs）只拷贝文件，不打包，不能直接 import 网页端的 TypeScript。
- Desktop 通道已经在用，不能被这次改动带坏。

## 三、调研对比

### 3.1 网页与插件的通道

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| content script + window.postMessage | 不需要扩展 ID | 要向画布页注入脚本；同页任意脚本都能发消息，origin 校验全靠自己 |
| 经 Desktop Native Host 中转 | 复用现有协议 | 只用网页的用户根本没有 Desktop |
| externally_connectable + 长连接 Port（采用） | origin 白名单由浏览器执行；不注入脚本；Port 长连接适合分块传输 | 网页必须知道扩展 ID；商店 ID 与旁加载 ID 不同 |

### 3.2 配对由谁批准

网页侧批准等于自己批自己：只要白名单 origin 上跑了一段恶意脚本，就能完成配对。所以批准只能发生在插件 popup 这种网页碰不到的界面里，网页只能“申请”。

### 3.3 媒体传输

| 方案 | 结论 |
| --- | --- |
| 一条消息带整个文件 | 大文件超出消息体积与内存预算，失败即重来 |
| 传 Blob URL | 跨上下文不可用 |
| 复用 Desktop 的 begin / chunk / commit（采用） | 一套协议两个接收端，序号与 SHA-256 校验现成；代价是 base64 JSON 有内存放大 |

### 3.4 Key 在插件侧的存放

| 方案 | 结论 |
| --- | --- |
| 明文 chrome.storage（旧做法） | 拒绝 |
| 用口令派生密钥 | 每次反推都要用户输口令，体验不可接受 |
| 不可导出的 AES-GCM 密钥存 IndexedDB，密文存 chrome.storage.local（采用） | 密钥本身读不出来；单拿走存储文件无法解密。它防的是离线拷贝，不防已经在扩展进程内执行的代码 |

### 3.5 反推逻辑如何两端复用

| 方案 | 结论 |
| --- | --- |
| 复制一份到插件 | 指令和请求格式会漂移，拒绝 |
| 给插件引入打包器 | 为一个功能改变构建模型，成本太高 |
| 无依赖 ESM JS 放在 extension/background，网页端经 allowJs 引用（采用） | 一份源码；代价是这份代码没有 TS 类型检查，只能靠测试兑底 |

## 四、决策与取舍

1. 配对只能在 popup 批准。未批准前不收发任何业务消息；拒绝和撤销都会删除条目，用户可以重新申请。取舍：多一步操作，换来信任根不在网页里。
2. 扩展 ID 由网页端环境变量 VITE_IRIS_EXTENSION_IDS 配置，允许同时写商店 ID 和旁加载 ID，格式强制 32 位 a-p。允许的网页 origin 由 web-origins.js 生成并写入 manifest，已核对白名单与 manifest 一致。
3. 网页导入不经过 Desktop 收件箱，直接落到当前 Workflow；没有打开的项目时只保存媒体。Desktop 路径保持原样。
4. Key 只在插件侧加密落盘，按网页 origin 分区；撤销或拒绝即清空该 origin；启动时清理未批准 origin 的残留。画布开启“退出时清除”时不向插件发送 Key（发送空列表）。取舍：加密不能抵抗扩展进程内的攻击，这一点在遗留里如实列出。
5. 同步用“全量快照 + 增量”，每条记录带 revision；revision 对不上就回退全量。每次重新进入 approved 都从全量开始，宁可多传一次也不要状态分叉。
6. 反推抽出纯模块 reverse-prompt-core.js：只含系统指令、三种线格式（Google generateContent、Anthropic messages、OpenAI chat/completions）的请求体与端点、响应解析。不发网络、不读 Key、不记用量。网关保留 Provider 路由、鉴权头和用量记录。流式反推这次不动，控制改动面。
7. 插件内反推不申请新的 host 权限，直接依赖服务商 API 的 CORS；反推结果只放 chrome.storage.session，不落盘。取舍：少一次权限弹窗，但自建代理如果不开 CORS 就用不了。

## 五、实现

### 5.1 协议

Port 名 iris-web，协议版本 1。hello 携带 requestPairing，插件返回配对状态与能力列表（browser.import.image、browser.import.video、keys.sync）。

| 消息 | 方向 | 用途 |
| --- | --- | --- |
| hello | 网页 → 插件 | 探测、申请配对、读取状态 |
| import.begin / import.chunk / import.commit | 插件 → 网页 | 分块传媒体，与 Desktop 共用 media-transfer.js |
| keys.snapshot / keys.delta / keys.clear | 网页 → 插件 | Key 全量、增量、清空；revision 不符时报 keys.revision-mismatch |
| prompt.insert | 插件 → 网页 | 把反推结果写成当前 Workflow 的文本节点 |

### 5.2 限额

| 项 | 值 |
| --- | --- |
| 单个导入媒体 | 64 MiB |
| 网页侧同时进行的导入会话 | 4，超出时淘汰最早的 |
| 单个 origin 的 Key 数 | 200，字段白名单过滤 |
| 反推图片 | 20 MB |
| prompt.insert 文本 | 20000 字符 |

### 5.3 模块

插件侧（extension/background）：

- web-origins.js：生成允许的网页 origin。
- web-bridge.js、web-pairings.js：Port 服务、origin 白名单、配对状态；popup 显示允许、拒绝、断开。
- media-transfer.js：begin / chunk / commit，Desktop 与网页共用；service-worker 按目标分流，右键新增“发送图片 / 视频到网页画布”。
- web-keys.js：按 origin 分区的加密 Key 存储（密文在 chrome.storage.local 的 irisWebKeys，AES-GCM 密钥在 IndexedDB 库 iris-extension），对外提供 allKeys() 给反推使用。
- reverse-prompt-core.js：反推纯模块，网页与插件共用。
- reverse-prompt.js：插件侧选 Key（顺序 Google、OpenAI、Anthropic、OpenRouter，都没有时退到带 Base URL 与默认模型的 OpenAI 兼容 Key）、拼鉴权头、发请求。Anthropic 直连需要 anthropic-dangerous-direct-browser-access 头。
- service-worker.js：右键“反推图片提示词”复用导入的读取逻辑（临时权限、格式校验、尺寸），结果写入 session 存储；popup 可复制或发送到画布。

网页侧：

- services/extensionBridge.ts：探测、配对、连接状态、请求与 onRequest 订阅。
- components/settings/ExtensionPairingSection.tsx：设置页安全标签里的配对入口，中英文案在 utils/translations.ts。
- services/webBrowserImportReceiver.ts：校验 MIME、大小、序号与 SHA-256，写入 workflowMediaStorage（键 browser-import:导入 ID），再通过已有的 Workflow mutation 建节点。
- services/webPromptInsertReceiver.ts：接收 prompt.insert，在视口左上方建文本节点（内容在 metadata.content）。
- services/extensionKeySync.ts 与 hooks/useApiKeys.ts：取代旧的 chrome.storage 双向桥。
- components/extension/BrowserImportBridge.tsx：网页端注册两个接收器。这里一度怀疑它只在 Desktop 挂载；核实后发现组件在 App 中始终挂载，只是网页端不渲染界面，所以 effect 在网页端会执行。
- services/aiGateway.ts：非流式反推改为调用 reverse-prompt-core.js。

清理：删除旧的 chrome.storage Key 桥（插件侧已确认无引用），删除已无引用的 utils/keyCodec.ts 与其测试；重写 extension/README.md，去掉“不保存 Provider Secret、不直连 Provider”这类已不成立的表述；popup 提示和中英文扩展描述同步更新。已安装扩展里的旧键 iris_api_keys_v2 由 storage-migration.js 的 purgeLegacyExtensionStorage 在启动时删除（已核实在清理列表中）。

## 六、验证

自动化（本机，2026-11-03）：

| 检查 | 结果 |
| --- | --- |
| 导入链路相关测试 | 6 个文件、24 个用例通过 |
| 含 Key 同步在内的测试 | 11 个文件、44 个用例通过 |
| 反推抽取后的网关回归（含纯模块测试） | 3 个文件、99 个用例通过 |
| 反推链路（纯模块、插件反推、prompt.insert、网页导入接收） | 4 个文件、17 个用例通过 |
| 全量 vitest | 246 个文件首轮 244 通过、2 失败，处理见下 |
| tsc --noEmit | 通过 |
| node --check（service-worker.js、popup.js、两个反推模块） | 通过 |
| npm run ext:build | 通过，产物在 dist-extension |
| npm run docs:check | 通过 |

全量测试的两个失败：

- tests/extensionSecurityBoundary.test.ts：它写死了“薄插件”时代的边界（不允许 externally_connectable、断点续传代码在 service-worker.js 里）。这是本次有意改变的边界，所以按新设计改写而不是删除：externally_connectable 只允许三个画布 origin、不允许其他扩展连接；service worker 与 popup 仍不出现厂商名和 Key；reverse-prompt.js 不读写存储；reverse-prompt-core.js 不发网络、不碰 chrome API；续传检查指向 media-transfer.js。改写后通过。
- tests/cliPackageManifest.test.js：工作区里另一项尚未入库的 CLI 凭据改动新增了 tools/iris/provider-vault.js，但未加入 CLI 发布清单。与本次通道工作无关，未处理，留给那项工作收尾。

新增测试文件：tests/webBrowserImportReceiver.test.ts、tests/extensionWebKeys.test.js、tests/extensionKeySync.test.ts、tests/reversePromptCore.test.js、tests/extensionReversePrompt.test.js、tests/webPromptInsertReceiver.test.ts。

没有做的验证：

- 没有在真实 Chrome / Edge 里跑端到端（加载 dist-extension、配对、右键导入、反推、发送到画布）。以上结论都来自单元测试和静态检查。
- 没有用真实 Key 调过任何服务商，CORS 行为是按各家公开说明设计的，未实测。
- 测试输出里的 getComputedStyle 等 Not implemented 提示来自 jsdom，与本次改动无关。

## 七、遗留

按优先级：

1. 端到端验证缺失。下一步先在 Edge 里走一遍完整流程，尤其是 MV3 Service Worker 被回收后 Port 重连与配对状态恢复。
2. 反推模型选择偏粗。同步到插件的 Key 只有 id、provider、key、baseUrl、defaultModel、capabilities，没有 models 列表；插件用 defaultModel，缺省时用固定默认模型。如果用户的 defaultModel 是不支持图像输入的模型，请求会失败。网关里的 mapProviderModel 映射也没有带到插件。
3. 依赖 CORS。自建或第三方 OpenAI 兼容代理如果不开 CORS，插件内反推会失败；必要时改为在右键手势内按服务商 origin 申请可选权限。Google 的 Base URL 在插件里写死为 v1beta，网关侧由 getGeminiRestBaseUrl 决定，两边可能不一致。
4. 加密的边界。不可导出密钥防的是存储文件被拷走，不防扩展进程内执行的代码，也不防已配对 origin 上的恶意脚本通过正常协议写入 Key。
5. 大文件内存。媒体以 base64 JSON 分块传输，体积约放大三分之一；网页侧在 commit 前把所有分块留在内存，64 MiB 媒体加上拷贝会有数倍峰值占用。反推同理，所以单独收紧到 20 MB。
6. 网页导入的媒体写入 workflowMediaStorage 后没有清理策略，节点删除后媒体仍在。
7. 小项：流式反推仍在网关内部自己构造请求；hello 的能力列表里没有声明 prompt.insert；反推完成时复用了导入的 imported 状态显示；aiGateway 里对纯模块的 import 放在了使用处旁边而不是文件顶部（ESM 会提升，功能无差别，但不符合常规写法）。
