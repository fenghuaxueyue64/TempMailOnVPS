# tempmail (Bun)

自托管临时邮箱后端 — **Bun + Hono + SQLite + 内置 SMTP**，按《TempMail VPS 技术文档》实现。

- 内置 SMTP 服务器直接收信（`*@你的域名`），无需外部中转
- REST API + **WebSocket / SSE** 双通道实时推送
- SQLite（WAL 模式）本地存储，查询零外部网络请求
- deSEC.io API 封装，添加域名时自动配置 A/MX/SPF
- 多域名管理（Admin JWT）
- Docker Compose 一键部署

## 快速开始

```bash
cp .env.example .env
# 编辑 .env：至少填 ALLOWED_DOMAINS / JWT_SECRET / ADMIN_API_KEY

bun install
bun run dev          # 开发（热重载）
# 或
bun run src/main.ts
```

期望日志：

```
starting tempmail for domains [tmp.io] on :3000
smtp server listening on :25 (hostname=mail.tmp.io, accepts mail for @tmp.io)
http api listening on :3000
```

## 环境变量

完整说明见 `.env.example`。必填：

| 变量 | 说明 |
|------|------|
| `ALLOWED_DOMAINS` | 逗号分隔的收信域名（如 `tmp.io,mailtemp.net`） |
| `JWT_SECRET` | ≥ 32 字符，`openssl rand -hex 64` |
| `ADMIN_API_KEY` | ≥ 16 字符，admin 登录换 JWT 的密钥 |

## Web UI（SvelteKit 5 + Material 3）

**生产模式**：`web/` 下 SvelteKit 项目 `bun run build` 输出到 `web/build/`，Bun 后端同端口托管（serveStatic + SPA fallback）。

**开发模式**：后端 `bun run dev`（:3000），前端 `cd web && bun run dev`（vite :5173，自动 proxy `/api` `/ws` `/sse` 到后端）。

```bash
# 首次构建前端
cd web && bun install && bun run build && cd ..

# 启动（后端自动检测 web/build 存在则托管）
bun run dev
```

| 路径 | 说明 |
|------|------|
| `/` | **用户端**（SvelteKit 路由）：创建邮箱 / 收件箱 / 邮件详情 / WebSocket 实时推送 / OTP 验证码自动提取一键复制 / 删除 |
| `/admin` | **管理端**（SvelteKit 路由）：API Key 登换取 JWT / 域名增删 / 查看 deSEC DNS 记录 / 手动同步 MX / 校验 MX 生效 / 手动清理 |

设计：Material 3 设计令牌（紫主色 #6750A4、elevation 阴影分级、ripple 涟漪、Roboto 字体、Material Symbols Rounded 图标、按钮分层 filled/tonal/outlined/text/danger、chip 标签、卡片圆角）。localStorage 持久化邮箱 token 与 admin JWT，WS 断线 10s 轮询兜底，Toast 通知。

### 公开（限速）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/mailboxes` | 创建临时邮箱，返回 `{address, token, expires_at}` |
| POST | `/api/admin/login` | `{api_key}` 换 JWT |

### 邮箱访问（`?token=` 或 `X-Mailbox-Token` 头）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/mailboxes/:address` | 邮箱详情 + 最近 100 封邮件 |
| DELETE | `/api/mailboxes/:address` | 删邮箱及全部邮件（级联） |
| GET | `/api/mailboxes/:address/messages` | 邮件列表 |
| GET | `/api/messages/:id` | 邮件详情（含正文 + 附件列表） |
| DELETE | `/api/messages/:id` | 删单封 |
| GET | `/api/attachments/:id` | 下载附件 |

### 实时推送

| 协议 | 路径 | 说明 |
|------|------|------|
| WebSocket | `/ws?token=xxx` | 升级后推送 `{type:"hello"}`，新邮件 `{type:"mail",...}` |
| SSE | `/sse?token=xxx` | `event: mail` 推送，每 25s 心跳 `event: ping` |

