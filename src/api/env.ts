// src/api/env.ts — Hono 应用共享环境类型
import type { DB } from "../db/client";
import type { Config } from "../config";
import type { MailboxRow } from "./auth";

export interface Env {
  Variables: {
    db: DB;
    config: Config;
    jwtSecret: string;
    mailbox?: MailboxRow;
    userId?: string;
  };
}
