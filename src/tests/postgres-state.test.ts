import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PgDatabase } from "../state/pg-database.ts";
import { closeStateDatabases, initializeAdminSchema, initializeReminderSchema, openStateDatabase } from "../state/sqlite-state.ts";
import * as store from "../state/store.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const helperPath = fileURLToPath(new URL("./postgres-child.ts", import.meta.url));
const originalStateDir = process.env.CHAT_ROOM_STATE_DIR;
const dockerReady = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 &&
  spawnSync("docker", ["image", "inspect", "postgres:16-alpine"], { stdio: "ignore" }).status === 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).at(-1) ?? "";

let root = "";
let container = "";
let url = "";
let holdChild: ChildProcess | undefined;

function envFor(stateDir: string, postgres: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(stateDir, "home"),
    XDG_CONFIG_HOME: path.join(stateDir, "config"),
    XDG_STATE_HOME: path.join(stateDir, "state"),
    CHAT_ROOM_STATE_DIR: stateDir,
  };
  if (postgres) env.CHAT_ROOM_DATABASE_URL = url;
  else delete env.CHAT_ROOM_DATABASE_URL;
  return env;
}

async function dropSchema(): Promise<void> {
  await closeStateDatabases();
  const db = new PgDatabase(url);
  db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  db.close();
}

function runHelper(mode: string, stateDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [helperPath, mode], {
    cwd: repoRoot,
    env: envFor(stateDir, true),
    encoding: "utf8",
    timeout: 30_000,
  });
}

function runCli(args: string[], stateDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["cli.ts", ...args], {
    cwd: repoRoot,
    env: envFor(stateDir, true),
    encoding: "utf8",
    timeout: 60_000,
  });
}

