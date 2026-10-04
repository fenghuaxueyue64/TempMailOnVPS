// src/main.ts — 入口：同进程启动 SMTP + HTTP(API/WS/SSE) + 定时清理
import { loadConfig } from "./config";
import { openDB, q } from "./db/client";
import { MailStore } from "./mail/store";
import { createSmtpServer, startSmtp } from "./smtp/server";
import { createApiApp, cleanupExpired } from "./api/routes";
import { wsHandlers, setHookDb } from "./api/ws";
import { bus } from "./events";
import { notifyMail } from "./notify/telegram";

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`starting tempmail for domains [${cfg.allowedDomains.join(", ")}] on :${cfg.httpPort}`);

  // ---- 数据库 ----
  const db = openDB(cfg.dbPath);
  db.exec(`PRAGMA cache_size = ${cfg.dbCacheSize};`);

  // 域名白名单同步进 domains 表（.env 中的域名视为已配置）
  for (const domain of cfg.allowedDomains) {
    q.run(
      db,
      "INSERT INTO domains (domain, is_active, mx_synced) VALUES (?, 1, 1) ON CONFLICT(domain) DO UPDATE SET is_active = 1",
      domain,
    );
  }

  // ---- SMTP 入站 ----
  const store = new MailStore({ db, domains: cfg.allowedDomains, attDir: cfg.att.dir, attMaxSize: cfg.att.maxSize });
  const smtpServer = createSmtpServer({
    port: cfg.smtp.port,
    hostname: cfg.smtp.name,
    maxClients: cfg.smtp.maxClients,
    maxMessageBytes: cfg.smtp.maxMessageBytes,
    store,
  });
  await startSmtp(smtpServer, cfg.smtp.port);
  console.log(`smtp server listening on :${cfg.smtp.port} (hostname=${cfg.smtp.name}, accepts mail for @${cfg.allowedDomains.join(", @")})`);

  // ---- HTTP API + WS/SSE（Bun.serve 原生 WebSocket；server 注入 c.env 供 /ws 升级） ----
  setHookDb(db, cfg.jwtSecret);
  const app = createApiApp(cfg, db);
  const httpServer = Bun.serve({
    port: cfg.httpPort,
    fetch: (request, server) => app.fetch(request, { server }),
    websocket: wsHandlers as never,
  });
  console.log(`http api listening on :${cfg.httpPort}`);

  // ---- Telegram 通知：新邮件到达时推送（按文档 §6） ----
  if (cfg.tg.enabled) {
    if (!cfg.tg.botToken || !cfg.tg.defaultChatId) {
      console.warn("TG_ENABLED=true but TG_BOT_TOKEN/TG_DEFAULT_CHAT_ID missing; telegram disabled");
    } else {
      bus.onMail((e) => { void notifyMail(cfg.tg, e); });
      console.log(`telegram notifications enabled (chat=${cfg.tg.defaultChatId})`);
    }
  }

  // ---- 定时清理（每小时，按文档 §13.3；连同附件物理文件一起清理） ----
  const cleanupTimer = setInterval(() => {
    const n = cleanupExpired(db, cfg.att.dir);
    if (n > 0) console.log(`cleanup: removed ${n} expired mailboxes`);
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  // ---- 优雅退出 ----
  const shutdown = () => {
    console.log("shutting down...");
    clearInterval(cleanupTimer);
    smtpServer.close();
    httpServer.stop(true);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
