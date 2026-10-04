// src/db/client.ts — bun:sqlite 封装
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database;

export function openDB(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const schemaSql = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");
  db.exec(schemaSql);
  // 轻量迁移：老库缺列时补齐（CREATE TABLE IF NOT EXISTS 不会改已有表结构）
  migrate(db);
  return db;
}

/** 幂等加列迁移；未来新增列在此登记 */
function migrate(db: Database): void {
  const addCol = (table: string, col: string, ddl: string) => {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  addCol("invitations", "last_used_at", "last_used_at DATETIME");
  addCol("invitations", "use_count", "use_count INTEGER DEFAULT 0");
}

/** 查询助手：所有参数绑定，防注入 */
export const q = {
  get<T = unknown>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | undefined {
    return db.query(sql).get(...params) as T | undefined;
  },
  all<T = unknown>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
    return db.query(sql).all(...params) as T[];
  },
  run(db: Database, sql: string, ...params: SQLQueryBindings[]) {
    return db.query(sql).run(...params);
  },
};
