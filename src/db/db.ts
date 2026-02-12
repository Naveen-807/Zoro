import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { AppConfig } from "../config.js";

export function createDb(config: AppConfig): Database.Database {
  fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
  const db = new Database(config.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function runMigrations(db: Database.Database): void {
  const sql = fs.readFileSync(path.join(process.cwd(), "src/db/migrations/001_init.sql"), "utf8");
  db.exec(sql);
}
