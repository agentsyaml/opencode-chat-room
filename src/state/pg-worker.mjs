import { parentPort } from "node:worker_threads";
import pg from "pg";
import { hasSql, translate } from "./pg-sql.mjs";

// One pg.Client per worker: transactions and their advisory locks belong to a
// single session, so a pool would be incorrect here.
//
// The worker deliberately starts with no workerData. Some Bun versions fail to
// load `pg` in a worker that received any workerData at startup. The main
// thread sends one init message over the default worker channel instead; that
// message also transfers the request MessagePort and the ready SharedArrayBuffer.

let client;
let port;
let readyFlag;
let statementTimeout = 4_500;
let connected = false;
let draining = false;
let closing = false;
const queue = [];

// SQLite returns all integers as JS numbers; int8 is a string in node-postgres
// by default and COUNT(*) / BIGINT columns must stay numbers.
pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1700, (value) => Number(value));

function normalize(params) {
  return params.map((value) =>
    value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value);
}

function serialize(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    code: error?.code,
    detail: error?.detail,
    hint: error?.hint,
    severity: error?.severity,
    position: error?.position,
    constraint: error?.constraint,
    table: error?.table,
    column: error?.column,
    dataType: error?.dataType,
  };
}

function signalReady() {
  Atomics.store(readyFlag, 0, 1);
  Atomics.notify(readyFlag, 0);
}

function reply(request, payload) {
  port.postMessage({ id: request.id, ...payload });
  const flag = new Int32Array(request.signal);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

async function handle(request) {
  try {
    const text = translate(request.sql);
    if (!hasSql(text)) return reply(request, { ok: true, rows: [], row: null, changes: 0 });
    const params = normalize(request.params ?? []);
    // exec without params uses the simple-query protocol so multi-statement
    // schema scripts (and BEGIN/COMMIT) run in one round trip.
    const result = request.mode === "exec" && params.length === 0
      ? await client.query(text)
      : await client.query({ text, values: params });
    if (request.mode === "get") return reply(request, { ok: true, row: result.rows?.[0] ?? null });
    if (request.mode === "all") return reply(request, { ok: true, rows: result.rows ?? [] });
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    // Identity columns are never read through Database.run in the state layer;
    // keep the API shape without pretending to know an insert id.
    return reply(request, { ok: true, changes: last?.rowCount ?? 0, lastInsertRowid: 0 });
  } catch (error) {
    return reply(request, { ok: false, error: serialize(error) });
  }
}

async function drain() {
  draining = true;
  while (queue.length && !closing) await handle(queue.shift());
  draining = false;
}

async function shutdown(signal) {
  closing = true;
  try { await client.end(); } catch { /* connection already gone */ }
  try { port.close(); } catch { /* already closed */ }
  if (signal) {
    const flag = new Int32Array(signal);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
}

function handlePortMessage(message) {
  if (message?.type === "close") {
    void shutdown(message.signal);
    return;
  }
  queue.push(message);
  if (connected && !draining) void drain();
}

async function startup(connectionString, ready, timeout) {
  readyFlag = new Int32Array(ready);
  statementTimeout = timeout;
  try {
    client = new pg.Client({
      connectionString,
      application_name: "opencode-chat-room",
      statement_timeout: statementTimeout,
    });
    await client.connect();
    connected = true;
    port.postMessage({ type: "ready" });
    signalReady();
    if (queue.length && !draining) void drain();
  } catch (error) {
    port.postMessage({ type: "fatal", error: serialize(error) });
    signalReady();
  }
}

parentPort.on("message", (message) => {
  if (message?.type !== "init" || client) return;
  port = message.port;
  port.on("message", handlePortMessage);
  parentPort.close();
  void startup(message.connectionString, message.ready, message.statementTimeout ?? 4_500);
});