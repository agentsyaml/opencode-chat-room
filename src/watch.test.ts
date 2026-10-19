import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";

const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete process.env[key];
const root = mkdtempSync(path.join(tmpdir(), "chat-room-watch-"));
process.env.HOME = path.join(root, "home");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.CHAT_ROOM_STATE_DIR = path.join(root, "rooms");
const { startWatcher, stopWatcher, watchStatus, watcherStatePath, watcherSweep } = await import("./watch");
const { closeReceiverState } = await import("./receiver-state");

describe.serial("resident V2 watcher", () => {
  test("keeps retrying while the service is offline and resumes when it appears", async () => {
    let available = false;
    let delivered = 0;
    const host = { origin: "http://127.0.0.1:54321", pid: 42, version: "2.0.29" } as never;
    const deps = {
      discover: async () => available ? host : undefined,
      owner: async () => "owner",
      memberships: async () => new Set(["joined"]),
      poll: async (ids: ReadonlySet<string>) => { expect([...ids]).toEqual(["joined"]); delivered++; },
    };
    expect(await watcherSweep(deps)).toBe(false);
    expect(delivered).toBe(0);
    available = true;
    expect(await watcherSweep(deps)).toBe(true);
    expect(delivered).toBe(1);
  });

  test("starts idempotently, authenticates control, and stops gracefully", async () => {
    expect((await Promise.all([startWatcher(), startWatcher()])).sort()).toEqual(["watcher already running", "watcher started"]);
    expect(await watchStatus()).toBe("running");
    expect(await startWatcher()).toBe("watcher already running");
    const directory = path.join(process.env.XDG_STATE_HOME!, "opencode", "chat-room");
    const stateFile = (await fs.readdir(directory)).find((name) => /^watch-.*\.json$/.test(name))!;
    const file = path.join(directory, stateFile);
    const record = JSON.parse(await fs.readFile(file, "utf8")) as { port: number; token: string; pid: number; instanceID: string; nonce: string };
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fetch(`http://127.0.0.1:${record.port}/status`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${record.port}/status`, { headers: { Authorization: "Bearer wrong-token" } })).status).toBe(401);
    const status = await fetch(`http://127.0.0.1:${record.port}/status`, { headers: { Authorization: `Bearer ${record.token}` } }).then((r) => r.json());
    expect(status).toMatchObject({ status: "running", pid: record.pid, instanceID: record.instanceID, nonce: record.nonce });
    for (const headers of [
      { "x-watcher-instance": "wrong", "x-watcher-nonce": record.nonce, "x-watcher-pid": String(record.pid) },
      { "x-watcher-instance": record.instanceID, "x-watcher-nonce": "wrong", "x-watcher-pid": String(record.pid) },
      { "x-watcher-instance": record.instanceID, "x-watcher-nonce": record.nonce, "x-watcher-pid": String(record.pid + 1) },
    ]) {
      expect((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: "POST", headers: { Authorization: `Bearer ${record.token}`, ...headers } })).status).toBe(409);
      expect(await watchStatus()).toBe("running");
    }
    expect(await stopWatcher()).toBe("watcher stopped");
    expect(await watchStatus()).toBe("stopped");
    const log = await fs.readFile(path.join(directory, stateFile.replace(".json", ".log")), "utf8");
    expect(log).toContain("started");
    expect(log).toContain("stopped");
    expect(log).not.toContain(record.token);
  });

  test("uses the resolved standalone database path for watcher identity", async () => {
    const cwd = process.cwd(), priorStateDir = process.env.CHAT_ROOM_STATE_DIR, priorConfig = process.env.XDG_CONFIG_HOME;
    const common = path.join(root, "same-db");
    try {
      process.chdir(root);
      process.env.CHAT_ROOM_STATE_DIR = "same-db/opencode/chat-room";
      expect(await startWatcher()).toBe("watcher started");
      delete process.env.CHAT_ROOM_STATE_DIR;
      process.env.XDG_CONFIG_HOME = common;
      expect(await watchStatus()).toBe("running");
      expect(await startWatcher()).toBe("watcher already running");
      await stopWatcher();
      process.env.XDG_CONFIG_HOME = path.join(root, "different-db");
      expect(await watchStatus()).toBe("stopped");
      expect(await startWatcher()).toBe("watcher started");
      await stopWatcher();
    } finally {
      process.env.CHAT_ROOM_STATE_DIR = "same-db/opencode/chat-room";
      delete process.env.XDG_CONFIG_HOME;
      await stopWatcher().catch(() => {});
      delete process.env.CHAT_ROOM_STATE_DIR;
      process.env.XDG_CONFIG_HOME = common;
      await stopWatcher().catch(() => {});
      process.env.XDG_CONFIG_HOME = path.join(root, "different-db");
      await stopWatcher().catch(() => {});
      if (priorStateDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR; else process.env.CHAT_ROOM_STATE_DIR = priorStateDir;
      if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorConfig;
      process.chdir(cwd);
    }
  });

  test("a concurrent start waits for complete atomic state publication", async () => {
    let entered!: () => void, release!: () => void;
    const atTemp = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = startWatcher(async () => { entered(); await blocked; });
    let secondResult: string | undefined;
    let second: Promise<string> | undefined;
    try {
      await atTemp;
      const directory = path.join(process.env.XDG_STATE_HOME!, "opencode", "chat-room");
      expect((await fs.readdir(directory)).filter((name) => name.startsWith("watch-") && name.endsWith(".json"))).toHaveLength(0);
      second = startWatcher().then((result) => { secondResult = result; return result; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondResult).toBeUndefined();
      release();
      expect(await first).toBe("watcher started");
      expect(await second).toBe("watcher already running");
      expect(await watchStatus()).toBe("running");
    } finally {
      release();
      await first.catch(() => {});
      await second?.catch(() => {});
      await stopWatcher().catch(() => {});
    }
  });

  test("reclaims a watcher record only after its own process is dead", async () => {
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, cli, "watch", "run"], { env: { ...process.env }, stdout: "ignore", stderr: "ignore" });
    const readyBy = Date.now() + 10_000;
    while (Date.now() < readyBy && await watchStatus() !== "running") await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await watchStatus()).toBe("running");
    const directory = path.join(process.env.XDG_STATE_HOME!, "opencode", "chat-room");
    const file = path.join(directory, (await fs.readdir(directory)).find((name) => /^watch-.*\.json$/.test(name))!);
    const previous = JSON.parse(await fs.readFile(file, "utf8")) as { pid: number; instanceID: string };
    expect(previous.pid).toBe(child.pid);
    process.kill(child.pid, "SIGKILL");
    await child.exited;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(previous.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await watchStatus()).toBe("unavailable");
    expect(await startWatcher()).toBe("watcher started");
    const current = JSON.parse(await fs.readFile(file, "utf8")) as { instanceID: string };
    expect(current.instanceID).not.toBe(previous.instanceID);
    expect(await watchStatus()).toBe("running");
    await stopWatcher();
  });

  test("stale control state never signals its recorded pid", async () => {
    const file = watcherStatePath();
    const stale = { phase: "running", token: "stale-token", nonce: "stale-nonce", instanceID: "stale-instance", pid: process.pid, port: 65534 };
    await fs.writeFile(file, JSON.stringify(stale), { mode: 0o600 });
    expect(await watchStatus()).toBe("unavailable");
    await expect(stopWatcher()).rejects.toThrow("no process was signaled");
    await expect(startWatcher()).rejects.toThrow("no process was signaled");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(stale);
    await fs.unlink(file);
    const legacy = { phase: "running", token: "legacy-token", nonce: "legacy-nonce", port: 65534 };
    await fs.writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
    expect(await watchStatus()).toBe("unavailable");
    await expect(stopWatcher()).rejects.toThrow("no process was signaled");
    await expect(startWatcher()).rejects.toThrow("manually");
    await fs.unlink(file);
  });

  test("a generic HTTP 200 is not a watcher and cannot receive stop", async () => {
    const directory = path.join(process.env.XDG_STATE_HOME!, "opencode", "chat-room");
    const file = watcherStatePath();
    const record: { phase: "running"; token: string; nonce: string; instanceID: string; pid: number; port: number } = {
      phase: "running", token: "private-control-token", nonce: "nonce-good", instanceID: "instance-good", pid: process.pid, port: 0,
    };
    let body: Record<string, unknown> = {};
    let statusRequests = 0, stopRequests = 0;
    const unrelated = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/status") { statusRequests++; return Response.json(body); }
      if (new URL(request.url).pathname === "/stop") {
        stopRequests++;
        const h = request.headers;
        if (h.get("Authorization") !== `Bearer ${record.token}` || h.get("x-watcher-instance") !== record.instanceID ||
          h.get("x-watcher-nonce") !== record.nonce || h.get("x-watcher-pid") !== String(record.pid)) return new Response(null, { status: 409 });
        void fs.unlink(file).catch(() => {});
        return Response.json({ status: "stopping", pid: record.pid, instanceID: record.instanceID, nonce: record.nonce }, { status: 202 });
      }
      return new Response(null, { status: 404 });
    } });
    record.port = unrelated.port!;
    await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
    const matching = { status: "running", pid: record.pid, instanceID: record.instanceID, nonce: record.nonce };
    try {
      for (const altered of [
        { ...matching, pid: record.pid + 1 },
        { ...matching, instanceID: "other-instance" },
        { ...matching, nonce: "other-nonce" },
      ]) {
        body = altered;
        expect(await watchStatus()).toBe("unavailable");
        await expect(stopWatcher()).rejects.toThrow("no process was signaled");
      }
      expect(statusRequests).toBe(6);
      expect(stopRequests).toBe(0);
      body = matching;
      expect(await watchStatus()).toBe("running");
      expect(await stopWatcher()).toBe("watcher stopped");
      expect(stopRequests).toBe(1);
    } finally {
      unrelated.stop(true);
      await fs.unlink(file).catch(() => {});
    }
  });
});

afterAll(async () => {
  await stopWatcher().catch(() => {});
  closeReceiverState();
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});
