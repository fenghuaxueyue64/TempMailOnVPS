# TempMail — 自托管临时邮箱

Bun + Hono + SQLite + 内置 SMTP + SvelteKit 5 + Material 3

**一台 VPS + 一个域名**，跑起「收信 + Web UI + 实时推送」的自托管临时邮箱服务。

> 预构建镜像：`ghcr.io/fenghuaxueyue64/tempmail:latest`（GitHub Actions 自动构建，push main 即更新）

## 特性

- 内置 SMTP 服务器直接收信（`*@你的域名`），无需外部中转
- **邀请码登录**：用户用邀请码换 JWT，每用户上限 10 个邮箱，支持手动续期
- **OTP 验证码自动提取** + **Magic Link 识别**，一键复制/打开
- HTML 邮件渲染（sandboxed iframe），纯文本/HTML 切换
- WebSocket / SSE 双通道实时推送
- SQLite（WAL 模式）本地存储，附件落盘 + 过期清理
- deSEC.io API 自动配置 A/MX/SPF，手动同步/校验
- Telegram Bot 新邮件通知（可选）
- Docker Compose 一键部署（预构建镜像拉取即用）
- 安全三红线：密钥不泄露、鉴权全服务端、CSRF 防护

## 快速部署（Docker）

> 完整部署文档见 [`docs/DOCKER-DEPLOY.md`](docs/DOCKER-DEPLOY.md)，含 DNS/SSL/nginx/故障排查等。

```bash
# ① 准备目录 + 下载配置
mkdir -p /opt/tempmail/nginx/{conf.d,certbot-www} && cd /opt/tempmail
curl -sLO https://raw.githubusercontent.com/fenghuaxueyue64/TempMailOnVPS/main/docker-compose.yml
curl -sLo nginx/conf.d/tempmail.conf https://raw.githubusercontent.com/fenghuaxueyue64/TempMailOnVPS/main/nginx/conf.d/tempmail.conf
curl -sLo .env.example https://raw.githubusercontent.com/fenghuaxueyue64/TempMailOnVPS/main/.env.example
sed -i 's/tmp\.io/你的域名/g' nginx/conf.d/tempmail.conf
cp .env.example .env

# ② 编辑 .env（至少改这四项）
#    ALLOWED_DOMAINS=你的域名
#    JWT_SECRET=$(openssl rand -hex 64)
#    ADMIN_API_KEY=$(openssl rand -hex 32)
#    ADMIN_PATH=$(openssl rand -hex 5)   ← 管理入口随机路径，别用 admin

# ③ 配置 DNS 解析（在域名注册商/DNS 托管商处添加）
#    类型    名称       值
#    A      mail      你的VPS公网IP
#    MX     @         10 mail.你的域名.
#    TXT    @         "v=spf1 ip4:你的VPS公网IP ~all"
#
#    验证：dig +short MX 你的域名  →  10 mail.你的域名.
#    Cloudflare 用户：必须关掉橙色云朵（仅 DNS），否则会吃掉 25 端口 SMTP 流量
#
#    可选（推荐）：deSEC.io 托管域名可全自动配置，.env 中设 DESEC_TOKEN + DESEC_AUTO_MX=true

# ④ 签 HTTPS 证书（80 端口需空闲）
docker run --rm -p 80:80 \
  -v /etc/letsencrypt:/etc/letsencrypt \
  certbot/certbot certonly --standalone \
  -d 你的域名 -d mail.你的域名 --agree-tos -m you@example.com

# ⑤ 启动
docker compose up -d
```

> ⚠️ ghcr.io 镜像默认私有，需到 GitHub → Packages → tempmail → Package settings → **设为 Public**，否则 `docker compose pull` 需登录。

## 本地开发

```bash
cp .env.example .env
# 编辑 .env：至少填 ALLOWED_DOMAINS / JWT_SECRET / ADMIN_API_KEY

bun install
bun run dev          # 后端 :3000（热重载）

# 前端开发（另开终端）
cd web && bun install && bun run dev   # Vite :5173，自动 proxy /api /ws /sse
```

生产构建：`cd web && bun install && bun run build`，后端检测到 `web/build/` 存在后自动托管静态产物 + SPA fallback。

## 环境变量

完整说明见 [`.env.example`](.env.example)。必填：

| 变量 | 说明 |
|------|------|
| `ALLOWED_DOMAINS` | 逗号分隔的收信域名（如 `example.com`） |
| `JWT_SECRET` | ≥ 32 字符，`openssl rand -hex 64` |
| `ADMIN_API_KEY` | ≥ 16 字符，管理员登录换 JWT 的密钥 |

可选：`DESEC_TOKEN` / `DESEC_AUTO_MX` / `VPS_IP`（deSEC 自动配 DNS）、`TG_ENABLED` / `TG_BOT_TOKEN` / `TG_DEFAULT_CHAT_ID`（Telegram 通知）、`INVITATION_TTL_HOURS` / `INVITATION_MAX_PER_CREATE`（邀请码管理）。

## Web UI（SvelteKit 5 + Material 3）

| 路径 | 说明 |
|------|------|
| `/login` | 用户登录页（输入邀请码换 JWT） |
| `/` | **用户端**：邮箱列表 → 收件箱 → 邮件详情 / OTP 提取 / Magic Link / 附件下载 |
| `/<ADMIN_PATH>` | **管理端**：域名管理 / 邀请码 CRUD / 过期清理 / deSEC DNS 查看-同步-校验 |

