import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { backgroundAtCompatibleRegisteredHost, discoverCompatibleRegisteredHost } from "./background.ts";
import { receiverOwnerID } from "../state/receiver-owner.ts";
import { claimWatcher, closeReceiverState, releaseWatcherClaim, receiverStateDirectory, watcherProcessMayExist } from "../state/receiver-state.ts";
import { databasePath, loadRegistry } from "../state/store.ts";
import { request, type CenterOpts } from "../center/center-client.ts";
import { loadRoomConfig, resolveClientSettings } from "../config/file-config.ts";
import { assertDeliveryLease } from "../center/session-delivery.ts";
import type { QueueTransport } from "../center/queue-transport.ts";
import { pollOwnedSessions } from "./v2-receiver.ts";
import { pollKnownSessions } from "../../plugin.ts";
import { locallyOwnedSessions, reportAgentPresence } from "../agent/agent-presence.ts";
import { flushReceiptCandidates, receiptDestination } from "../agent/agent-receipts.ts";
import { startServer } from "../platform/http-server.ts";

type WatchRecord = { phase: "starting" | "running"; token: string; nonce: string; instanceID: string; pid: number; port?: number; createdAt?: number };
function canonicalPath(value: string): string {
  const suffix: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try { return path.join(realpathSync(current), ...suffix); }
    catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") return path.resolve(value);
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
const clientSettings = () => resolveClientSettings(loadRoomConfig());
const profile = () => {
  const center = clientSettings().url;
  const home = process.env.HOME || os.homedir();
  let target = `standalone:${canonicalPath(databasePath())}`;
  if (center) { try { const url = new URL(center); target = `${url.origin}${url.pathname}`; } catch { target = "invalid-center"; } }
  return createHash("sha256").update(JSON.stringify([os.userInfo().username, home, target])).digest("hex").slice(0, 32);
};
const paths = () => {
  const directory = receiverStateDirectory();
  const id = profile();
  return { directory, state: path.join(directory, `watch-${id}.json`), log: path.join(directory, `watch-${id}.log`) };
};
export function watcherStatePath(): string { return paths().state; }
async function privateDirectory(): Promise<void> {
  const { directory } = paths();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
async function logEvent(event: string): Promise<void> {
  try {
    const { log } = paths();
    await appendFile(log, `${new Date().toISOString()} ${event}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(log, 0o600);
  } catch { /* Logging must not stop message delivery. */ }
}
async function readRecord(): Promise<WatchRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(paths().state, "utf8")) as WatchRecord;
    if (!value || !["starting", "running"].includes(value.phase) || typeof value.token !== "string" ||
      typeof value.nonce !== "string" || typeof value.instanceID !== "string" || !Number.isInteger(value.pid) || value.pid! < 1 ||
      (value.phase === "running" && (!Number.isInteger(value.port) || value.port! < 1 || value.port! > 65535))) return undefined;
    return value;
  } catch { return undefined; }
}
async function stateFileExists(): Promise<boolean> {
  try { await readFile(paths().state); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function saveRecord(record: WatchRecord, exclusive = false, beforePublish?: () => Promise<void>): Promise<void> {
  await privateDirectory();
  const temp = `${paths().state}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await beforePublish?.();
    if (exclusive) await link(temp, paths().state); else await rename(temp, paths().state);
    await chmod(paths().state, 0o600);
  } finally { await unlink(temp).catch(() => {}); }
}
async function removeRecord(token: string, nonce: string): Promise<void> {
  const current = await readRecord();
  if (current?.token === token && current.nonce === nonce) await unlink(paths().state).catch(() => {});
}
async function reserveWatcher(record: WatchRecord, beforePublish?: () => Promise<void>): Promise<"claimed" | "existing" | "invalid"> {
  const previous = await readRecord();
  if (!previous && await stateFileExists()) return "invalid";
  if (previous && watcherProcessMayExist(previous.pid)) return "existing";
  if (!claimWatcher(profile(), record.instanceID, record.pid)) return "existing";
  if (previous) {
    const current = await readRecord();
    if (current?.token !== previous.token || current.nonce !== previous.nonce) {
      releaseWatcherClaim(profile(), record.instanceID);
      return "existing";
    }
    await unlink(paths().state).catch(() => {});
  }
  try { await saveRecord(record, true, beforePublish); }
  catch {
    releaseWatcherClaim(profile(), record.instanceID);
    return await stateFileExists() ? "existing" : "invalid";
  }
  return "claimed";
}
function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Host = NonNullable<Awaited<ReturnType<typeof discoverCompatibleRegisteredHost>>>;
export type WatchSweepDeps = {
  discover(): Promise<Host | undefined>;
  owner(host: Host): Promise<string | undefined>;
  flush?(ownerID: string): Promise<void>;
  memberships(ownerID: string): Promise<Set<string>>;
  presence?(ids: ReadonlySet<string>, host: Host, ownerID: string): Promise<void>;
  poll(ids: ReadonlySet<string>, host: Host, ownerID: string): Promise<void>;
};
export async function watcherSweep(deps: WatchSweepDeps = defaultSweepDeps()): Promise<boolean> {
  const host = await deps.discover().catch(() => undefined);
  if (!host) return false;
  const ownerID = await deps.owner(host).catch(() => undefined);
  if (!ownerID) return false;
  const ids = await deps.memberships(ownerID).catch(() => undefined);
  if (!ids) return true;
  await deps.presence?.(ids, host, ownerID).catch(() => {});
  if (!ids.size) { await deps.flush?.(ownerID).catch(() => {}); return true; }
  await deps.poll(ids, host, ownerID);
  return true;
}

function defaultSweepDeps(): WatchSweepDeps {
  const settings = clientSettings();
  const center: CenterOpts = {
    center: settings.url,
    token: settings.token,
  };
  return {
    discover: discoverCompatibleRegisteredHost,
    owner: (host) => receiverOwnerID(host.origin),
    flush: (ownerID) => flushReceiptCandidates({ destination: receiptDestination(center.center), receiverOwnerID: ownerID,
      ...(center.center ? { center: center.center, token: center.token } : {}) }),
    memberships: async (ownerID) => {
      if (center.center) {
        const result = await request(center, `/receiver/memberships?ownerID=${encodeURIComponent(ownerID)}`, "GET") as { sessionIDs?: string[] };
        return new Set(result.sessionIDs ?? []);
      }
      const registry = await loadRegistry();
      return locallyOwnedSessions(registry, ownerID);
    },
    presence: (ids, host, ownerID) => reportAgentPresence({
      host, ownerID, center, sessionIDs: ids,
      current: async () => {
        const current = await discoverCompatibleRegisteredHost();
        return Boolean(current && current.origin === host.origin && current.pid === host.pid && current.version === host.version);
      },
    }),
    poll: (ids, host, ownerID) => {
      const transport: QueueTransport = {
        protocol: "v2", receiverOwnerID: ownerID, mentionOnlySessions: ids,
        backgroundSession: (id) => backgroundAtCompatibleRegisteredHost(id, host),
        promptQueue: async (sessionID, id, text, delivery) => {
          const current = await discoverCompatibleRegisteredHost();
          if (!current || current.origin !== host.origin || current.pid !== host.pid || current.version !== host.version) {
            throw Object.assign(new Error("registered OpenCode service changed"), { status: 409 });
          }
          assertDeliveryLease();
          return current.client.session.prompt({ sessionID, id, text, delivery, resume: true }, { signal: AbortSignal.timeout(1500) });
        },
      };
      return pollOwnedSessions(ids, (owned) => pollKnownSessions(owned, transport, center));
    },
  };
}

async function control(record: WatchRecord, stop = false): Promise<boolean> {
  if (record.phase !== "running" || !record.port || !watcherProcessMayExist(record.pid)) return false;
  try {
    const base = `http://127.0.0.1:${record.port}`;
    const headers = { Authorization: `Bearer ${record.token}` };
    const response = await fetch(`${base}/status`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    const status = await response.json().catch(() => undefined);
    if (!response.ok || !sameController(status, record, "running")) return false;
    if (!stop) return true;
    const stopped = await fetch(`${base}/stop`, {
      method: "POST",
      headers: { ...headers, "x-watcher-instance": record.instanceID, "x-watcher-nonce": record.nonce, "x-watcher-pid": String(record.pid) },
      signal: AbortSignal.timeout(1500),
    });
    const acknowledgement = await stopped.json().catch(() => undefined);
    return stopped.status === 202 && sameController(acknowledgement, record, "stopping");
  } catch { return false; }
}

function sameController(value: unknown, record: WatchRecord, status: string): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return body.status === status && body.pid === record.pid &&
    body.instanceID === record.instanceID && body.nonce === record.nonce;
}

// Run the same entry script that started this process. A relative ../cli.ts
// only exists in the source layout; inside dist/cli.js it would point outside
// the package (and Node cannot run a .ts daemon from node_modules).
function cliEntryPath(): string {
  // Installed packages run through a bin shim (node_modules/.bin/...), so resolve
  // the symlink before checking the file name; the shim itself is not cli.js.
  const argv = process.argv[1];
  if (argv) {
    let resolved = path.resolve(argv);
    try { resolved = realpathSync(resolved); } catch { /* keep the resolved path */ }
    if (/^cli\.(?:ts|js)$/.test(path.basename(resolved))) return resolved;
  }
  const candidates = [
    fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
    fileURLToPath(new URL("../../cli.ts", import.meta.url)),
    fileURLToPath(new URL("../cli.js", import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export async function watchStatus(): Promise<"running" | "stopped" | "unavailable" | "starting"> {
  const record = await readRecord();
  if (!record) {
    try { await readFile(paths().state); return "unavailable"; }
    catch { return "stopped"; }
  }
  if (record.phase === "starting") return watcherProcessMayExist(record.pid) && Date.now() - (record.createdAt ?? 0) < 30_000 ? "starting" : "unavailable";
  return await control(record) ? "running" : "unavailable";
}

// readyTimeoutMs is a test seam so the timeout cleanup can be exercised quickly.
export async function startWatcher(beforePublish?: () => Promise<void>, readyTimeoutMs = 20_000): Promise<string> {
  await privateDirectory();
  const own: WatchRecord = { phase: "starting", token: randomBytes(32).toString("base64url"), nonce: randomBytes(16).toString("hex"), instanceID: randomBytes(16).toString("hex"), pid: process.pid, createdAt: Date.now() };
  const reservation = await reserveWatcher(own, beforePublish);
  if (reservation !== "claimed") {
    if (reservation === "invalid") throw new Error("watcher state is unreadable; remove the private stale state file manually");
    const existing = await readRecord();
    if (existing?.phase === "running") {
      if (await control(existing)) return "watcher already running";
      throw new Error("watcher control endpoint is unavailable; no process was signaled");
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await readRecord();
      if (current?.phase === "running" && await control(current)) return "watcher already running";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("watcher state exists or is starting; no process was signaled");
  }
  const cli = cliEntryPath();
  let childError: Error | undefined;
  const child = spawn(process.execPath, [cli, "watch", "run"], {
    detached: true, stdio: "ignore",
    env: { ...process.env, CHAT_ROOM_WATCH_CONTROL_TOKEN: own.token, CHAT_ROOM_WATCH_START_NONCE: own.nonce, CHAT_ROOM_WATCH_INSTANCE_ID: own.instanceID },
  });
  child.once("error", (error) => { childError = error; });
  child.unref();
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (childError) { await removeRecord(own.token, own.nonce); releaseWatcherClaim(profile(), own.instanceID); throw childError; }
    const record = await readRecord();
    if (record?.token === own.token && record.nonce === own.nonce && record.phase === "running" && await control(record)) {
      return "watcher started";
    }
    if (child.exitCode !== null) {
      await removeRecord(own.token, own.nonce);
      releaseWatcherClaim(profile(), own.instanceID);
      throw new Error("watcher exited before its control endpoint became ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Leaving the child alive would keep the pid claim and block every later
  // start, so stop it and release this attempt instead of only throwing.
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    // Give the dying daemon a bounded moment to finish its shutdown sweep so a
    // new start cannot overlap it while the old pid still holds leases.
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  await removeRecord(own.token, own.nonce);
  releaseWatcherClaim(profile(), own.instanceID);
  throw new Error("watcher did not become ready; its process was stopped");
}

export async function stopWatcher(): Promise<string> {
  const record = await readRecord();
  if (!record) {
    try { await readFile(paths().state); }
    catch { return "watcher stopped"; }
    throw new Error("watcher state is unreadable; no process was signaled");
  }
  if (record.phase !== "running" || !await control(record, true)) {
    throw new Error("watcher control endpoint is unavailable; no process was signaled");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await readRecord();
    if (!current || current.nonce !== record.nonce) return "watcher stopped";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("watcher accepted stop but has not finished shutdown");
}

export async function runWatcher(): Promise<void> {
  let token = process.env.CHAT_ROOM_WATCH_CONTROL_TOKEN;
  let nonce = process.env.CHAT_ROOM_WATCH_START_NONCE;
  let instanceID = process.env.CHAT_ROOM_WATCH_INSTANCE_ID;
  const managed = typeof token === "string" && typeof nonce === "string" && typeof instanceID === "string";
  let createdAt = Date.now();
  if (!managed) {
    token = randomBytes(32).toString("base64url");
    nonce = randomBytes(16).toString("hex");
    instanceID = randomBytes(16).toString("hex");
    const record: WatchRecord = { phase: "starting", token, nonce, instanceID, pid: process.pid, createdAt };
    if (await reserveWatcher(record) !== "claimed") throw new Error("watcher already running or stale state requires manual cleanup");
  } else {
    const existing = await readRecord();
    if (existing?.phase !== "starting" || existing.token !== token || existing.nonce !== nonce || existing.instanceID !== instanceID) {
      throw new Error(`watcher startup ownership check failed (state=${existing?.phase ?? "missing"})`);
    }
    if (!claimWatcher(profile(), instanceID, process.pid)) throw new Error("watcher ownership transfer failed");
    createdAt = existing.createdAt ?? createdAt;
    await saveRecord({ ...existing, pid: process.pid });
  }
  delete process.env.CHAT_ROOM_WATCH_CONTROL_TOKEN;
  delete process.env.CHAT_ROOM_WATCH_START_NONCE;
  delete process.env.CHAT_ROOM_WATCH_INSTANCE_ID;

  let shuttingDown = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let activeSweep: Promise<unknown> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (interval) clearInterval(interval);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await activeSweep?.catch(() => {});
    await logEvent("stopped");
    await server?.close();
    await removeRecord(token!, nonce!);
    try { releaseWatcherClaim(profile(), instanceID!); } catch { /* Dead process detection reclaims the row next time. */ }
    closeReceiverState();
    finish();
  };
  const onSignal = () => { void stop(); };
  const controlServer = await startServer({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!authorized(request, token!)) return new Response("Unauthorized", { status: 401 });
      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json({ status: "running", pid: process.pid, instanceID, nonce });
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        if (request.headers.get("x-watcher-instance") !== instanceID ||
          request.headers.get("x-watcher-nonce") !== nonce || request.headers.get("x-watcher-pid") !== String(process.pid)) {
          return new Response("Watcher identity mismatch", { status: 409 });
        }
        setTimeout(() => { void stop(); }, 25);
        return Response.json({ status: "stopping", pid: process.pid, instanceID, nonce }, { status: 202 });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  server = controlServer;
  try {
    await saveRecord({ phase: "running", token, nonce, instanceID: instanceID!, pid: process.pid, port: controlServer.port, createdAt });
  } catch (error) {
    await controlServer.close();
    await removeRecord(token, nonce);
    releaseWatcherClaim(profile(), instanceID!);
    throw error;
  }
  await logEvent("started");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const sweep = () => {
    if (shuttingDown || activeSweep) return;
    activeSweep = watcherSweep().catch(() => { void logEvent("poll-error"); }).finally(() => { activeSweep = undefined; });
  };
  interval = setInterval(sweep, 5000);
  interval.unref?.();
  sweep();
  console.log("watcher running");
  await done;
}
