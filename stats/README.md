# Flovart 项目数据

本目录用于长期保存公开仓库的增长数据，不采集 Flovart 应用内行为、Prompt、素材或 API Key。

## 当前可统计的数据

| 指标 | 来源 | 含义与限制 |
| --- | --- | --- |
| README 展示次数 | `tally.yuki.sh` rule34 主题计数器 | 图片被加载的次数，受缓存和爬虫影响，不等于独立访客。 |
| Stars / Forks / Watchers | GitHub Repository API | 每日累计快照；Watchers 指主动订阅仓库通知的人数。 |
| Release 下载量 | GitHub Releases API | Release 附件的累计下载次数，并保留附件维度明细；不是安装成功数，也不能去重。 |
| 仓库 Views / Unique visitors | GitHub Traffic API | GitHub 只提供最近 14 天，因此由 Action 每天合并到历史文件。 |
| Clones / Unique cloners | GitHub Traffic API | 统计完整克隆，不包含普通 `git fetch`；同样只有最近 14 天窗口。 |

每日工作流位于 [`.github/workflows/traffic-snapshot.yml`](../.github/workflows/traffic-snapshot.yml)。快照写在独立的 [`stats` 分支](https://github.com/avabbbb/Iris/blob/stats/stats/history.json)（main 受保护，Actions 不能直推）；本目录里的 `history.json` 是迁移前的旧副本，不再更新。其中：

- `views` / `clones`：按 UTC 日期保存 `count` 与 `uniques`；
- `snapshots`：按日保存 Stars、Forks、Watchers、Release 数量和累计附件下载；
- `releaseAssets`：当前各 Release 附件下载量排行；
- `updatedAt`：最后一次成功采集时间。

## 启用完整仓库流量统计

Stars、Forks、Watchers 和 Release 下载不需要额外 Secret。Views 与 Clones 需要：

1. 创建 Fine-grained personal access token，只选择 `avabbbb/Iris`；
2. Repository permissions 仅开启 `Administration: Read-only`；
3. 在仓库 `Settings → Secrets and variables → Actions` 新建 `TRAFFIC_PAT`；
4. 手动运行一次 `Traffic Snapshot`，确认 Action Summary 中没有 Traffic 权限警告。

若默认分支禁止 GitHub Actions 直接写入，需要允许此工作流写入，或改为由 Action 提交专用数据 PR。

## 暂不统计的“真实使用数据”

桌面活跃安装数、会话数、Workflow/Skill 使用率都需要应用主动上报。Flovart 是本地优先产品，因此当前不默认加入遥测，也不能用 Release 下载量冒充活跃用户。

如后续确实需要，应单独设计可关闭、明确同意、公开事件 Schema 的匿名遥测，只发送版本、平台和粗粒度功能事件；不得发送 Prompt、素材、项目内容、Provider 请求、API Key、文件路径或可反查个人的数据。CLI 包发布到 npm 后，可另接 npm Downloads API 统计包下载量。
