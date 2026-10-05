// src/api/routes.ts — REST API（Hono）
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { q, type DB } from "../db/client";
import { requireMailbox, requireAdmin, requireUser } from "./auth";
import { realtimeRoutes, refreshMailboxIds } from "./ws";
import { setupDomainMx, listDomainRrsets, verifyDomainMx } from "../desec/client";
import { parseExpiryToSeconds, type Config } from "../config";
import type { Env } from "./env";
import { serveStatic } from "hono/bun";
import { existsSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

// ---- 内存滑动窗口限速 ----
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(cfg: Config, key: string): boolean {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + cfg.rateLimit.window * 1000 });
    return true;
  }
  b.count++;
  return b.count <= cfg.rateLimit.max;
}

// 定期清理失效桶，防内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (v.resetAt < now) rateBuckets.delete(k);
  }
}, 60_000).unref();

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("X-Real-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
}

/** 附件相对路径守卫：年月目录 + 安全字符集（不含 / 与 \，因此无法穿越；与 store.ts 落盘规则一致） */
const ATT_PATH_RE = /^[0-9]{4}-[0-9]{2}\/[A-Za-z0-9._-]+$/;

/** 删除附件物理文件（DB 级联删除后调用；文件不存在/已清理则静默跳过） */
function removeAttachmentFiles(attDir: string, rows: { file_path: string }[]): void {
  for (const r of rows) {
    if (!ATT_PATH_RE.test(r.file_path)) continue;
    try { unlinkSync(`${attDir}/${r.file_path}`); } catch { /* 不存在则忽略 */ }
  }
}

