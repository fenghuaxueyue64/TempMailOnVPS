# TempMail（Bun 版）Docker 部署指导

> 适用：`tempmail-bun/`（Bun + Hono + SQLite + 内置 SMTP，SvelteKit 前端）。
> 目标：一台 VPS + 一个域名，跑起「收信 + Web UI + 实时推送」的自托管临时邮箱。
> 全程只需要服务器上有 **Docker + Docker Compose**，不需要装 Bun/Node/Nginx(宿主机)。

---

## 0. 部署前检查清单（别跳过，80% 的坑在这里）

| 项 | 要求 | 如何确认 |
|---|---|---|
| 公网 IP | 固定 IPv4 | `curl -4 ifconfig.me` |
| **入站 25 端口** | 必须开放（收信唯一入口） | 下面 §6 有测试方法 |
| 80 / 443 | 开放（Web + 证书） | `ufw allow 80,443/tcp` |
| 域名 | 1 个即可（建议再加一个备用） | 你的域名 |
| DNS 托管 | 推荐 deSEC.io（可全自动配 MX）或 Cloudflare（手动） | — |
| 服务器 | 1C1G 起步，10G 磁盘 | 附件按 `ATT_MAX_SIZE` 累计 |

**重点：25 端口。** 绝大多数云厂商默认**封禁出站 25**（防垃圾邮件），但**入站 25 一般是开的**；AWS/阿里云/腾讯云/Oracle 的部分机型会连入站也拦。买机器前先确认，或先提工单解封。测试方法见 §6.1。

> 本服务**只收不发**，因此：
> - 不需要 DKIM（那是发信签名）
> - 建议配 SPF（deSEC 自动配）+ 可选 DMARC
> - PTR / rDNS（反向解析）建议设置，能显著提升投递成功率（在 VPS 面板里把 IP 反向解析到 `mail.<你的域名>`）

---

## 1. 准备部署目录

两种方式，选一种即可：

### 方式 A：拉取预构建镜像（推荐，最快）

只需要 `docker-compose.yml` + nginx 配置 + `.env`，不需要源码：

```bash
mkdir -p /opt/tempmail && cd /opt/tempmail

# 下载必要文件
curl -sLO https://raw.githubusercontent.com/fenghuaxueyue64/TempMailOnVPS/main/docker-compose.yml
mkdir -p nginx/conf.d
curl -sLo nginx/conf.d/tempmail.conf https://raw.githubusercontent.com/fenghuaxueyue64/TempMailOnVPS/main/nginx/conf.d/tempmail.conf
curl -sLo .env.example https://raw.githubusercontent.com/fenghuaxueyue64/TempMailOnVPS/main/.env.example
```

### 方式 B：克隆完整仓库（需要自行构建镜像）

```bash
git clone https://github.com/fenghuaxueyue64/TempMailOnVPS /opt/tempmail && cd /opt/tempmail
# 编辑 docker-compose.yml：注释掉 image 行，取消注释 build 段
```

---

## 2. 配置 .env

```bash
cd /opt/tempmail
cp .env.example .env

# 生成两个密钥（必须！否则启动直接报错退出）
openssl rand -hex 64   # → JWT_SECRET（≥32 字符）
openssl rand -hex 32   # → ADMIN_API_KEY（≥16 字符）
```

编辑 `.env`，**最小必改项**：

```dotenv
ALLOWED_DOMAINS=tmp.io            # ← 换成你的域名（多个用逗号分隔）
JWT_SECRET=<上面生成的 128 位 hex>
ADMIN_API_KEY=<上面生成的 64 位 hex>
SMTP_NAME=mail.tmp.io             # ← SMTP banner 主机名，建议 mail.<域名>

# deSEC 自动配 DNS（推荐，见 §3 方案 A）
DESEC_TOKEN=<desec.io 的 API token>
DESEC_AUTO_MX=true
VPS_IP=<你的 VPS 公网 IP>
```

