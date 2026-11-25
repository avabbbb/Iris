# Iris Browser Import（本地开发）

这个扩展是 Iris 的薄伴侣，有两条通道：

- Desktop 通道：把用户右键选择的图片或视频（PNG / JPEG / WebP / GIF / AVIF、MP4 / WebM）以分块 Native Messaging 传给 Iris Desktop。
- 网页画布通道：网页画布经 externally_connectable 与扩展建立 Port（名称 iris-web，协议版本 1）。配对只能在扩展 popup 里批准；批准后支持右键发送媒体到当前 Workflow、BYOK Key 同步和插件内反推。

扩展只处理用户明确选择的媒体，不扫描整页，不内嵌完整 WebUI。导入有分块进度反馈，popup 保留最近 5 条导入历史与失败引导。

popup（1.6 起）视觉按 docs/design/DESIGN.md：`--isl-*` token、奶蛙 logo、「连接」卡合并网页画布配对与 Desktop；所有可见文案在 `_locales/{zh_CN,en}/messages.json`，新增文案先加 key 再在 HTML 用 `data-i18n` 引用。

## 网页画布通道

允许连接的网页 origin 由 background/web-origins.js 生成并写入 manifest：正式站 iris.avabbbb.com（更名过渡期另放行旧站 flovart.avabbbb.com），以及本地 127.0.0.1:37522 与 localhost:37522。网页侧用环境变量 VITE_IRIS_EXTENSION_IDS 配置扩展 ID（32 位 a-p，逗号分隔，可同时写商店 ID 与旁加载 ID）。

1. 配对：在画布「设置 → 安全」的浏览器插件区申请配对，再在扩展 popup 的「网页画布」区点击允许。未批准前不收发任何业务消息；拒绝或断开会删除配对条目，网页可以重新申请。
2. 发送媒体：右键「发送图片到网页画布」或「发送视频到网页画布」。单个媒体上限 64 MiB，分块传输并校验大小与 SHA-256，落到画布当前 Workflow；画布没有打开的项目时只保存媒体。
3. Key 同步（1.7 起双向）：配对批准后，画布 Vault 中的 Key 同步到扩展（首次全量，之后增量，revision 不一致时回退全量）。扩展用不可导出的 AES-GCM 密钥加密后写入 chrome.storage.local，按网页 origin 分区；撤销或拒绝配对即清空该 origin 的 Key。
   - 反方向：在插件设置页（右键扩展图标 →「选项」，或 popup 顶栏的齿轮）新增 / 编辑 / 删除的 Key 先写本地、revision +1，变更进该 origin 的加密 outbox；该画布在线就经 iris-web Port 发 `keys.ext.changes`，不在线就排队，下次画布连上（发来 snapshot / delta）后自动回写。画布确认后 outbox 才清掉。
   - 冲突规则（两端同一套，见 background/web-keys.js 与 services/extensionKeySync.ts）：按 Key id 后写者胜，比较 updatedAt（同一台机器的毫秒时钟）。编辑 / 新增只有 updatedAt 严格更新才覆盖对方；删除带墓碑时间，墓碑时间 ≥ 对方 updatedAt 才删；插件里“编辑”一个画布已删除的 Key 会被丢弃（删除胜，画布不保存删除时间），插件里“新增”的 Key 照常加入。画布合并后把插件的 revision 记为下限并改发全量，两端回到同一份列表。注意画布自动刷新模型列表也会更新 updatedAt。
   - 画布校验插件发来的每一条：字段白名单与插件 sanitizeKeyEntry 相同（id provider key name baseUrl defaultModel capabilities updatedAt，测试对拍），Provider 必须是画布认识的类型，能力只收 text / image / video / agent，Base URL 只收 http(s)；白名单外的画布字段（模型列表、路由映射、脚本配置等）保留原值。
   - 画布开启「退出时清除」时发 `syncDisabled`：插件清空该 origin 的 Key 与排队编辑、设置页禁止编辑，画布也拒绝回写，两个方向都不同步。
   - 设置页与画布「设置 → AI 服务」同一组字段与 Provider 列表（options/provider-presets.js，与 SettingsPanel / aiGateway 对拍）；按已配对画布分组显示已同步的 Provider。Key 只显示后 4 位（太短的一位不露）：设置页只经 runtime 消息向 service worker 要掩码视图，编辑时 Key 留空即沿用原值，明文不回到页面、不写日志。popup 的连接卡只显示每个画布的同步数量与待回写数。