/** 常数时间字符串比较（防 timing attack） */
function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createApiApp(cfg: Config, db: DB): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", cfg);
    c.set("jwtSecret", cfg.jwtSecret);
    await next();
  });

  // ---- CSRF 防护：所有 POST/DELETE/PATCH/PUT 要求 X-DM-Req: 1 头 + Origin 校验 ----
  // 浏览器同源 fetch 会自动带 Origin，跨站伪造请求带不了我们自定义的 X-DM-Req 头。
  // GET 不改状态故豁免；OPTIONS 预检豁免。
  app.use("*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    // ① 自定义头校验
    if (c.req.header("X-DM-Req") !== "1") {
      return c.json({ error: "missing X-DM-Req header" }, 403);
    }
    // ② Origin 校验（同源才放行）
    const origin = c.req.header("Origin");
    if (origin) {
      try {
        const u = new URL(origin);
        // 反代场景优先信任 X-Forwarded-Host，否则用 Host
        const rawHost = c.req.header("X-Forwarded-Host") ?? c.req.header("Host") ?? "";
        // ★ 只比较主机名、忽略端口：
        //   浏览器对 80/443 等默认端口不会把端口写进 Origin（URL.host 也会剥掉），
        //   而 Host 头可能带端口（如 tmp.io:443）。此前用全等比较会把正常请求判成跨站 403。
        const hostName = rawHost.split(":")[0].trim().toLowerCase();
        // 允许同 host（标准反向代理场景），或本地开发 origin
        const isSameHost = hostName !== "" && u.hostname.toLowerCase() === hostName;
        const isDev = cfg.nodeEnv !== "production" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
        if (!isSameHost && !isDev) {
          console.warn(`[csrf] blocked origin=${origin} host=${rawHost} (hostName=${hostName})`);
          return c.json({ error: "origin not allowed" }, 403);
        }
      } catch {
        return c.json({ error: "invalid origin" }, 403);
      }
    }
    return next();
  });

  // ---- 健康检查（无鉴权） ----
  app.get("/api/health", (c) => {
    const dbOk = db.query("SELECT 1").get() !== undefined;
    return c.json({ status: "ok", smtp: "listening", db: dbOk ? "connected" : "error" });
  });

  // ---- 实时推送（WS + SSE） ----
  app.route("/", realtimeRoutes);

  // ---- 用户认证：邀请码换 JWT ----
  app.post("/api/auth/exchange", async (c) => {
    if (!rateLimit(cfg, `exchange:${clientIp(c)}`)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    const body = await c.req.json().catch(() => ({}));
    const code = ((body as { code?: string })?.code ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) {
      return c.json({ error: "invalid code format" }, 400);
    }
    const inv = q.get<{ code: string; used_at: string | null; expires_at: string }>(
      db, "SELECT code, used_at, expires_at FROM invitations WHERE code = ?", code,
    );
    if (!inv) return c.json({ error: "code not recognized" }, 401);
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = Math.floor(new Date(inv.expires_at.endsWith("Z") ? inv.expires_at : inv.expires_at + "Z").getTime() / 1000);
    if (expSec <= nowSec) return c.json({ error: "code expired" }, 401);
    // ★ 邀请码可重复使用：同一码在有效期内可反复登录（JWT 过期/换设备后可重新登录）
    //   used_at 记录首次使用，last_used_at / use_count 记录活跃度
    q.run(
      db,
      `UPDATE invitations
         SET used_at      = COALESCE(used_at, datetime('now')),
             last_used_at = datetime('now'),
             use_count    = COALESCE(use_count, 0) + 1
       WHERE code = ?`,
      code,
    );
    const exp = nowSec + parseExpiryToSeconds(cfg.jwtExpiresIn);
    const token = await sign({ role: "user", sub: code, exp }, cfg.jwtSecret);
    // 不回完整邀请码，仅回脱敏标识（JWT 已含完整 sub，前端不需要原码）
    const userMasked = code.length > 8 ? `${code.slice(0, 8)}…` : code;
    return c.json({ token, expires_in: cfg.jwtExpiresIn, user_id_masked: userMasked });
  });

  // 当前用户信息 + 邮箱列表（不返回 token）
  app.get("/api/me", requireUser, (c) => {
    const userId = c.get("userId")!;
    const mailboxes = q.all(db,
      `SELECT id, address, expires_at, created_at FROM mailboxes WHERE user_id = ? ORDER BY created_at DESC`,
      userId,
    );
    // 用户标识脱敏：只回前 8 位 + …
    const userIdMasked = userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
    return c.json({ user_id_masked: userIdMasked, mailboxes });
  });

  // ---- 邮箱（创建走 requireUser + 关联 user_id；读写校验归属） ----
  app.post("/api/mailboxes", requireUser, async (c) => {
    const userId = c.get("userId")!;
    if (!rateLimit(cfg, `mb:${clientIp(c)}`)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    // 每用户邮箱数量上限（防滥用，硬上限 10）
    const count = q.get<{ c: number }>(db, "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ?", userId)?.c ?? 0;
    if (count >= 10) {
      return c.json({ error: "max mailboxes per user reached (10)" }, 429);
    }

    const body = await c.req.json().catch(() => ({}));
    const req = (body ?? {}) as { domain?: string; name?: string; ttl_hours?: number };

    // 域名白名单校验（活跃域名表）
    const domain = (req.domain ?? cfg.allowedDomains[0]).trim().toLowerCase();
    // 诊断日志：生产环境排查创建失败用（docker compose logs app）
    console.log(`[mb] create user=${String(userId).slice(0, 8)}… domain=${domain} allowed=[${cfg.allowedDomains.join(",")}]`);
    // ★ 防御兜底：即使启动时同步未生效（如老库/手工改库），
    //   只要域名在 ALLOWED_DOMAINS 中就自动补进 domains 表，避免"配置好了却创建失败"
    if (cfg.allowedDomains.includes(domain)) {
      q.run(
        db,
        "INSERT INTO domains (domain, is_active, mx_synced) VALUES (?, 1, 1) ON CONFLICT(domain) DO UPDATE SET is_active = 1",
        domain,
      );
    }
    const allowed = q.get<{ domain: string }>(db, "SELECT domain FROM domains WHERE domain = ? AND is_active = 1", domain);
    if (!allowed) {
      console.error(`[mb] create failed: domain not active in db (domain=${domain})`);
      return c.json({ error: "invalid domain", allowed_domains: cfg.allowedDomains }, 400);
    }

    // 本地部分：自定义或随机
    let local = (req.name ?? "").trim().toLowerCase();
    if (local === "") {
      local = randomLocal();
    } else {
      local = local.replace(/[^a-z0-9._-]/g, "");
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local)) {
        return c.json({ error: "invalid name" }, 400);
      }
    }

    // TTL 限制
    let ttlHours = cfg.mailbox.defaultTtlHours;
    if (req.ttl_hours && Number.isFinite(req.ttl_hours)) {
      ttlHours = Math.min(Math.max(Math.floor(req.ttl_hours), 1), cfg.mailbox.maxTtlHours);
    }

    const token = randomToken(cfg.mailbox.tokenBytes); // 仅服务端持有，不返回客户端
    const id = Bun.randomUUIDv7();
    const address = `${local}@${domain}`;
    const existing = q.get<{ id: string }>(db, "SELECT id FROM mailboxes WHERE address = ?", address);
    if (existing) {
      return c.json({ error: "address already exists" }, 409);
    }
    try {
      q.run(
        db,
        "INSERT INTO mailboxes (id, address, domain, token, user_id, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))",
        id, address, domain, token, userId, `+${ttlHours} hours`,
      );
    } catch {
      return c.json({ error: "address already exists" }, 409);
    }
    const mb = q.get<{ expires_at: string; created_at: string }>(
      db, "SELECT expires_at, created_at FROM mailboxes WHERE id = ?", id,
    );
    refreshMailboxIds(userId); // 刷新 WS 推送缓存
    // ★ 不返回 token（敏感凭据留服务端）
    return c.json({
      id,
      address,
      expires_at: mb?.expires_at,
      created_at: mb?.created_at,
    }, 201);
  });

  // 我的邮箱列表（按 user_id 查所有，含已过期，方便用户看到/续期）
  // ★ 不返回 token 字段
  app.get("/api/mailboxes", requireUser, (c) => {
    const userId = c.get("userId")!;
    const rows = q.all(db,
      `SELECT id, address, expires_at, created_at FROM mailboxes WHERE user_id = ? ORDER BY created_at DESC`,
      userId,
    );
    return c.json({ mailboxes: rows });
  });

  // 续期邮箱（按 id，服务端校验归属；不接受客户端传地址）
  app.post("/api/mailboxes/:id/renew", requireUser, (c) => {
    const userId = c.get("userId")!;
    const id = c.req.param("id") as string;
    const mb = q.get<{ user_id: string }>(db, "SELECT user_id FROM mailboxes WHERE id = ?", id);
    if (!mb) return c.json({ error: "mailbox not found" }, 404);
    if (mb.user_id !== userId) return c.json({ error: "not your mailbox" }, 403);
    q.run(db, "UPDATE mailboxes SET expires_at = datetime('now', ?) WHERE id = ?",
      `+${cfg.mailbox.defaultTtlHours} hours`, id);
    const updated = q.get<{ expires_at: string }>(db, "SELECT expires_at FROM mailboxes WHERE id = ?", id);
    return c.json({ id, expires_at: updated?.expires_at });
  });

  // 工具：根据 id 查邮箱并校验归属（客户端只传 id，地址由服务端解析）
  function getOwnedMailboxById(db: DB, userId: string, id: string) {
    const mb = q.get<{ id: string; address: string; user_id: string; expires_at: string; created_at: string }>(
      db, "SELECT id, address, user_id, expires_at, created_at FROM mailboxes WHERE id = ?", id,
    );
    if (!mb) return null;
    if (mb.user_id !== userId) return null;
    return mb;
  }

  // 邮箱详情（按 id）
  app.get("/api/mailboxes/:id", requireUser, (c) => {
    const userId = c.get("userId")!;
    const mb = getOwnedMailboxById(db, userId, c.req.param("id") as string);
    if (!mb) return c.json({ error: "mailbox not found" }, 404);
    const messages = q.all(db,
      "SELECT id, from_address, from_name, subject, raw_size, is_read, received_at FROM emails WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 100",
      mb.id,
    );
    return c.json({ id: mb.id, address: mb.address, expires_at: mb.expires_at, created_at: mb.created_at, messages });
  });

  app.delete("/api/mailboxes/:id", requireUser, (c) => {
    const userId = c.get("userId")!;
    const mb = getOwnedMailboxById(db, userId, c.req.param("id") as string);
    if (!mb) return c.json({ error: "mailbox not found" }, 404);
    const atts = q.all<{ file_path: string }>(db,
      `SELECT a.file_path FROM attachments a JOIN emails e ON e.id = a.email_id WHERE e.mailbox_id = ?`, mb.id);
    q.run(db, "DELETE FROM mailboxes WHERE id = ?", mb.id);
    removeAttachmentFiles(cfg.att.dir, atts);
    refreshMailboxIds(userId);
    return c.json({ deleted: mb.id });
  });

  // ---- 邮件列表（按 mailbox id） ----
  app.get("/api/mailboxes/:id/messages", requireUser, (c) => {
    const userId = c.get("userId")!;
    const mb = getOwnedMailboxById(db, userId, c.req.param("id") as string);
    if (!mb) return c.json({ error: "mailbox not found" }, 404);
    const rows = q.all(db,
      "SELECT id, message_id, from_address, from_name, to_address, subject, raw_size, is_read, received_at FROM emails WHERE mailbox_id = ? ORDER BY received_at DESC",
      mb.id,
    );
    return c.json({ mailbox_id: mb.id, messages: rows });
  });

  app.get("/api/messages/:id", requireUser, (c) => {
    const userId = c.get("userId")!;
    const row = q.get<{ mailbox_id: string }>(db, "SELECT * FROM emails WHERE id = ?", c.req.param("id") as string);
    if (!row) return c.json({ error: "message not found" }, 404);
    const owner = q.get<{ user_id: string }>(db, "SELECT user_id FROM mailboxes WHERE id = ?", row.mailbox_id);
    if (!owner || owner.user_id !== userId) return c.json({ error: "not your message" }, 403);
    const atts = q.all(db,
      "SELECT id, filename, content_type, size FROM attachments WHERE email_id = ?",
      c.req.param("id") as string,
    );
    return c.json({ ...row, attachments: atts });
  });

  // 标记已读 / 未读
  app.patch("/api/messages/:id", requireUser, async (c) => {
    const userId = c.get("userId")!;
    const row = q.get<{ mailbox_id: string }>(db, "SELECT mailbox_id FROM emails WHERE id = ?", c.req.param("id") as string);
    if (!row) return c.json({ error: "message not found" }, 404);
    const owner = q.get<{ user_id: string }>(db, "SELECT user_id FROM mailboxes WHERE id = ?", row.mailbox_id);
    if (!owner || owner.user_id !== userId) return c.json({ error: "not your message" }, 403);

    const body = await c.req.json().catch(() => ({}));
    const isRead = (body as { is_read?: boolean })?.is_read === true ? 1 : 0;
    const res = q.run(db, "UPDATE emails SET is_read = ? WHERE id = ?", isRead, c.req.param("id") as string);
    if (res.changes === 0) return c.json({ error: "message not found" }, 404);
    return c.json({ id: c.req.param("id"), is_read: isRead === 1 });
  });

  app.delete("/api/messages/:id", requireUser, (c) => {
    const userId = c.get("userId")!;
    const id = c.req.param("id") as string;
    const row = q.get<{ mailbox_id: string }>(db, "SELECT mailbox_id FROM emails WHERE id = ?", id);
    if (!row) return c.json({ error: "message not found" }, 404);
    const owner = q.get<{ user_id: string }>(db, "SELECT user_id FROM mailboxes WHERE id = ?", row.mailbox_id);
    if (!owner || owner.user_id !== userId) return c.json({ error: "not your message" }, 403);
    const atts = q.all<{ file_path: string }>(db, "SELECT file_path FROM attachments WHERE email_id = ?", id);
    const res = q.run(db, "DELETE FROM emails WHERE id = ?", id);
    if (res.changes === 0) return c.json({ error: "message not found" }, 404);
    removeAttachmentFiles(cfg.att.dir, atts);
    return c.json({ deleted: id });
  });

  // ---- 附件下载（requireUser + 归属校验） ----
  app.get("/api/attachments/:id", requireUser, async (c) => {
    const userId = c.get("userId")!;
    const att = q.get<{ file_path: string; filename: string; content_type: string; mailbox_user_id: string }>(db, `
      SELECT a.file_path, a.filename, a.content_type, m.user_id AS mailbox_user_id
      FROM attachments a
      JOIN emails e ON e.id = a.email_id
      JOIN mailboxes m ON m.id = e.mailbox_id
      WHERE a.id = ?`,
      c.req.param("id") as string,
    );
    if (!att) return c.json({ error: "attachment not found" }, 404);
    if (att.mailbox_user_id !== userId) return c.json({ error: "not your attachment" }, 403);
    if (!ATT_PATH_RE.test(att.file_path)) {
      return c.json({ error: "invalid attachment path" }, 500);
    }
    const file = Bun.file(`${cfg.att.dir}/${att.file_path}`);
    if (!(await file.exists())) return c.json({ error: "attachment file missing" }, 404);
    return new Response(file, {
      headers: {
        "Content-Type": att.content_type || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(att.filename ?? "attachment")}`,
      },
    });
  });

  // ---- Admin（JWT） ----
  app.post("/api/admin/login", async (c) => {
    if (!rateLimit(cfg, `login:${clientIp(c)}`)) return c.json({ error: "rate limit exceeded" }, 429);
    const body = await c.req.json().catch(() => ({}));
    const apiKey = (body as { api_key?: string })?.api_key ?? c.req.header("X-Admin-Key") ?? "";
    if (!secureEqual(apiKey, cfg.adminApiKey)) {
      return c.json({ error: "invalid admin api key" }, 401);
    }
    const token = await sign(
      { role: "admin", exp: Math.floor(Date.now() / 1000) + parseExpiryToSeconds(cfg.jwtExpiresIn) },
      cfg.jwtSecret,
    );
    return c.json({ token, expires_in: cfg.jwtExpiresIn });
  });

  const admin = new Hono<Env>();
  admin.use("*", requireAdmin);

  admin.get("/domains", (c) => {
    const rows = q.all<{ id: number; domain: string; is_active: number; mx_synced: number; created_at: string }>(
      db, "SELECT id, domain, is_active, mx_synced, created_at FROM domains ORDER BY created_at DESC",
    );
    // 标注哪些域名来自 ALLOWED_DOMAINS（启动时自动同步，无需手动添加，重启会重建）
    const envDomains = new Set(cfg.allowedDomains);
    return c.json({
      domains: rows.map((d) => ({ ...d, from_env: envDomains.has(d.domain) })),
      allowed_domains: cfg.allowedDomains,
    });
  });

  admin.post("/domains", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const domain = ((body as { domain?: string })?.domain ?? "").trim().toLowerCase();
    if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      return c.json({ error: "invalid domain" }, 400);
    }
    if (q.get(db, "SELECT id FROM domains WHERE domain = ?", domain)) {
      return c.json({ error: "domain already exists" }, 409);
    }
    let mxSynced = 0;
    let desecError: string | undefined;
    if (cfg.desec.autoMx && cfg.desec.token) {
      try {
        await setupDomainMx(cfg.desec, domain);
        mxSynced = 1;
      } catch (err) {
        desecError = err instanceof Error ? err.message : String(err);
      }
    }
    q.run(db, "INSERT INTO domains (domain, is_active, mx_synced) VALUES (?, 1, ?)", domain, mxSynced);
    return c.json({ domain, is_active: true, mx_synced: mxSynced === 1, desec_error: desecError }, 201);
  });

  admin.delete("/domains/:domain", (c) => {
    const domain = (c.req.param("domain") as string).toLowerCase();
    const res = q.run(db, "UPDATE domains SET is_active = 0 WHERE domain = ?", domain);
    if (res.changes === 0) return c.json({ error: "domain not found" }, 404);
    return c.json({ domain, is_active: false });
  });

  // 查询某域名在 deSEC 上的 DNS 记录（A/MX/TXT 等）
  admin.get("/domains/:domain/dns", async (c) => {
    const domain = (c.req.param("domain") as string).toLowerCase();
    if (!cfg.desec.token) return c.json({ error: "deSEC not configured (DESEC_TOKEN empty)" }, 400);
    try {
      const rrsets = await listDomainRrsets(cfg.desec, domain);
      return c.json({ domain, rrsets });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // 手动重新同步某域名的 MX/SPF（即使 DESEC_AUTO_MX=false 也可触发）
  admin.post("/domains/:domain/sync", async (c) => {
    const domain = (c.req.param("domain") as string).toLowerCase();
    const existing = q.get<{ id: string }>(db, "SELECT id FROM domains WHERE domain = ?", domain);
    if (!existing) return c.json({ error: "domain not found" }, 404);
    try {
      await setupDomainMx(cfg.desec, domain);
      q.run(db, "UPDATE domains SET mx_synced = 1 WHERE domain = ?", domain);
      return c.json({ domain, mx_synced: true });
    } catch (err) {
      return c.json({ domain, mx_synced: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // 校验某域名 MX 是否已生效（deSEC NS 直查）
  admin.get("/domains/:domain/verify", async (c) => {
    const domain = (c.req.param("domain") as string).toLowerCase();
    const result = await verifyDomainMx(cfg.desec, domain);
    return c.json({ domain, ...result });
  });

  admin.post("/cleanup", (c) => {
    const removedMailboxes = cleanupExpired(db, cfg.att.dir);
    return c.json({ removed_mailboxes: removedMailboxes });
  });

  // ---- 邀请码管理 ----
  // 批量生成
  admin.post("/invitations", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const count = Math.min(Math.max(Number((body as { count?: number })?.count ?? 1) || 1, 1), cfg.invitation.maxPerCreate);
    const note = ((body as { note?: string })?.note ?? "").slice(0, 200);
    const ttlHours = Math.min(Math.max(Number((body as { ttl_hours?: number })?.ttl_hours) || cfg.invitation.ttlHours, 1), 720);
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = randomToken(16); // 32 位 hex
      q.run(db, "INSERT INTO invitations (code, note, expires_at) VALUES (?, ?, datetime('now', ?))",
        code, note, `+${ttlHours} hours`);
      codes.push(code);
    }
    return c.json({ codes, count: codes.length, ttl_hours: ttlHours, note }, 201);
  });

  // 列表（支持状态过滤）
  admin.get("/invitations", (c) => {
    const status = (c.req.query("status") ?? "all").toLowerCase();
    let rows: any[];
    const SELECT_INV = "SELECT code, note, used_at, last_used_at, use_count, expires_at, created_at FROM invitations";
    if (status === "unused") {
      rows = q.all(db, `${SELECT_INV} WHERE used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC`);
    } else if (status === "used") {
      rows = q.all(db, `${SELECT_INV} WHERE used_at IS NOT NULL ORDER BY last_used_at DESC`);
    } else if (status === "expired") {
      rows = q.all(db, `${SELECT_INV} WHERE expires_at <= datetime('now') ORDER BY expires_at DESC`);
    } else {
      rows = q.all(db, `${SELECT_INV} ORDER BY created_at DESC`);
    }
    // 附带每个码的活跃状态，前端无需自行判断过期
    const now = Date.now();
    const enriched = rows.map((r) => {
      const exp = new Date(r.expires_at.endsWith("Z") ? r.expires_at : r.expires_at + "Z").getTime();
      return { ...r, expired: exp <= now, status: exp <= now ? "expired" : r.used_at ? "used" : "unused" };
    });
    return c.json({ invitations: enriched });
  });

  // 撤销（删除未使用的邀请码）
  admin.delete("/invitations/:code", (c) => {
    const code = (c.req.param("code") as string).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) return c.json({ error: "invalid code format" }, 400);
    const res = q.run(db, "DELETE FROM invitations WHERE code = ? AND used_at IS NULL", code);
    if (res.changes === 0) return c.json({ error: "code not found or already used" }, 404);
    return c.json({ deleted: code });
  });

  app.route("/api/admin", admin);

  // ---- Web UI（SvelteKit build 产物，同端口托管；dev 模式用 vite :5173 + proxy） ----
  if (existsSync("./web/build")) {
    app.get("/favicon.svg", serveStatic({ path: "./web/build/favicon.svg" }));

    /**
     * 渲染 index.html 并注入管理入口占位符。
     * ★ 安全：仅当本次请求就是管理入口时才注入真实路径，其余一律注入空串。
     *   否则任何访客查看 index.html 源码都能拿到后台地址，随机入口形同虚设。
     */
    const renderIndex = async (adminPath: string): Promise<Response> => {
      const html = await Bun.file("./web/build/index.html").text();
      return new Response(html.replaceAll("{{ADMIN_PATH}}", adminPath), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // 入口页不缓存，避免真实路径被中间缓存/CDN 留存
          "Cache-Control": adminPath ? "no-store" : "no-cache",
        },
      });
    };

    // ★ 必须在 serveStatic 之前接管 / 与 /index.html：
    //   否则 serveStatic 会直接吐出原始 index.html，占位符不会被替换
    const adminEntry = `/${cfg.adminPath.toLowerCase()}`;
    for (const p of ["/", "/index.html"]) {
      app.get(p, () => renderIndex(""));
    }
    // 管理入口本身：注入真实路径
    app.get(adminEntry, () => renderIndex(cfg.adminPath));

    app.use("/*", serveStatic({ root: "./web/build" }));

    // 旧的 /admin 入口一律 404（避免被字典扫描命中）
    app.get("/admin", (c) => c.json({ error: "not found" }, 404));
    app.get("/admin/*", (c) => c.json({ error: "not found" }, 404));

    // SPA fallback：API 前缀返回 JSON 404，其余 GET 返回 index.html 交给前端路由
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "not found" }, 404);
      }
      const reqPath = c.req.path.replace(/\/+$/, "").toLowerCase();
      const isAdminEntry = reqPath === adminEntry;
      return renderIndex(isAdminEntry ? cfg.adminPath : "");
    });
  }

  return app;
}

// ---- 工具函数 ----

function randomLocal(): string {
  // 10 字符随机本地部分（base32 风格，短且 URL 安全）
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 清理过期邮箱及其邮件与附件文件；返回清理的邮箱数 */
export function cleanupExpired(db: DB, attDir = ""): number {
  // 先收集将被级联删除的附件文件路径
  const atts = attDir
    ? q.all<{ file_path: string }>(db, `
        SELECT a.file_path FROM attachments a
        JOIN emails e ON e.id = a.email_id
        JOIN mailboxes m ON m.id = e.mailbox_id
        WHERE m.expires_at <= datetime('now')`)
    : [];
  // 外键级联：mailboxes → emails → attachments
  const res = q.run(db, "DELETE FROM mailboxes WHERE expires_at <= datetime('now')");
  if (atts.length) removeAttachmentFiles(attDir, atts);
  return res.changes;
}
