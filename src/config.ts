// src/config.ts — 环境变量统一读取（Bun 自动加载 .env）
export interface Config {
  nodeEnv: string;
  httpPort: number;
  smtp: { port: number; name: string; maxClients: number; maxMessageBytes: number };
  dbPath: string;
  dbCacheSize: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  adminApiKey: string;
  /** 管理后台入口路径（不含前导斜杠），随机英文+数字，避免被扫描器爆破 */
  adminPath: string;
  allowedDomains: string[];
  desec: { token: string; autoMx: boolean; vpsIp: string };
  mailbox: { defaultTtlHours: number; maxTtlHours: number; tokenBytes: number };
  att: { dir: string; maxSize: number };
  rateLimit: { window: number; max: number };
  tg: { enabled: boolean; botToken: string; defaultChatId: string };
  invitation: { ttlHours: number; maxPerCreate: number };
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export function loadConfig(): Config {
  const allowedDomains = (process.env.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  if (allowedDomains.length === 0) {
    throw new Error("config: ALLOWED_DOMAINS is required (comma-separated, e.g. tmp.io,mailtemp.net)");
  }
  const jwtSecret = process.env.JWT_SECRET ?? "";
  if (jwtSecret.length < 32) {
    throw new Error("config: JWT_SECRET must be at least 32 chars (openssl rand -hex 64)");
  }
  const adminApiKey = process.env.ADMIN_API_KEY ?? "";
  if (adminApiKey.length < 16) {
    throw new Error("config: ADMIN_API_KEY must be at least 16 chars (openssl rand -hex 32)");
  }

  // 管理入口路径：必须是 4-32 位英文+数字（字母开头），防止被 /admin 之类的字典扫描命中
  const adminPathRaw = (process.env.ADMIN_PATH ?? "").trim().replace(/^\/+|\/+$/g, "");
  let adminPath: string;
  if (adminPathRaw) {
    if (!/^[A-Za-z][A-Za-z0-9]{3,31}$/.test(adminPathRaw)) {
      throw new Error(
        "config: ADMIN_PATH must be 4-32 chars, start with a letter, letters+digits only (e.g. panel8k3mzq7)"
      );
    }
    adminPath = adminPathRaw;
  } else {
    // 未配置：随机生成（重启即变，仅应急用），并在启动时告警
    adminPath = randomPathSegment();
    console.warn(
      `\n  ⚠  ADMIN_PATH 未配置，本次随机管理入口为：/${adminPath}\n` +
        `     请在 .env 中设置 ADMIN_PATH=<随机英文+数字> 以固定入口，否则重启后路径会变化。\n`
    );
  }

  return {
    nodeEnv: process.env.NODE_ENV ?? "production",
    httpPort: envInt("HTTP_PORT", 3000),
    smtp: {
      port: envInt("SMTP_PORT", 25),
      name: process.env.SMTP_NAME ?? `mail.${allowedDomains[0]}`,
      maxClients: envInt("SMTP_MAX_CLIENTS", 100),
      maxMessageBytes: envInt("SMTP_MAX_MESSAGE_BYTES", 10 * 1024 * 1024),
    },
    dbPath: process.env.DB_PATH ?? "./data/db/tempmail.db",
    dbCacheSize: envInt("DB_CACHE_SIZE", -32000),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
    adminApiKey,
    adminPath,
    allowedDomains,
    desec: {
      token: process.env.DESEC_TOKEN ?? "",
      autoMx: envBool("DESEC_AUTO_MX", false),
      vpsIp: process.env.VPS_IP ?? "",
    },
    mailbox: {
      defaultTtlHours: envInt("DEFAULT_TTL_HOURS", 24),
      maxTtlHours: envInt("MAX_TTL_HOURS", 168),
      tokenBytes: envInt("MAILBOX_TOKEN_BYTES", 24),
    },
    att: {
      dir: process.env.ATT_DIR ?? "./data/att",
      maxSize: envInt("ATT_MAX_SIZE", 10 * 1024 * 1024),
    },
    rateLimit: {
      window: envInt("RATE_LIMIT_WINDOW", 60),
      max: envInt("RATE_LIMIT_MAX", 120),
    },
    tg: {
      enabled: envBool("TG_ENABLED", false),
      botToken: process.env.TG_BOT_TOKEN ?? "",
      defaultChatId: process.env.TG_DEFAULT_CHAT_ID ?? "",
    },
    invitation: {
      ttlHours: envInt("INVITATION_TTL_HOURS", 168),
      maxPerCreate: envInt("INVITATION_MAX_PER_CREATE", 50),
    },
  };
}

/** 随机管理入口片段：字母开头 + 字母数字，10 位 */
function randomPathSegment(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  // 确保字母开头（首字符取字母表子集）
  return "abcdefghijkmnpqrstuvwxyz"[bytes[0] % 24] + s.slice(1);
}

/** 将 JWT_EXPIRES_IN（"7d"/"1h"/"30m"/"3600"）转为秒 */
export function parseExpiryToSeconds(s: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(s.trim());
  if (!m) return 7 * 24 * 3600;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * (mult[unit] ?? 1);
}
