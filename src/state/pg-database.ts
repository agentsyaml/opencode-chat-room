import { existsSync } from "node:fs";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { QueryStatement, SQLQueryBindings, StateDatabase, Transaction } from "./sqlite.ts";

// Synchronous facade over a PostgreSQL connection. Every call blocks the
// calling thread on a SharedArrayBuffer while a worker thread performs the
// network I/O. The state layer is synchronous by design, so this preserves its
// transaction boundaries without turning 100+ call sites into async code.
//
// PostgreSQL support is experimental through the 0.8.2 multi-instance
// milestone. Writers serialize per transaction with an advisory xact lock;
// separate processes may share the database and apply disjoint diffs.

type Reply = {
  id: number;
  ok: boolean;
  rows?: unknown[];
  row?: unknown;
  changes?: number;
  lastInsertRowid?: number;
  error?: Record<string, unknown>;
};

type ReadyMessage = { type: "ready" } | { type: "fatal"; error?: Record<string, unknown> };

function workerURL(): URL {
  const beside = new URL("./pg-worker.mjs", import.meta.url);
  if (existsSync(fileURLToPath(beside))) return beside;
  // Bundled CLI: dist/cli.js -> src/state/pg-worker.mjs in the package.
  return new URL("../src/state/pg-worker.mjs", import.meta.url);
}

function databaseError(error: Record<string, unknown> | undefined): Error {
  const result = new Error(String(error?.message ?? "PostgreSQL query failed"));
  Object.assign(result, error);
  return result;
}

export class PgDatabase implements StateDatabase {
  readonly #worker: Worker;
  readonly #port: MessagePort;
  readonly #timeout: number;
  readonly #lockTimeout: number;
  #nextID = 1;
  #depth = 0;
  #savepoints = 0;
  #broken: Error | undefined;
  #closed = false;

  constructor(connectionString: string, options: { timeout?: number } = {}) {
    if (!connectionString) throw new Error("PostgreSQL connection string is empty");
    this.#timeout = options.timeout ?? 5_000;
    this.#lockTimeout = Math.max(1, this.#timeout - 1_000);
    const ready = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    this.#port = port1;
    this.#worker = new Worker(workerURL());
    this.#worker.unref();
    this.#port.unref();
    try {
      // No workerData: some Bun versions break `pg` when a worker starts with
      // any workerData. The default worker channel carries one init message
      // and transfers the request port.
      this.#worker.postMessage({
        type: "init",
        connectionString,
        ready,
        statementTimeout: Math.max(1, this.#timeout - 500),
        port: port2,
      }, [port2]);
    } catch (error) {
      void this.#worker.terminate();
      this.#port.close();
      throw error;
    }
    const status = Atomics.wait(new Int32Array(ready), 0, 0, this.#timeout);
    if (status === "timed-out") {
      void this.#worker.terminate();
      throw new Error(`PostgreSQL bridge did not become ready within ${this.#timeout}ms`);
    }
    const message = receiveMessageOnPort(this.#port)?.message as ReadyMessage | undefined;
    if (message?.type === "fatal") {
      void this.#worker.terminate();
      throw databaseError(message.error);
    }
  }

  query(sql: string): QueryStatement {
    return {
      all: (...params: SQLQueryBindings[]) => this.#request("all", sql, params).rows as unknown[],
      get: (...params: SQLQueryBindings[]) => this.#request("get", sql, params).row as unknown,
      run: (...params: SQLQueryBindings[]) => {
        const result = this.#request("run", sql, params);
        return { changes: result.changes ?? 0, lastInsertRowid: result.lastInsertRowid ?? 0 };
      },
    };
  }

  prepare(sql: string): QueryStatement { return this.query(sql); }

  exec(sql: string): void { this.#request("exec", sql, []); }

  transaction<T>(fn: () => T): Transaction<T> {
    const run = (immediate: boolean) => this.#run(fn, immediate);
    return Object.assign(() => run(false), {
      deferred: () => run(false),
      immediate: () => run(true),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const signal = new SharedArrayBuffer(4);
    try {
      this.#port.postMessage({ type: "close", signal });
      // Give client.end() time to flush before a caller opens the next
      // connection (migration and restart tests rely on it).
      Atomics.wait(new Int32Array(signal), 0, 0, 2_000);
    } catch { /* worker already gone */ }
    this.#port.close();
    void this.#worker.terminate();
  }

  #run<T>(fn: () => T, immediate: boolean): T {
    const nested = this.#depth > 0;
    const savepoint = `chat_room_savepoint_${this.#savepoints++}`;
    if (nested) {
      this.exec(`SAVEPOINT ${savepoint}`);
    } else {
      // Deferred reads need one stable snapshot; immediate writers are
      // serialized by the transaction-level advisory lock.
      this.exec(immediate ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ");
      if (immediate) {
        try {
          this.exec(`SET LOCAL lock_timeout = '${this.#lockTimeout}ms'; SELECT pg_advisory_xact_lock(hashtext('chat-room-state')); SET LOCAL lock_timeout = 0`);
        } catch (error) {
          try { this.exec("ROLLBACK"); } catch { /* keep the original error */ }
          throw error;
        }
      }
    }
    this.#depth++;
    try {
      const result = fn();
      this.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try {
        this.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      } catch { /* keep the original error */ }
      throw error;
    } finally {
      this.#depth--;
    }
  }

  #request(mode: "all" | "get" | "run" | "exec", sql: string, params: SQLQueryBindings[]): Reply {
    if (this.#broken) throw this.#broken;
    if (this.#closed) throw new Error("PostgreSQL database is closed");
    const id = this.#nextID++;
    const signal = new SharedArrayBuffer(4);
    this.#port.postMessage({ id, mode, sql, params, signal });
    const status = Atomics.wait(new Int32Array(signal), 0, 0, this.#timeout);
    if (status === "timed-out") {
      // The worker may still be inside the query. Its connection and queue are
      // no longer trustworthy, so fail closed rather than desynchronize later calls.
      this.#broken = Object.assign(
        new Error(`PostgreSQL bridge timed out after ${this.#timeout}ms; the database connection must be reopened`),
        { code: "PG_BRIDGE_TIMEOUT" },
      );
      throw this.#broken;
    }
    const message = receiveMessageOnPort(this.#port)?.message as Reply | undefined;
    if (!message || message.id !== id) {
      this.#broken = Object.assign(new Error("PostgreSQL bridge reply out of sequence"), { code: "PG_BRIDGE_SEQUENCE" });
      throw this.#broken;
    }
    if (!message.ok) throw databaseError(message.error);
    return message;
  }
}