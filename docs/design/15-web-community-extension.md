# 模块：Web, Community & Extension

> 状态：**Current truth**。总纲见[总体设计](00-overview.md)。

## 1. 职责

网站后端（账号、组织、社区作品）、浏览器导入扩展、安装与发行。它们不参与个人生成任务的中转。

## 2. 网站后端

- 网页版全静态：原 Go Hub（`backend/`，账号 / 提示词包 / R2 上传）已删除，回滚点 git tag `go-backend-final`。
- 线上只有无状态 Cloudflare Worker（`worker/index.ts`），仅 `/api/llm-proxy/*`；确需服务端的新能力用 TS 在 Worker 内无状态实现，不为本机生成增加云端服务。
- 存储形态见 [数据存储](../content/docs/backend/backend-database.mdx)。不用未来字段冒充已建表。

## 3. 社区

- Community Gallery 只展示创作者**明确发布**的最终图片或视频；不使用长期假数据；不把 Workflow 图当首页主体。
- 发布前作品保持本地私有；发布时显式选择媒体、公开元数据与许可。
- 可选 Remix Bundle：不可变 Skill 版本 + 参考 Workflow 快照（节点、连线、提示词、模型、参数、明确公开的参考素材），不含 Provider Secret 与路由。
- 个人项目与素材不宣传已云同步。

## 4. 浏览器导入扩展

- 定位：Desktop 版的薄伴侣，不是第二套 WebUI、Provider 客户端或项目数据库。
- 首个切片：网页右键单图 → Desktop 配对 → 分块传输 → 内容寻址 Artifact Store → 活动 Workflow 的 `image` 节点或 Import Inbox → 成功回执。
- Native Messaging Host 只接受官方扩展 ID；首次连接需在 Desktop 确认可撤销的配对授权。
- 传输：版本化控制信封 + 有界分块 + 稳定请求 ID + 内容哈希；来源 URL / 标题 / 时间只作 provenance。
- 回程能力白名单（如 `prompt.reverse`）由 Desktop Runtime 用本机 Key 执行；预览不修改项目。
- 网页画布通道的 BYOK Key 双向同步（扩展 1.7 起）：画布 Vault ⇄ 扩展按 origin 加密分区，revision + 加密 outbox，按 Key id 以 updatedAt 后写者胜；「退出时清除」开启时双向停止。扩展设置页（options_ui）镜像画布「设置 → AI 服务」的字段，只看掩码。细则见 `extension/README.md`。
- 代码：`extension/`；Runtime 侧 `src-tauri/src/runtime/browser_import.rs`。

## 5. 安装与发行

- 插件是日常入口，复杂编排展开 Iris；安装器按实际宿主安装组件并复用一个本地服务。普通用户不需手装 Node / Go / Git。
- 发行物：Desktop（Tauri）、`dist-studio/*` 宿主包、`dist-workbuddy/iris`、MCP server。各自状态见 Support Matrix。
- 只有用户明确要求才走发版流程（CHANGELOG → VERSION → tag）；不自行推商店或生产签名。

## 6. 验证

后端单测与迁移；扩展：实际商店 ID、Native Host 注册、安装卸载、分块续传；Docker 静态资源、升级恢复、Hosted CI / CodeQL 按真实发行范围。
