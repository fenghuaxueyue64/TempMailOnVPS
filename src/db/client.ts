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
  return db;
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
