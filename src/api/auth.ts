// src/api/auth.ts — 邮箱 token 鉴权 + Admin JWT 鉴权
import type { Context, Next } from "hono";
import { verify } from "hono/jwt";
import { q, type DB } from "../db/client";
import type { Env } from "./env";

export interface MailboxRow {
  id: string;
  address: string;
  domain: string;
  token: string;
  expires_at: string;
  created_at: string;
}

/** 从 query `?token=` 或 `X-Mailbox-Token` 头解析访问令牌 */
export function extractToken(c: Context): string | null {
  return (c.req.query("token") ?? c.req.header("X-Mailbox-Token") ?? "").trim() || null;
}

/** 校验 token → 活跃邮箱；失败返回 null */
export function mailboxByToken(db: DB, token: string): MailboxRow | null {
  if (!token) return null;
  return q.get<MailboxRow>(
    db,
    "SELECT id, address, domain, token, expires_at, created_at FROM mailboxes WHERE token = ? AND expires_at > datetime('now')",
    token,
  ) ?? null;
}

/** 邮箱 token 鉴权中间件（查询参数或头部） */
export async function requireMailbox(c: Context<Env>, next: Next) {
  const db = c.get("db");
  const token = extractToken(c);
  const mb = token ? mailboxByToken(db, token) : null;
  if (!mb) {
    return c.json({ error: "invalid or expired mailbox token" }, 401);
  }
  c.set("mailbox", mb);
  await next();
}

/** Admin JWT 鉴权中间件 */
export async function requireAdmin(c: Context<Env>, next: Next) {
  const jwtSecret = c.get("jwtSecret");
  const auth = c.req.header("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  try {
    const payload = await verify(bearer, jwtSecret, "HS256");
    if (payload.role !== "admin") throw new Error("not admin");
    await next();
  } catch {
    return c.json({ error: "invalid or expired admin token" }, 401);
  }
}

/** User JWT 鉴权中间件（邀请码换 JWT，sub 字段存邀请码 = user_id） */
export async function requireUser(c: Context<Env>, next: Next) {
  const jwtSecret = c.get("jwtSecret");
  const auth = c.req.header("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) {
    return c.json({ error: "login required" }, 401);
  }
  try {
    const payload = await verify(bearer, jwtSecret, "HS256");
    if (payload.role !== "user" || !payload.sub) throw new Error("not user");
    c.set("userId", payload.sub as string);
    await next();
  } catch {
    return c.json({ error: "invalid or expired token, please login again" }, 401);
  }
}
