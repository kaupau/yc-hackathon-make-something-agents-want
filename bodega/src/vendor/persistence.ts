import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** Local demo persistence, never presented as an InsForge connection. */
export class DemoDatabase {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vendor_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));");
  }
  get<T>(kind: string, id: string): T | null {
    const row = this.db.prepare("SELECT data FROM vendor_records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(row.data as string) as T : null;
  }
  list<T>(kind: string): T[] {
    return this.db.prepare("SELECT data FROM vendor_records WHERE kind=? ORDER BY rowid").all(kind).map(r => JSON.parse(r.data as string) as T);
  }
  put(kind: string, id: string, data: unknown): void {
    this.db.prepare("INSERT INTO vendor_records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(kind, id, JSON.stringify(data));
  }
  insert(kind: string, id: string, data: unknown): void {
    this.db.prepare("INSERT INTO vendor_records(kind,id,data) VALUES(?,?,?)").run(kind, id, JSON.stringify(data));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
