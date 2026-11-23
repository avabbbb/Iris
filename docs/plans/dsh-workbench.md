# Iris × DeepSeek Harness（DSH）工作台计划

状态：进行中（2026-11-15 更新；初稿 2026-11-06）。目标：Iris UI 不变，作为 DSH Desktop 工作台出现；DSH 主对话 Agent 通过工具操作 Iris 画布。

## 1. 现状

- 主仓库 `dsh-plugin/`（@flovart/dsh-plugin 0.1.0）已恢复并在用：peer 范围 `@deepseek-ai/dsh-* >=0.2.2-rc.1 <0.3.0-0`（已验证 0.2.2-rc.1 / rc.2）；同源 iframe 嵌入可见画布（`/iris-app/?embed=dsh`），一次性 bootstrap token 经 postMessage 交给画布，持久 token 只在 Host；随包注册 canonical Skill；DSH Desktop `dsh-app://` 来源的 bootstrap 已固定。350b1c8 的“整体删除”已被之后的提交取代。
- 链接健壮性（2026-11-15，见 [archive · 2026-11-15-dsh-connection-ui.md](../archive/2026-11-24-docs-refresh/quality/2026-11-15-dsh-connection-ui.md)）：链接错误按未运行 / 不可达 / 超时 / CORS / 凭证失效 / 版本不匹配分类并给下一步；嵌入页凭证失效时自动向宿主重新申请 token；DSH 头部显示画布回传的真实链接状态；Agent 抽屉「连接指引 / 连接状态 / 运行日志」重做为容器自适应布局。
- 本地开发与 CI 一样需要先 `npm --prefix dsh-plugin ci`，否则根 tsc 与 `tests/dshService.test.ts` 缺 `@deepseek-ai/*`。
- 仍未通过的门槛：真实登录态下重载后仍能操作画布、升级回滚；独立仓库、npm 发布与工作台市场（§3.1、§4）未开始。

## 2. 参考：dsh-media-desk（woniuniuniu，v2.6.1，MIT）

