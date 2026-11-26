import { DatabaseSync, type StatementSync } from "node:sqlite";

// The subset of bun:sqlite that this codebase uses, backed by node:sqlite so the
// same synchronous driver runs on Node, Bun and Deno.
export type SQLQueryBindings = null | number | bigint | string | boolean | Uint8Array | undefined;
export type RunResult = { changes: number; lastInsertRowid: number };
type RawBindings = Array<null | number | bigint | string | Uint8Array>;

// bun:sqlite binds booleans as 1/0 and undefined as NULL; node:sqlite rejects both.
function bindings(params: SQLQueryBindings[]): RawBindings {
  let values: SQLQueryBindings[] | undefined;
  for (let index = 0; index < params.length; index++) {
    const value = params[index];
    if (value === undefined || typeof value === "boolean") {
      values ??= params.slice();
      values[index] = value === undefined ? null : value ? 1 : 0;
    }
  }
  return (values ?? params) as RawBindings;
}

export class Statement {
  readonly #statement: StatementSync;
  constructor(statement: StatementSync) { this.#statement = statement; }
  all(...params: SQLQueryBindings[]): unknown[] {
    return this.#statement.all(...bindings(params));
  }
  // bun:sqlite returns null for a missing row, node:sqlite returns undefined.
  get(...params: SQLQueryBindings[]): unknown {
    return this.#statement.get(...bindings(params)) ?? null;
  }
  run(...params: SQLQueryBindings[]): RunResult {
    const result = this.#statement.run(...bindings(params));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
}

export type Transaction<T> = (() => T) & { deferred(): T; immediate(): T };

export type QueryStatement = {
  all(...params: SQLQueryBindings[]): unknown[];
  get(...params: SQLQueryBindings[]): unknown;
  run(...params: SQLQueryBindings[]): RunResult;
};

// The synchronous surface used by the state layer. Implemented by the
// node:sqlite adapter and by PgDatabase's worker-thread bridge.
export interface StateDatabase {
  query(sql: string): QueryStatement;
  prepare(sql: string): QueryStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): Transaction<T>;
  close(): void;
}

export class Database implements StateDatabase {
  readonly #db: DatabaseSync;
  #savepoints = 0;

  // node:sqlite always creates a missing file, matching the default Bun options.
  constructor(file: string, _options?: { create?: boolean }) {
    this.#db = new DatabaseSync(file);
  }

  query(sql: string): Statement { return new Statement(this.#db.prepare(sql)); }
  prepare(sql: string): Statement { return this.query(sql); }
  exec(sql: string): void { this.#db.exec(sql); }

  transaction<T>(fn: () => T): Transaction<T> {
    const run = (begin: string) => this.#run(begin, fn);
    return Object.assign(() => run("BEGIN"), { deferred: () => run("BEGIN"), immediate: () => run("BEGIN IMMEDIATE") });
  }

  close(): void { this.#db.close(); }

  #run<T>(begin: string, fn: () => T): T {
    // Nested calls become savepoints, like bun:sqlite transactions.
    const nested = this.#db.isTransaction;
    const savepoint = `chat_room_savepoint_${this.#savepoints++}`;
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : begin);
    try {
      const result = fn();
      this.#db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }
}

export function isBusyError(error: unknown): boolean {
  const err = error as { code?: string; errcode?: number; message?: string } | null;
  if (!err) return false;
  // PostgreSQL serialization failure and deadlock detected. The existing
  // immediate() retry loop treats these like SQLITE_BUSY/SQLITE_LOCKED.
  if (err.code === "40001" || err.code === "40P01") return true;
  if (typeof err.errcode === "number" && ((err.errcode & 0xff) === 5 || (err.errcode & 0xff) === 6)) return true;
  return /SQLITE_(BUSY|LOCKED)/.test(err.code ?? "") || /database (?:is|table is) locked/i.test(err.message ?? "");
}