### Admin（`Authorization: Bearer <JWT>`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/domains` | 列出所有域名 |
| POST | `/api/admin/domains` | `{domain}` 添加（`DESEC_AUTO_MX=true` 时自动配 MX） |
| DELETE | `/api/admin/domains/:domain` | 停用域名 |
| GET | `/api/admin/domains/:domain/dns` | 查询该域名在 deSEC 上的全部 DNS 记录 |
| POST | `/api/admin/domains/:domain/sync` | 手动重新同步 A/MX/SPF（即使 `DESEC_AUTO_MX=false` 也可触发） |
| GET | `/api/admin/domains/:domain/verify` | 校验 MX 是否已生效（deSEC NS 直查，绕过全球传播） |
| POST | `/api/admin/cleanup` | 手动触发过期邮箱清理 |

### Telegram 通知（可选）

`TG_ENABLED=true` + `TG_BOT_TOKEN` + `TG_DEFAULT_CHAT_ID` 后，每封新邮件到达时会向默认 chat 推送 HTML 格式通知（收件地址/发件人/主题/时间）。仅打日志失败、不影响邮件主流程。

### 最小流程（等验证码）

```bash
BASE=http://127.0.0.1:3000

# 1) 创建邮箱
MB=$(curl -s -X POST "$BASE/api/mailboxes" \
  -H "Content-Type: application/json" -d '{}' )
ADDR=$(echo "$MB" | jq -r .address)
TOKEN=$(echo "$MB" | jq -r .token)

# 2a) 轮询
curl -s "$BASE/api/mailboxes/$ADDR/messages?token=$TOKEN"

# 2b) 或 WebSocket 实时
# 浏览器: new WebSocket(`ws://host/ws?token=${TOKEN}`)
```

## 部署

完整 VPS 部署（DNS / SSL / Nginx / 备份）见上级目录《TempMail VPS 技术文档.md》§1–§14。

```bash
docker compose build --no-cache
docker compose up -d
docker compose logs -f
```

### 备份

SQLite WAL 模式下**不能直接 `cp`**（可能包含不完整事务），必须用 `.backup` 命令。项目提供 `scripts/backup.sh`：

```bash
# 手动备份
./scripts/backup.sh

# 定时备份（crontab，每天凌晨 2 点，保留 7 天）
0 2 * * * /opt/tempmail/scripts/backup.sh >> /var/log/tempmail-backup.log 2>&1
```

脚本自动检测容器是否运行：运行中通过 `docker exec` 调用容器内 `sqlite3`，否则用宿主机 `sqlite3`。可通过 `DB_PATH` / `BACKUP_DIR` / `KEEP_DAYS` / `CONTAINER_NAME` 环境变量覆盖默认值。

## 故障排查

### 收不到邮件

```bash
# 1. 确认 MX 记录已传播
dig MX yourdomain @8.8.8.8

# 2. 确认 SMTP 端口可达（从外部服务器执行）
telnet VPS_IP 25
# 连接拒绝 → VPS 提供商封锁了 25 端口
# Connection timed out → 防火墙未开放，检查 ufw

# 3. 查看 SMTP 服务日志
docker compose logs app | grep -i smtp

# 4. 确认域名在白名单且活跃
curl -H "Authorization: Bearer $JWT" http://localhost:3000/api/admin/domains
```

### SSL 证书申请失败

```bash
# 常见原因：80 端口被占用，或 DNS 未传播到 certbot 服务器
curl -I http://yourdomain          # 检查 80 端口
dig A yourdomain @8.8.8.8          # 确认 A 记录指向 VPS IP

# 重新申请（standalone 模式，需先停 Nginx）
docker compose stop nginx
certbot certonly --standalone -d yourdomain -d mail.yourdomain
docker compose start nginx
```

### SQLite database is locked

WAL 模式下只允许一个写入进程。确保只有一个 app 容器实例运行（不要横向扩容）：

```bash
docker compose ps    # 应只看到一个 tempmail-app 容器