4. 插件内反推：右键「反推图片提示词」。按 Google、OpenAI、Anthropic、OpenRouter 的顺序选用已同步的 Key，都没有时退到带 Base URL 与默认模型的 OpenAI 兼容 Key。请求从扩展直接发往模型服务商（不申请额外 host 权限，依赖服务商 CORS），图片上限 20 MB。结果只保存在 chrome.storage.session（浏览器关闭即清空），可在 popup 复制，或「发送到网页画布」写进生成节点的 Prompt Bar：消息带 targetNodeId 时写入该图片/视频生成节点（保留原有 @引用），否则在当前 Workflow 新建一个 image 生成节点（只建不跑）。反推指令、请求体与响应解析和网页端共用 background/reverse-prompt-core.js。

5. 网关直连（1.4 起，能力 llm.fetch）：OpenCode（opencode.ai /zen/、/inference/）与 RunningHub 文档等浏览器无法跨域访问的请求，在画布已配对时经插件直接发往上游，不再经过 Cloudflare Worker /api/llm-proxy（不占 Workers 配额）。每个请求一条 Port（iris-fetch），流式回传、可取消；上游 host/path 白名单在 background/upstream-allowlist.js，与 server/llmProxy.ts 逐项一致（测试对拍），manifest 的 host_permissions 只含这几个主机。插件不可用、未配对或在首字节前失败时，网页自动回退到 /api/llm-proxy。设置页「浏览器插件」区显示当前是「直连（扩展）」还是「代理」。

6. 「点个 Star」：第一次成功导入或反推之后，popup 出现一张可关闭的小卡片邀请去 GitHub（https://github.com/avabbbb/Iris）点 Star；点过或关闭即永久不再出现（chrome.storage.local `irisStarDismissed`）。网页画布在本次会话里刚完成插件配对时，同一位置出现一次性的 Star 邀请（localStorage `iris.starPrompt.dismissed`）。

## Desktop 通道本地安装

1. 构建 Desktop Native Host 与扩展：

        cargo build --manifest-path src-tauri/Cargo.toml --bin iris-host
        npm run ext:build

2. 打开 edge://extensions，启用开发人员模式，选择“加载解压缩的扩展”，目录选 dist-extension，然后复制扩展 ID。

3. 使用该 ID 注册 Native Host（只写当前用户注册表）：

        powershell -ExecutionPolicy Bypass -File extension/register-native-host.ps1 -ExtensionId <EDGE_EXTENSION_ID> -Browser Edge

4. 启动 Iris Desktop，重新加载扩展。在任意网页图片上右键选择“添加图片到 Iris”；首次连接需要在 Desktop 明确批准。视频导入需要 Desktop 侧的 browser.import.video 能力。

## 升级与发布

从旧版扩展升级到 1.3 时，扩展会删除旧 chrome.storage.local 中的 Provider 凭证、Base64 待导入图、反推结果和整页采集数据；Desktop Keyring 与 Workflow 数据不受影响。

发布到 Edge Add-ons / Chrome Web Store 后，商店 ID 可能与本地旁加载 ID 不同。正式安装器必须把真实商店 ID 写进 Native Host 的 allowed_origins，网页端也要把它加入 VITE_IRIS_EXTENSION_IDS；不能用占位 ID 或通配符。
