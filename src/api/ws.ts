// src/api/ws.ts — WebSocket / SSE 实时推送（按用户订阅，服务端解析邮箱归属）
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { verify } from "hono/jwt";
import { q } from "../db/client";
import { bus, type MailEvent } from "../events";
import type { DB } from "../db/client";
import type { Env } from "./env";

// userId → 活跃 WS 连接集合（一个用户的所有连接都收到他自己邮箱的新邮件）
const connsByUser = new Map<string, Set<WebSocket>>();
const userOfConn = new Map<WebSocket, string>();
// userId → 该用户拥有的 mailboxId 集合（用于过滤事件）
const mailboxIdsByUser = new Map<string, Set<string>>();
let hookInstalled = false;
let hookDb: DB | null = null;
let hookJwtSecret = "";

export function setHookDb(db: DB, jwtSecret: string): void {
  hookDb = db;
  hookJwtSecret = jwtSecret;
}

/** 刷新某用户拥有的 mailboxId 集合（创建/删除邮箱后调用） */
export function refreshMailboxIds(userId: string): Set<string> {
  if (!hookDb) return new Set();
  const rows = q.all<{ id: string }>(hookDb, "SELECT id FROM mailboxes WHERE user_id = ?", userId);
  const set = new Set(rows.map((r) => r.id));
  mailboxIdsByUser.set(userId, set);
  return set;
}

function ensureHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  bus.onMail((e: MailEvent) => {
    // 找到这个 mailboxId 对应的 userId，推送给该用户的所有连接
    for (const [userId, ids] of mailboxIdsByUser) {
      if (!ids.has(e.mailboxId)) continue;
      const conns = connsByUser.get(userId);
      if (!conns?.size) continue;
      const message = JSON.stringify({ type: "mail", ...e });
      for (const ws of conns) {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      }
    }
  });
}

export const realtimeRoutes = new Hono<Env>();

/** 解析 JWT（从 query token 或 Authorization 头），返回 userId 或 null */
async function resolveUserFromJwt(c: Context<Env>): Promise<string | null> {
  const jwtSecret = c.get("jwtSecret");
  const qToken = (c.req.query("token") ?? "").trim();
  const auth = c.req.header("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : qToken;
  if (!bearer) return null;
  try {
    const payload = await verify(bearer, jwtSecret, "HS256");
    if (payload.role !== "user" || !payload.sub) return null;
    return payload.sub as string;
  } catch {
    return null;
  }
}

/** WebSocket 升级路由：GET /ws?token=<JWT>（JWT 而非 mailbox token） */
realtimeRoutes.get("/ws", async (c) => {
  const userId = await resolveUserFromJwt(c);
  if (!userId) return c.json({ error: "invalid or expired token" }, 401);
  const server = (c.env as { server?: { upgrade(req: Request, options?: { data?: unknown }): boolean } }).server;
  if (!server?.upgrade(c.req.raw, { data: { userId } })) {
    return c.json({ error: "websocket upgrade failed" }, 400);
  }
  return new Response(null, { status: 101 });
});

/** SSE 路由：GET /sse?token=<JWT> */
realtimeRoutes.get("/sse", async (c) => {
  const userId = await resolveUserFromJwt(c);
  if (!userId) return c.json({ error: "invalid or expired token" }, 401);
  const mbIds = refreshMailboxIds(userId);
  return streamSSE(c, async (stream) => {
    let closed = false;
    const off = bus.onMail((e) => {
      if (closed || !mbIds.has(e.mailboxId)) return;
      void stream.writeSSE({
        event: "mail",
        data: JSON.stringify({
          emailId: e.emailId,
          mailboxId: e.mailboxId,
          address: e.address,
          from: e.from,
          subject: e.subject,
          receivedAt: e.receivedAt,
        }),
      });
    });
    const heartbeat = setInterval(() => {
      if (!closed) void stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }, 25_000);
    stream.onAbort(() => {
      closed = true;
      clearInterval(heartbeat);
      off();
    });
    await new Promise<void>(() => {});
  });
});

// ---- Bun.serve websocket handlers ----

interface WsData {
  userId?: string;
}

export const wsHandlers = {
  open(ws: WebSocket & { data?: WsData }) {
    ensureHook();
    const userId = ws.data?.userId;
    if (!userId || !hookDb) {
      ws.close(4001, "no user binding");
      return;
    }
    let set = connsByUser.get(userId);
    if (!set) {
      set = new Set();
      connsByUser.set(userId, set);
    }
    set.add(ws);
    userOfConn.set(ws, userId);
    refreshMailboxIds(userId); // 建立该用户的 mailboxId 缓存
    ws.send(JSON.stringify({ type: "hello", userId }));
  },

  close(ws: WebSocket & { data?: WsData }) {
    const userId = userOfConn.get(ws);
    userOfConn.delete(ws);
    if (!userId) return;
    const set = connsByUser.get(userId);
    set?.delete(ws);
    if (set && set.size === 0) {
      connsByUser.delete(userId);
      mailboxIdsByUser.delete(userId);
    }
  },

  message(ws: WebSocket & { data?: WsData }, _msg: string | Uint8Array) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
  },
};
