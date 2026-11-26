import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export const dbPath = resolve(process.env.DB_PATH ?? "./data/notifications.db");

mkdirSync(dirname(dbPath), { recursive: true });

export const sqlite = new Database(dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    order_id INTEGER NOT NULL,
    order_code TEXT NOT NULL,
    student_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    routing_key TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    source_service TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_id_unique ON notifications (event_id);
  CREATE INDEX IF NOT EXISTS notifications_student_name_idx ON notifications (student_name);
  CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications (created_at);
`);

export const db = drizzle(sqlite, { schema });