其余保持默认即可：`HTTP_PORT=3000`（**只对内网暴露，不要映射到公网**）、`SMTP_PORT=25`、`DEFAULT_TTL_HOURS=24`、`ATT_MAX_SIZE=10485760`。

> ⚠️ `.env` 已在 `.gitignore` / `.dockerignore` 中，不会进镜像也不会进仓库；compose 通过 `env_file` 注入。

---

## 3. DNS 解析（二选一）

设主域名为 `tmp.io`，VPS IP 为 `1.2.3.4`。你需要两条记录：**`mail.tmp.io` 的 A 记录**（MX 指向它）+ **`tmp.io` 的 MX 记录**。

### 方案 A：域名托管到 deSEC（推荐，全自动）

1. 注册 [deSEC.io](https://desec.io/)，添加域名 `tmp.io`
2. 在域名注册商处把 **NS** 改为 deSEC 的四个 NS（`ns1.desec.io` `ns2.desec.org` `ns1.desec.org` `ns2.desec.io`，以控制台显示为准）
3. 创建 API Token，填入 `.env` 的 `DESEC_TOKEN`
4. 本服务会在**添加域名时**自动调用 deSEC API 写入：

| 类型 | 名称 | 值 |
|---|---|---|
| A | `mail` | `1.2.3.4` |
| MX | `@` | `10 mail.tmp.io.` |
| TXT | `@` | `"v=spf1 ip4:1.2.3.4 ~all"` |

启动后可在 `/admin` 管理端「同步 MX」「校验 MX」手动触发与验证。

### 方案 B：手动添加（Cloudflare / 其他 DNS）

| 类型 | 名称 | 值 | TTL |
|---|---|---|---|
| A | `mail` | `1.2.3.4` | 300 |
| MX | `@` | `10 mail.tmp.io.` | 300 |
| TXT | `@` | `"v=spf1 ip4:1.2.3.4 ~all"` | 300 |
| TXT（可选） | `_dmarc` | `"v=DMARC1; p=none; rua=mailto:you@tmp.io"` | 300 |

**Cloudflare 注意**：
- apex 域名（`tmp.io`）不能 CNAME，只能 A / ALIAS；MX 直接填在 apex 上没问题
- **必须关掉橙色云朵（仅限 DNS，不走 CF 代理）**——代理只支持 HTTP 端口，会**吃掉 25 端口的 SMTP 流量**
- 关闭 CF 的 "Email Routing" 对该域名的接管，否则会抢走 MX

验证（在任意机器上）：

```bash
dig +short MX tmp.io        # 期望：10 mail.tmp.io.
dig +short A  mail.tmp.io   # 期望：1.2.3.4
dig +short TXT tmp.io       # 期望：v=spf1 ip4:1.2.3.4 ~all
```

---

## 4. 申请 HTTPS 证书（Let's Encrypt）

证书在**宿主机** `/etc/letsencrypt`，compose 只读挂载给 nginx 容器。

```bash
mkdir -p /opt/tempmail/nginx/certbot-www

# 首次签发：standalone 模式，会占用 80 端口（此时 nginx 还没启动，正好）
docker run --rm -p 80:80 \
  -v /etc/letsencrypt:/etc/letsencrypt \
  certbot/certbot certonly --standalone \
  -d tmp.io -d mail.tmp.io \
  --agree-tos -m you@example.com
```

改 nginx 配置里的域名（**5 处**）：

```bash
cd /opt/tempmail
sed -i 's/tmp\.io/你的域名/g' nginx/conf.d/tempmail.conf
```

**自动续期**（加进 `crontab -e`）：

```bash
0 3 * * * docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /opt/tempmail/nginx/certbot-www:/var/www/certbot certbot/certbot renew --webroot -w /var/www/certbot --quiet && docker exec tempmail-nginx nginx -s reload
```

（webroot 目录已由 compose 挂进 nginx 容器，`/.well-known/acme-challenge/` 由 80 端口 server 块直接服务，续期不需要停站。）

---

## 5. 启动

> **首次部署前**：GitHub Actions 推送到 ghcr.io 的镜像默认是私有的。你需要到 GitHub 仓库 → Packages → tempmail → Package settings → Change visibility → **Public**，否则 `docker compose pull` 需要登录 ghcr.io。

```bash
cd /opt/tempmail

# 方式 A（推荐）：拉取预构建镜像
docker compose up -d           # 首次自动拉取 ghcr.io/fenghuaxueyue64/tempmail:latest

# 方式 B：本地构建（需要源码 + docker-compose.yml 中启用 build 段）
# docker compose up -d --build  # 首次会构建前端（bun install + vite build），约 2-5 分钟

docker compose ps                # 两个容器都应是 healthy/running
docker compose logs -f app       # 看启动日志
```

期望日志：

```
starting tempmail for domains [tmp.io] on :3000
smtp server listening on :25 (hostname=mail.tmp.io, accepts mail for @tmp.io)
http api listening on :3000
```

打开 `https://<你的域名>` → **跳转到 /login 输入邀请码** → 拿到 JWT 后跳回主页 → 在 `/admin` 后台「邀请码」标签页生成邀请码分发出去 → 用户用邀请码登录后创建邮箱 → 从 Gmail / QQ 邮箱发一封邮件过去，页面应在 1 秒内推送出来。

---

## 6. 验证清单

### 6.1 25 端口与 SMTP 握手（最关键）

```bash
# 从任意外部机器测试（不要用部署机器本机测，会走 loopback 掩盖问题）
nc -vz <VPS_IP> 25                       # 期望 succeeded

# 完整对话测试
swaks --server mail.tmp.io --port 25 \
      --from test@gmail.com \
      --to <你在网页上创建的地址> \
      --header "Subject: hello" --body "test body"
# 期望末尾："250 message stored"
```

没有 `swaks` 就手动：

```bash
nc <VPS_IP> 25
EHLO test.com            # 期望 250- 多行
MAIL FROM:<a@b.com>      # 250
RCPT TO:<你的临时地址>    # 250（非白名单域名会 550 relaying denied，这是正确行为）
DATA                     # 354
Subject: hi
                         # 空行
hello                    # 正文
.                        # 单独一行句点结束
QUIT
```

### 6.2 服务健康

```bash
curl -s https://<你的域名>/api/health
# {"status":"ok","smtp":"listening","db":"connected"}
```

### 6.3 WebSocket 实时推送

浏览器 DevTools → Network → WS，选中 `/ws?token=...` → 发一封邮件，应立刻收到 `{"type":"mail",...}`。
页面右上角应显示绿色「实时」chip；若显示「轮询」说明 WS 没连上（检查 nginx 的 `location /ws`，**不能带尾斜杠**）。

### 6.4 防火墙

```bash
ufw allow 25/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw reload
```

---

## 7. 运维

| 操作 | 命令 |
|---|---|
| 看日志 | `docker compose logs -f app` |
| 重启 | `docker compose restart` |
| 停站 | `docker compose down`（数据保留在 `./data`） |
| 升级 | `docker compose pull && docker compose up -d` 或 `git pull && docker compose up -d --build` |
| 生成邀请码 | `/admin` 后台「邀请码」标签页 → 设数量/有效期/备注 → 生成 → 复制分发给用户 |
| 撤销邀请码 | `/admin` 邀请码列表 → 未使用状态的码有撤销按钮 |
| 手动清理过期邮箱 | `/admin` 域名标签页「清理过期邮箱」按钮（每小时自动清理一次，附件文件一并删除） |

**备份**（SQLite WAL 模式必须用 `.backup`，直接 cp 会拿到不一致快照）：

```bash
chmod +x scripts/backup.sh
./scripts/backup.sh                    # 手动
# 定时（crontab）
0 2 * * * /opt/tempmail/scripts/backup.sh >> /var/log/tempmail-backup.log 2>&1
```

备份落在 `./data/backup/`，默认保留 7 天（`KEEP_DAYS` 可调）。
数据目录：`./data/db`（数据库）、`./data/att`（附件）、`./data/backup`（备份）——**这三个必须持久化，别删**。

**Telegram 通知**（可选）：`.env` 设 `TG_ENABLED=true` + `TG_BOT_TOKEN` + `TG_DEFAULT_CHAT_ID`，新邮件会推送到 TG。

---

## 8. 故障排查表

| 现象 | 原因 / 排查 |
|---|---|
| 容器启动即退出，日志 `config: ... is required` | `.env` 没建或 `ALLOWED_DOMAINS`/`JWT_SECRET`/`ADMIN_API_KEY` 没填 |
| 用户登录页提示「code not recognized」 | 邀请码已用 / 已过期 / 已撤销，去 `/admin` 邀请码标签页生成新的 |
| 用户登录后 401「invalid or expired token」 | JWT 已过期（7 天），重新输入邀请码（同一码不能复用，需新码） |
| 用户创建邮箱 429「max mailboxes per user reached」 | 单用户最多 10 个邮箱，删旧邮箱或找管理员（代码硬上限，可改 `routes.ts`） |
| `smtp server listening` 但收不到信 | 入站 25 被云厂商/防火墙拦（§6.1 测试）；或 MX 没生效（`dig MX`） |
| MX 已配仍收不到 | Cloudflare 橙色云朵没关；或域名注册商处 NS 没改到 deSEC |
| 发件方退信 "Relaying denied" | 收件地址域名不在 `ALLOWED_DOMAINS`（这是**正确的防滥用行为**） |
| 发件方退信 "SPF fail" | SPF TXT 未生效，等 TTL 或重查 `dig TXT` |
| 页面一直显示「轮询」 | nginx `location /ws` 写成了 `/ws/`（不带尾斜杠才匹配）；或浏览器直连了 3000 端口 |
| 502 Bad Gateway | app 容器未 healthy（`docker compose ps`）；上游改了端口 |
| nginx 容器启动失败 `limit_req_zone directive is not allowed here` | `limit_req_zone` 被放进了 `server{}` 块——**必须在 http 上下文**（本仓库配置已修正） |
| 证书签发失败 | 80 端口被占用（`docker compose down` 后再签），或 DNS 还没解析到本机 |
| 附件下载 500 "invalid attachment path" | 老镜像旧代码；新代码已兼容中文/空格文件名 |
| 磁盘持续增长 | 附件文件现在会随邮件删除/过期清理一同删除；老数据可手工清空 `data/att` 下无主文件 |

---

## 9. 端口与安全边界（务必确认）

| 端口 | 暴露范围 | 说明 |
|---|---|---|
| 25 | **公网** | SMTP 入站，唯一必须对外开放的邮件端口 |
| 80 / 443 | 公网 | Web UI + API（经 nginx，HTTPS） |
| 3000 | **仅 127.0.0.1** | compose 里已写 `127.0.0.1:3000:3000`，nginx 反代；**不要把 3000 直接映射到公网** |

安全设计（代码已内置）：
- **绝不向客户端泄露密钥**：邮箱 token、ADMIN_API_KEY、deSEC token 全部仅服务端持有；接口响应不含 token 字段，用户标识只回脱敏的 `user_id_masked`（前 8 位 + …）
- **鉴权全在服务端**：前端只持有 JWT 登录凭证，不持有任何"值钱"的东西；邮箱操作只传 id，地址由服务端从 JWT 解析用户后查库得到，**客户端无法操作他人邮箱**
- **CSRF 防护**：所有写操作（POST/DELETE/PATCH）必须带 `X-DM-Req: 1` 自定义头 + 同源 Origin 校验；跨站伪造请求无法携带自定义头
- 创建邮箱 / Admin 登录走内存滑动窗口限速（`RATE_LIMIT_*`），nginx 另有 30r/s 限速
- 附件下载强制 `Content-Disposition: attachment`，HTML 邮件渲染在 `sandbox=""` iframe 内（禁脚本/表单/弹窗）
- 附件路径守卫 + 落盘文件名字符集白名单，防路径穿越
- SMTP 只对白名单域名收信，其余 `550 relaying denied`
