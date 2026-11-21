import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Database, isBusyError } from "../state/sqlite.ts";

const root = mkdtempSync(path.join(tmpdir(), "chat-room-sqlite-adapter-"));
let counter = 0;
const file = () => path.join(root, `db-${counter++}.sqlite`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("node:sqlite adapter", () => {
  test("creates tables and maps all/get/run results", () => {
    const db = new Database(file());
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, active INTEGER)");
    const insert = db.query("INSERT INTO t(name,active) VALUES(?,?)").run("alice", true);
    expect({ ...insert }).toEqual({ changes: 1, lastInsertRowid: 1 });
    const row = db.query("SELECT id,name,active FROM t WHERE name=?").get("alice");
    expect(row).toEqual({ id: 1, name: "alice", active: 1 });
    expect(db.query("SELECT id FROM t ORDER BY id").all()).toEqual([{ id: 1 }]);
    expect(db.query("SELECT id FROM t WHERE id=?").get(9)).toBeNull();
    expect(db.query("SELECT id FROM t WHERE id=?").all(9)).toEqual([]);
    db.close();
  });

  test("binds undefined as NULL and booleans as 1/0", () => {
    const db = new Database(file());
    db.exec("CREATE TABLE t(a,b)");
    db.query("INSERT INTO t VALUES(?,?)").run(true, undefined);
    expect(db.query("SELECT a,b FROM t").get()).toEqual({ a: 1, b: null });
    db.close();
  });

  test("commits, rolls back and nests transactions as savepoints", () => {
    const db = new Database(file());
    db.exec("CREATE TABLE t(a TEXT)");
    const insert = (value: string) => db.query("INSERT INTO t VALUES(?)").run(value);

    expect(db.transaction(() => { insert("deferred"); return 7; }).deferred()).toBe(7);
    db.transaction(() => insert("immediate")).immediate();
    expect(() => db.transaction(() => { insert("rolled-back"); throw new Error("boom"); }).immediate()).toThrow("boom");

    db.transaction(() => {
      insert("outer");
      try { db.transaction(() => { insert("inner"); throw new Error("inner-boom"); }).immediate(); } catch { /* inner rolled back only */ }
      insert("after");
    }).immediate();

    const rows = (db.query("SELECT a FROM t ORDER BY rowid").all() as Array<{ a: string }>).map((row) => row.a);
    expect(rows).toEqual(["deferred", "immediate", "outer", "after"]);
    db.close();
  });

  test("exec runs multiple statements including a raw transaction", () => {
    const db = new Database(file());
    db.exec("BEGIN IMMEDIATE; CREATE TABLE t(a); INSERT INTO t VALUES(1); COMMIT");
    expect(db.query("SELECT a FROM t").all()).toEqual([{ a: 1 }]);
    db.close();
  });

  test("persists data and WAL mode across reopen", () => {
    const target = file();
    const first = new Database(target);
    expect(first.query("PRAGMA journal_mode=WAL").get()).toMatchObject({ journal_mode: "wal" });
    first.exec("CREATE TABLE t(a)");
    first.query("INSERT INTO t VALUES(?)").run("kept");
    first.close();

    const second = new Database(target);
    expect(second.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(second.query("SELECT a FROM t").get()).toEqual({ a: "kept" });
    second.close();
  });

  test("surfaces busy errors instead of retrying them", () => {
    const target = file();
    const writer = new Database(target);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a)");
    const other = new Database(target);
    other.exec("PRAGMA busy_timeout=50");
    writer.exec("BEGIN IMMEDIATE");
    let error: unknown;
    try { other.query("INSERT INTO t VALUES(1)").run(); } catch (caught) { error = caught; }
    writer.exec("ROLLBACK");
    writer.close();
    other.close();
    expect(isBusyError(error)).toBe(true);
  });
});