- 单包双半：main = src/host.js（Node 半，挂 /media-desk/* 本机接口、文件服务、模型调用），exports ./client = dist/client.js（esbuild 打的单文件）。
- cordis.patch.yml 只有一行 insert：id media-desk，name dsh-media-desk。
- dsh.client.inject 只列 @deepseek-ai/dsh-client-runtime；engines.dsh 为 >=0.2.1-rc.5 <0.3.0。
- 数据在 ~/.dsh/media-desk/，卸载不删。对话改稿用「模型出 JSON ops → applyOps → 可撤销」，模型不可用时走本地规则 intents.js。
- 对 Iris 的启发：画布变更统一走 workflow.apply 的 ops，带回执与撤销；安装即用、示例数据首屏、不带密钥、模型走用户自己账号。

## 3. 方案

### 3.1 包

- 新建独立仓库（市场 v1 只收仓库根目录一个工作台，不收 monorepo 子目录），建议 avabbbb/iris-dsh，npm 包名 iris-dsh。主仓库只保留契约与测试。
- package.json：version 完整 SemVer；type module；main/exports . = Host 半；exports ./client = 已构建单文件；dsh.bundle.patch = ./cordis.patch.yml；dsh.client.platform = web；dsh.client.inject 必须含 dsh-desktop-workbenches；@deepseek-ai/* 只放 peerDependencies，范围显式包含预发布（如 >=0.2.1-rc.5 <0.3.0-0）；repository 指回投稿仓库。
- Config 用 @deepseek-ai/schemastery。打包 ≤ 8 MiB，不含 .env / token / 本机绝对路径。

### 3.2 界面（UI 不变）

- Client 半调用 ctx.desktopWorkbenches.register({ title: 'Iris 画布', customFrame: true, headerLayout: 'compact' }, Panel)，由 ctx.effect 管理注销；不填 id。
- Panel 内是 Iris 本体：优先 iframe 加载本机 Iris（Tauri 桌面端自带的 loopback 服务或 Vite 构建产物由 Host 半同源提供）。外层只放一行 data-dsh-workbench-toolbar（标题 + 「问 AI」按钮），点击后才展开宿主传入的 conversation 节点，不自建聊天 UI。
- 风险：若 iframe 直接加载 iris.avabbbb.com，Chromium 存储分区会让 iframe 内 IndexedDB 与用户直接打开的站点不是同一份。因此画布数据应以 Host 半同源提供的版本为准，并提供导入/导出项目。
- 无会话时画布照常可用；只有「问 AI」才创建/恢复工作台会话。需要写文件时先调宿主目录选择器。

### 3.3 Agent 操作画布

- Host 半注入 tools，注册五个稳定工具（沿用旧 tools.ts 的契约）。工具只在当前会话属于本工作台时生效（desktopWorkbenchOwnership.read()）。
- 执行链路两档：
  - A（先做，已有证据）：Host 半 → 本机鉴权 loopback Workspace Operator → 可见的 Iris Workflow（workspaceMode 固定 browser，无可见画布时返回 WORKSPACE_REQUIRED，不造隐藏副本）。
  - B（后续）：Host 半 → Client 半（remote / RPC）→ postMessage 到 iframe → services/workflowDispatcher，省掉独立进程。
- 安全：source 记为 agent；delete / node.run / 含 delete_nodes 的 workflow.apply 必须在 Iris 画布内人工确认（即 P1-3）；token 只在 Host；代理只放行 health 与工具路由。
- 每次 apply 返回回执（改了哪些节点），画布侧可撤销。

### 3.4 验收（对照工作台开发规范第 8 节）

1. pnpm pack + tar -tzf 核对入口与 cordis.patch.yml；从 tgz 安装。
2. dsh --profile web --dump-config 能找到本包；工作台市场「已安装」有带「本地」标识的条目；左侧切换到 Iris 后画布可用。
3. DSH 对话「加一个图片节点并连到视频节点」→ 画布变更；「删掉这个节点」→ 画布弹确认。
4. 重启 Harness 后仍能操作；侧栏展开/收起、窄窗口、全屏无遮挡。

## 4. 上架与创作者合作

### 4.1 两个官方市场

| 项 | 插件市场 | 工作台市场 |
| --- | --- | --- |
| 收录仓库 | awesome-dsh-plugin | dataelement/awesome-dsh-workbench |
| 新增文件 | data/plugins/ownerrepo.yml | data/workbenches/ownerrepo.yml |
| 简介 | en 必填，zh 可选 | zh、en 都必填，各一行，属实 |
| 截图 | 仓库内 screenshots.json，1–8 张 | YAML 内 1–5 张，作者仓库 raw 地址，PNG/JPEG/WebP ≤ 2 MiB，16:9 宽 ≥ 1280 |

Iris 建议走工作台市场（完整画布是工作台形态），安装来源用 npm（repository 指回仓库）。

工作台 YAML 最小字段：url、name、category（data/categories.json 之一）、description.zh / en、screenshots。版本、包名、校验值不填。PR 描述写：用途、本机验收结果、Desktop 版本与平台、安装来源、外部依赖/网络访问/数据位置。状态口径：已提交 → 已合并 → 市场可见。

规范原文：dshdesktop.com/workbench/docs/development 与 dshdesktop.com/workbench/docs/market-acceptance（开工前须在线重新获取最新版）。

### 4.2 DeepSeek 作者支持计划

- 官方文章文末「阅读原文」是意向报名表，目前只做前期意向收集，规则（Token 激励、技术交流、作品推荐）待公布。报名链接需从公众号原文打开。
- 报名前准备：公开仓库 + 许可证；一句话定位（AI 视频/图像创作画布，DSH 对话直接排流程、跑生成）；中英简介；3–5 张实拍截图 + 30 秒演示视频；已验证的 Desktop 版本/平台；安装方式（npm 包名）；线上站 iris.avabbbb.com；联系方式；是否有付费/模型费用说明（模型走用户自己账号）。
- 先报意向，不必等市场上架；上架后再补链接。

## 5. 排期

1. 0.3.0 内测版先发（画布/Agent 稳定性是 DSH 接入的前提）。
2. M1：取回旧 tools / workspaceProxy，升级到 DSH 0.2.x，工作台壳 + iframe，链路 A。本机安装验收。
3. M2：独立仓库 + npm 发布 + 截图，提交工作台市场 PR；同时填作者意向表。
4. M3：链路 B（去掉独立进程）。