> 管理入口路径由 `.env` 的 `ADMIN_PATH` 决定（4-32 位，字母开头，仅字母+数字），**每个部署各不相同**；旧的 `/admin` 固定返回 404，避免被字典扫描爆破。忘记路径：`docker compose logs app | grep ADMIN_PATH`。

设计：Material 3（紫主色 #6750A4、elevation 阴影、ripple 涟漪、Roboto 字体、Material Symbols Rounded、按钮 5 变体）。双栏布局（md=768 断点），移动端单栏 + dvh 适配。

## API 概览

### 公开（限速）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/auth/exchange` | `{code}` 邀请码换 JWT |
| POST | `/api/admin/login` | `{api_key}` 管理员换 JWT |

### 用户（`Authorization: Bearer <JWT>`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/me` | 当前用户信息 + 邮箱列表 |
| POST | `/api/mailboxes` | 创建邮箱（上限 10 个/用户） |
| POST | `/api/mailboxes/:id/renew` | 续期（重置 expires_at） |
| DELETE | `/api/mailboxes/:id` | 删邮箱（级联删邮件+附件） |
| GET | `/api/mailboxes/:id/messages` | 邮件列表 |
| GET | `/api/messages/:id` | 邮件详情（正文 + 附件） |
| DELETE | `/api/messages/:id` | 删单封 |
| GET | `/api/attachments/:id` | 下载附件 |

### 实时推送

| 协议 | 路径 | 说明 |
|------|------|------|
| WebSocket | `/ws?token=<JWT>` | 用户级订阅，新邮件实时推送 |
| SSE | `/sse?token=<JWT>` | 同上，HTTP 留备 |

### Admin（`Authorization: Bearer <admin JWT>`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/DELETE | `/api/admin/domains[/:domain]` | 域名增删查 + deSEC DNS 查看/同步/校验 |
| POST | `/api/admin/invitations` | 批量生成邀请码（数量/有效期/备注） |
| GET | `/api/admin/invitations` | 列出邀请码（支持状态过滤：unused/used/expired） |
| DELETE | `/api/admin/invitations/:code` | 撤销未使用邀请码 |
| POST | `/api/admin/cleanup` | 手动清理过期邮箱 |

## 安全设计

1. **密钥不泄露**：邮箱 token、ADMIN_API_KEY、deSEC token 仅服务端持有；接口响应不含 token 字段，用户标识只回脱敏 `user_id_masked`
2. **鉴权全服务端**：前端只持有 JWT，邮箱操作只传 id，服务端从 JWT 解析用户后查库校验归属
3. **CSRF 防护**：所有写操作（POST/DELETE/PATCH）必须带 `X-DM-Req: 1` 自定义头 + 同源 Origin 校验
4. 附件路径守卫 + 文件名字符集白名单 `[A-Za-z0-9._-]`，防路径穿越
5. SMTP 只对白名单域名收信，其余 `550 relaying denied`
6. HTML 邮件在 `sandbox=""` iframe 内渲染，附件强制 `Content-Disposition: attachment`

## 部署详情

完整 VPS 部署（前置检查 / DNS / SSL / nginx / 备份 / 故障排查）见 [`docs/DOCKER-DEPLOY.md`](docs/DOCKER-DEPLOY.md)。

升级：

```bash
# 预构建镜像模式
docker compose pull && docker compose up -d

# 源码构建模式
git pull && docker compose up -d --build
```

备份（SQLite WAL 必须用 `.backup`，不能直接 `cp`）：

```bash
./scripts/backup.sh            # 手动
0 2 * * * /opt/tempmail/scripts/backup.sh   # crontab 定时
```

## 项目结构

```
tempmail-bun/
├── src/
│   ├── main.ts              # 入口：SMTP + HTTP + 定时清理
│   ├── config.ts            # 环境变量 + JWT_EXPIRES_IN 解析
│   ├── events.ts            # 事件总线（邮件 → WS/SSE/TG）
│   ├── db/
│   │   ├── schema.sql       # DDL（mailboxes/emails/attachments/invitations）
│   │   └── client.ts        # bun:sqlite 封装
│   ├── smtp/server.ts       # SMTP 入站（smtp-server）
│   ├── mail/store.ts        # 邮件解析入库 + 附件落盘 + 文件名白名单
│   ├── api/
│   │   ├── env.ts           # Hono 共享类型（userId / adminId）
│   │   ├── auth.ts          # requireUser / requireAdmin 中间件 + CSRF
│   │   ├── routes.ts        # REST API + 邀请码 + 附件下载 + UI 托管
│   │   └── ws.ts            # WebSocket/SSE（per-user JWT 订阅）
│   ├── desec/client.ts      # deSEC API（A/MX/SPF + 查询/校验）
│   └── notify/telegram.ts   # Telegram Bot 通知
├── web/                     # SvelteKit 5 前端
│   ├── src/
│   │   ├── routes/          # +page.svelte / login/ / admin/
│   │   ├── lib/             # api.ts / stores.ts / components/
│   │   └── app.css          # Tailwind + M3 设计令牌
│   └── static/
├── nginx/conf.d/            # nginx 反代配置（WS/SSE/API/Web）
├── scripts/backup.sh        # SQLite 安全备份
├── .github/workflows/       # CI：push main → 构建 ghcr.io 镜像
├── Dockerfile               # 三阶段：deps → web-builder → runtime
├── docker-compose.yml       # app + nginx 双容器
└── .env.example
```