async function waitForOutput(child: ChildProcess, text: string, read: () => string): Promise<void> {
  for (let index = 0; index < 500; index++) {
    if (read().includes(text)) return;
    await sleep(20);
  }
  throw new Error(`child did not print ${text}`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startChatServer(stateDir: string, port: number, token: string) {
  const env: NodeJS.ProcessEnv = {
    ...envFor(stateDir, true),
    CHAT_ROOM_SERVER_HOST: "127.0.0.1",
    CHAT_ROOM_SERVER_PORT: String(port),
    CHAT_ROOM_SERVER_TOKEN: token,
    CHAT_ROOM_STORAGE: "local",
    CHAT_ROOM_CHANNELD: "0",
  };
  const child = spawn(process.execPath, ["cli.ts"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { errors += chunk; });
  return { child, output: () => output, errors: () => errors };
}

async function waitForServer(base: string, token: string, started: ReturnType<typeof startChatServer>): Promise<void> {
  for (let index = 0; index < 150; index++) {
    if (started.child.exitCode !== null || started.child.signalCode !== null) throw new Error(`server exited early: ${started.errors()}`);
    try {
      const response = await fetch(`${base}/rooms`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 200) return;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error(`server did not listen: ${started.errors()}`);
}

async function api(base: string, token: string, route: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) as unknown : undefined;
}

async function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function stopChatServer(started: ReturnType<typeof startChatServer>): Promise<void> {
  if (started.child.exitCode === null && started.child.signalCode === null) {
    started.child.kill("SIGTERM");
    await exitOf(started.child);
  }
}

(describe.skipIf ? describe.skipIf(!dockerReady) : (dockerReady ? describe : describe.skip))("PostgreSQL state backend", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "chat-room-pg-test-"));
    const name = `chatroom-pg-test-${process.pid}-${Date.now()}`;
    const password = randomBytes(16).toString("hex");
    const database = `chatroom_${randomBytes(4).toString("hex")}`;
    const created = spawnSync("docker", [
      "run", "-d", "--rm", "--name", name,
      "-e", `POSTGRES_PASSWORD=${password}`,
      "-e", `POSTGRES_DB=${database}`,
      "-p", "127.0.0.1::5432", "postgres:16-alpine",
    ], { encoding: "utf8" });
    if (created.status !== 0) throw new Error(`could not start PostgreSQL test container: ${created.stderr}`);
    container = name;
    for (let index = 0; index < 120; index++) {
      const ready = spawnSync("docker", ["exec", name, "psql", "-U", "postgres", "-d", database, "-tAc", "select 1"], { stdio: "ignore" });
      if (ready.status === 0) break;
      await sleep(250);
    }
    const portText = spawnSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).stdout;
    const port = Number(portText.trim().match(/:(\d+)\s*$/m)?.[1] ?? 0);
    if (!port) throw new Error("could not determine the PostgreSQL test container port");
    url = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
  }, 60_000);

  afterAll(async () => {
    if (holdChild && holdChild.exitCode === null) {
      holdChild.kill("SIGKILL");
      await exitOf(holdChild);
    }
    await closeStateDatabases();
    if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    if (root) rmSync(root, { recursive: true, force: true });
    delete process.env.CHAT_ROOM_DATABASE_URL;
    if (originalStateDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
    else process.env.CHAT_ROOM_STATE_DIR = originalStateDir;
  });

  test("creates the schema, keeps 64-bit timestamps, and reads rooms/messages/history", async () => {
    const stateDir = path.join(root, "schema");
    mkdirSync(stateDir, { recursive: true });
    await dropSchema();
    process.env.CHAT_ROOM_DATABASE_URL = url;
    process.env.CHAT_ROOM_STATE_DIR = stateDir;

    const roomID = await store.writeState((service) => {
      const room = service.createRoom("pg room", "owner");
      service.sendMessage(room.id, "owner", "first");
      service.sendMessage(room.id, "owner", "second");
      service.sendMessage(room.id, "owner", "third");
      return room.id;
    });
    const history = await store.readHistory(roomID);
    expect(history.messages.map((message) => message.text)).toEqual(["first", "second", "third"]);
    expect(history.messages.map((message) => message.seq)).toEqual([1, 2, 3]);

    const state = await store.readState((service) => service.listRooms());
    expect(state[0]?.name).toBe("pg room");
    expect(state[0]?.messages.map((message) => message.text)).toEqual(["first", "second", "third"]);

    const db = await openStateDatabase(store.databasePath());
    const columns = (db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns.slice(0, 12)).toEqual(["seq", "id", "room_id", "sender_id", "sender_session_id", "text", "created_at", "is_question", "answer_to", "answered_by", "recalled_at", "recalled_by"]);
    expect(columns).toContain("client_msg_id");
    expect((db.query("SELECT data_type FROM information_schema.columns WHERE table_name='messages' AND column_name='created_at'").get() as { data_type: string }).data_type).toBe("bigint");
    expect((db.query("SELECT is_identity FROM information_schema.columns WHERE table_name='messages' AND column_name='seq'").get() as { is_identity: string }).is_identity).toBe("YES");
    const index = db.query("SELECT indexdef FROM pg_indexes WHERE tablename='messages' AND indexname='messages_client_id'").get() as { indexdef: string } | null;
    expect(index?.indexdef).toContain("WHERE");
    await closeStateDatabases();
  });

  test("rejects a second instance and keeps state across a restart", async () => {
    const stateDir = path.join(root, "instance");
    mkdirSync(stateDir, { recursive: true });
    await dropSchema();
    const env = envFor(stateDir, true);

    let output = "", errors = "";
    holdChild = spawn(process.execPath, [helperPath, "hold"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    holdChild.stdout?.on("data", (chunk) => { output += chunk; });
    holdChild.stderr?.on("data", (chunk) => { errors += chunk; });
    await waitForOutput(holdChild, "holding", () => output);

    const locked = runHelper("expect-locked", stateDir);
    expect(locked.status).toBe(0);
    const guard = JSON.parse(lastLine(String(locked.stdout))) as { code: string; message: string };
    expect(guard.code).toBe("PG_SINGLE_INSTANCE");
    expect(guard.message).toContain("single-instance");
    expect(guard.message).toContain("0.8.2");

    holdChild.kill("SIGKILL");
    await exitOf(holdChild);
    holdChild = undefined;
    await sleep(500);

    const written = runHelper("write", stateDir);
    expect(written.status).toBe(0);
    const read = runHelper("read", stateDir);
    expect(read.status).toBe(0);
    expect(JSON.parse(lastLine(String(read.stdout)))).toEqual(["restart room"]);
    expect(errors).toBe("");
  });

  test("runs the HTTP server on PostgreSQL, restarts, and rejects a concurrent instance", async () => {
    const stateDir = path.join(root, "http-server");
    mkdirSync(stateDir, { recursive: true });
    await dropSchema();
    const port = await freePort();
    const token = `pg-server-${randomBytes(6).toString("hex")}`;
    const base = `http://127.0.0.1:${port}`;
    const first = startChatServer(stateDir, port, token);
    let restarted: ReturnType<typeof startChatServer> | undefined;
    let second: ReturnType<typeof startChatServer> | undefined;
    try {
      await waitForServer(base, token, first);
      const room = await api(base, token, "/rooms", "POST", { name: "pg server room", ownerId: "owner", sessionID: "owner" }) as { id: string };
      expect(room.id).toBeTruthy();
      const sent = await api(base, token, `/rooms/${encodeURIComponent(room.id)}/messages`, "POST", { sessionID: "owner", text: "server hello" }) as { messages: Array<{ text: string }> };
      expect(sent.messages.at(-1)?.text).toBe("server hello");

      first.child.kill("SIGTERM");
      await exitOf(first.child);
      await sleep(500);

      restarted = startChatServer(stateDir, port, token);
      await waitForServer(base, token, restarted);
      const history = await api(base, token, `/rooms/${encodeURIComponent(room.id)}/history?limit=100`) as { messages: Array<{ text: string }> };
      expect(history.messages.map((message) => message.text)).toContain("server hello");

      second = startChatServer(stateDir, await freePort(), token);
      await Promise.race([
        exitOf(second.child),
        sleep(15_000).then(() => { throw new Error("a second chat-room instance stayed alive on the same PostgreSQL database"); }),
      ]);
      expect(second.child.exitCode).not.toBeNull();
      expect(second.child.exitCode).not.toBe(0);
      expect(second.errors()).toMatch(/single-instance|0\.8\.2/);
    } finally {
      if (restarted) await stopChatServer(restarted);
      if (second) await stopChatServer(second);
      await stopChatServer(first);
    }
  });

  test("migrates empty SQLite state into PostgreSQL", async () => {
    const stateDir = path.join(root, "empty-source");
    mkdirSync(stateDir, { recursive: true });
    delete process.env.CHAT_ROOM_DATABASE_URL;
    process.env.CHAT_ROOM_STATE_DIR = stateDir;
    await closeStateDatabases();
    expect(await store.loadRooms()).toEqual([]);
    await closeStateDatabases();
    await dropSchema();

    const refused = runCli(["migrate"], stateDir);
    expect(refused.status).toBe(1);
    expect(String(refused.stdout)).toContain("sqlite3");
    expect(String(refused.stderr)).toContain("refusing to migrate");
    const migrated = runCli(["migrate", "--to-postgres", "--yes"], stateDir);
    expect(migrated.status).toBe(0);
    expect(String(migrated.stdout)).toContain("migrated 0 messages");

    process.env.CHAT_ROOM_DATABASE_URL = url;
    process.env.CHAT_ROOM_STATE_DIR = stateDir;
    await closeStateDatabases();
    expect(await store.loadRooms()).toEqual([]);
    await closeStateDatabases();
  });

  test("migrates data in FK order, resets the message sequence, and rolls back to SQLite", async () => {
    const stateDir = path.join(root, "migration-source");
    mkdirSync(stateDir, { recursive: true });
    delete process.env.CHAT_ROOM_DATABASE_URL;
    process.env.CHAT_ROOM_STATE_DIR = stateDir;
    await closeStateDatabases();
    const roomID = await store.writeState((service) => {
      const room = service.createRoom("legacy room", "owner");
      service.sendMessage(room.id, "owner", "old one");
      service.sendMessage(room.id, "owner", "old two");
      service.sendMessage(room.id, "owner", "old three");
      return room.id;
    });
    const sourceHistory = await store.readHistory(roomID);
    expect(sourceHistory.messages.map((message) => message.text)).toEqual(["old one", "old two", "old three"]);
    await initializeAdminSchema(store.databasePath());
    await initializeReminderSchema(store.databasePath());
    const sourceDb = await openStateDatabase(store.databasePath());
    const now = Date.now();
    sourceDb.query("INSERT INTO admin_rooms(room_id,target_room_id,session_id,receiver_owner_id,membership_id,generation,enrollment_hash,enrollment_expires,capability_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(roomID, roomID, "admin-session", "admin-owner", "admin-membership", 1, "enrollment-hash", now + 60_000, null, now);
    sourceDb.query("INSERT INTO room_reminders(id,room_id,creator_session_id,text,schedule_type,at,expression,timezone,paused,next_run_at,created_at,initiator) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("reminder-1", roomID, "admin-session", "reminder text", "once", null, null, null, 0, now + 60_000, now, "owner");
    await closeStateDatabases();
    await dropSchema();

    const migrated = runCli(["migrate", "--to-postgres", "--yes"], stateDir);
    expect(migrated.status).toBe(0);
    expect(String(migrated.stdout)).toContain("migrated 3 messages");
    expect(String(migrated.stdout)).toContain("sqlite3");

    process.env.CHAT_ROOM_DATABASE_URL = url;
    process.env.CHAT_ROOM_STATE_DIR = stateDir;
    await closeStateDatabases();
    const rooms = await store.loadRooms();
    expect(rooms.map((room) => room.name)).toEqual(["legacy room"]);
    expect((await store.readHistory(roomID)).messages.map((message) => message.text)).toEqual(["old one", "old two", "old three"]);

    const db = await openStateDatabase(store.databasePath());
    expect(Number((db.query("SELECT COUNT(*) AS count FROM admin_rooms").get() as { count: number }).count)).toBe(1);
    expect(Number((db.query("SELECT COUNT(*) AS count FROM room_reminders").get() as { count: number }).count)).toBe(1);
    const inserted = db.query("INSERT INTO messages(id,room_id,sender_id,text,created_at) VALUES(?,?,?,?,?) RETURNING seq")
      .get("pg-only", roomID, "owner", "written while PostgreSQL is active", Date.now()) as { seq: number };
    expect(inserted.seq).toBe(4);
    await closeStateDatabases();

    const again = runCli(["migrate", "--to-postgres", "--yes"], stateDir);
    expect(again.status).toBe(1);
    expect(String(again.stderr)).toContain("not empty");

    // Rollback switch: SQLite still has the original rows, not the PG-only write.
    delete process.env.CHAT_ROOM_DATABASE_URL;
    process.env.CHAT_ROOM_STATE_DIR = stateDir;
    await closeStateDatabases();
    expect((await store.readHistory(roomID)).messages.map((message) => message.text)).toEqual(["old one", "old two", "old three"]);
    expect((await store.loadRooms())[0]?.messages.some((message) => message.text.includes("PostgreSQL"))).toBe(false);
    await closeStateDatabases();
  });
});