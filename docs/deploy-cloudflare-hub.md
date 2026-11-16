# Flovart Hub 部署到 Cloudflare（Pages Functions + D1 + R2）

Hub（账号、提示词包、上传）已从 Go 后端 `backend/` 改写为 TypeScript，跑在 Cloudflare Pages Functions 上：

- 代码：`server/hub/`（逻辑）、`functions/api/v1/[[path]].ts`、`functions/api/healthz.ts`（入口）
- 数据库：D1，表结构在 `migrations/`（`wrangler d1 migrations` 格式）
- 存储：R2；浏览器拿预签名 URL 直传 R2，Function 只做签名和确认
- 前端默认请求同源 `/api/v1`，可用构建变量 `VITE_HUB_BASE_URL` 覆盖

全部在免费额度内：静态资源请求不计费；Functions 每天 10 万次、每次 10ms CPU（密码哈希按这个预算取了 PBKDF2 迭代数，见 `server/hub/crypto.ts`）；D1 每天读 500 万行、写 10 万行；R2 10GB 存储、出流量免费。

## 1. 创建 D1 数据库

```bash
npx wrangler d1 create flovart-hub
```

把输出里的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`（现在是全 0 占位符）。

## 2. 跑迁移

```bash
npx wrangler d1 migrations apply flovart-hub --remote   # 线上
npx wrangler d1 migrations apply flovart-hub --local    # 本地 wrangler pages dev 用
```

以后改表结构：新增 `migrations/000N_xxx.sql`，不要改已经应用过的文件；同步更新 `docs/content/docs/backend/backend-database.mdx`。

## 3. 创建 R2 桶（只用上传功能时需要）

```bash
npx wrangler r2 bucket create flovart-hub-uploads
```

- 公开访问：在 R2 控制台给桶开 r2.dev 子域或绑定自定义域名，把地址填进 `wrangler.jsonc` 的 `vars.R2_PUBLIC_BASE`。
- 预签名需要 S3 API 凭据：R2 控制台 →「管理 R2 API 令牌」→ 新建令牌，权限「对象读和写」，限定到这个桶。记下 Access Key ID、Secret Access Key 和账户 ID。
- `vars.R2_ACCOUNT_ID` 填账户 ID，`vars.R2_BUCKET` 填桶名。
- 桶的 CORS（浏览器直传必需），R2 控制台 → 桶 → 设置 → CORS 策略：

```json
[
  {
    "AllowedOrigins": ["https://你的站点域名"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

没配齐 R2 时，上传接口返回 `503 存储未配置`，其他接口不受影响。

## 4. 设置 secret

```bash
openssl rand -base64 48 | npx wrangler pages secret put JWT_SECRET --project-name flovart
npx wrangler pages secret put R2_ACCESS_KEY_ID --project-name flovart
npx wrangler pages secret put R2_SECRET_ACCESS_KEY --project-name flovart
```

`JWT_SECRET` 必须是长随机串（≥ 32 字节）。更换它会让所有已发的登录 token 失效。

## 5. 部署与检查

```bash
npm run deploy:cf            # vite build && wrangler pages deploy dist
curl https://你的站点域名/api/healthz      # {"ok":true}
```

本地联调：`npx vite build && npx wrangler pages dev dist`（默认 8788 端口，会读 `.dev.vars` 里的 secret），前端开发服务器用 `VITE_HUB_BASE_URL=http://127.0.0.1:8788/api/v1 npm run dev`，并把 `CORS_ALLOW` 设为 `loopback`。

## 可选配置（`wrangler.jsonc` 的 `vars`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CORS_ALLOW` | `*` | 与 Go 版相同：`*` / `loopback` / `off` / 逗号分隔的来源白名单。同源访问不需要 CORS；桌面版（Tauri）跨域访问需要 `*` 或 `loopback` |
| `JWT_EXP_HOURS` | `168` | 登录有效期（小时） |

## 和 Go 版的差异

- 路径前缀不变（`/api/v1/...`）；健康检查在 `/api/healthz` 和 `/api/v1/healthz`（Go 是根路径 `/healthz`）。
- 密码哈希从 bcrypt 换成 PBKDF2-SHA256（线上没有存量用户，不做 bcrypt 兼容）。
- R2 未配置时上传接口返回 503 `存储未配置`，Go 版是不注册路由（404）。
- 关键词搜索用 SQLite `LIKE`，只对 ASCII 字母忽略大小写（Postgres `ILIKE` 对所有字母忽略大小写）；中文不受影响。
- 旧部署文件仍保留：`backend/`（Go 后端）和 `docker-compose.yml`（Postgres + Go Hub + 前端）在确认线上切换完成后可以删；根目录 `Dockerfile`（Vite 开发服务器容器）和 `render.yaml`（Render 静态站）部署的是前端，不是 Go 后端，只在不再用 Render / Docker 时才删。