# 损坏时检查
docker exec tempmail-app sqlite3 /app/data/db/tempmail.db "PRAGMA integrity_check;"
# 输出 "ok" 正常，否则从备份恢复
```

### WebSocket 连接被断开

```bash
# 检查 Nginx 的 WebSocket 配置
docker compose logs nginx | grep -i "upgrade"

# 确认 proxy_read_timeout 足够大（至少 3600s）
# 前端已实现断线重连 + 10s 轮询兜底
```

### Nginx 502 Bad Gateway

```bash
# 通常是 app 容器未启动或健康检查未通过
docker compose ps
docker compose logs app --tail=50

# 排查 .env 配置问题
docker compose config    # 输出合并后的完整配置
```

## 项目结构

```
tempmail-bun/
├── src/
│   ├── main.ts            # 入口：SMTP + HTTP 同进程 + 定时清理
│   ├── config.ts          # 环境变量
│   ├── events.ts          # 事件总线（邮件 → WS/SSE）
│   ├── db/
│   │   ├── schema.sql     # SQLite DDL（WAL + 外键级联）
│   │   └── client.ts      # bun:sqlite 封装
│   ├── smtp/server.ts     # SMTP 入站（smtp-server）
│   ├── mail/store.ts      # 邮件解析入库（mailparser）+ 附件落盘
│   ├── api/
│   │   ├── env.ts         # Hono 共享类型
│   │   ├── auth.ts        # 邮箱 token + Admin JWT 中间件
│   │   ├── routes.ts      # REST API + 限速 + UI 托管
│   │   └── ws.ts          # WebSocket + SSE
│   ├── desec/client.ts    # deSEC.io API（A/MX/SPF + 查询/校验）
│   ├── notify/telegram.ts # Telegram Bot 通知
│   └── web/               # SvelteKit 5 前端（用户端 + admin）
│       ├── src/
│       │   ├── routes/    # +page.svelte（用户端）/ admin/+page.svelte（管理端）
│       │   ├── lib/       # api.ts / stores.ts / components/（M3 组件）
│       │   └── app.css    # Tailwind + M3 设计令牌
│       └── static/        # favicon
├── nginx/conf.d/tempmail.conf
├── scripts/backup.sh        # SQLite 安全备份（WAL 模式 .backup）
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## 设计要点

- **先创建邮箱才能收信**：SMTP 仅向 `mailboxes` 表中已存在且未过期的地址投递，防止向任意地址刷库（与文档 schema 的 token/expires_at 设计一致）
- **WS 推送零额外查询**：`mailboxId → 连接集合` 映射，新邮件到达时 O(1) 定位订阅者
- **外键级联**：`mailboxes → emails → attachments`，删除邮箱自动清理所有相关数据
- **附件路径白名单**：正则校验防路径穿越
- **速率限制**：内存滑动窗口，邮箱创建与登录按客户端 IP 限速
- **JWT_EXPIRES_IN 解析**：支持 `7d`/`1h`/`30m`/`3600` 等格式，Admin token 过期时间由配置驱动
- **deSEC 完整管理**：不只是创建，还可查询全部 rrsets / 手动重新同步 / 校验 MX 生效状态
- **前端 SvelteKit 5**：组件化（Icon/Button/Card/MailboxCard/MessageList/MessageDetail/AdminLogin/DomainManager/DnsModal/Toasts），adapter-static 输出纯静态，后端同端口托管，dev/prod 双模式
- **Material 3 设计系统**：Tailwind + M3 CSS 变量，elevation 阴影分级、ripple 涟漪、Roboto 字体、Material Symbols Rounded 图标、按钮 5 变体
- **Telegram 通知容错**：发送失败仅打日志，不阻塞邮件主流程
