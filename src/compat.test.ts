import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { pushItemsToSession } from "./center-inbox";
import { createQueueTransport, sendAsyncNotification, sendQueue, type QueueTransport } from "./queue-transport";
import { loadRegistry, saveRegistry } from "./store";
import { createNotifier } from "./plugin-notifications";
import { createV1Server } from "./v1-plugin";
import { wakeSessions } from "./center-wake";

const originalFetch = globalThis.fetch;
const originalStateDir = process.env.CHAT_ROOM_STATE_DIR;
const originalCenterUrl = process.env.CHAT_ROOM_SERVER_URL;
const originalCenterToken = process.env.CHAT_ROOM_SERVER_TOKEN;
const originalWakeUrl = process.env.CHAT_ROOM_WAKE_SERVE_URL;
const temp = await mkdtemp(path.join(os.tmpdir(), "chat-room-compat-"));
process.env.CHAT_ROOM_STATE_DIR = temp;
delete process.env.CHAT_ROOM_SERVER_URL;
delete process.env.CHAT_ROOM_SERVER_TOKEN;
delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
const { default: plugin, id, pollKnownSessions, server, setup } = await import("../plugin");

beforeEach(() => {
  process.env.CHAT_ROOM_STATE_DIR = temp;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function browserAuth(storage: Storage, fetcher: typeof fetch) {
  const html = await readFile(path.join(process.cwd(), "server/chat.html"), "utf8");
  const storeStart = html.indexOf("  const memStore = Object.create(null);");
  const storeEnd = html.indexOf("\n\n  const I18N", storeStart);
  const apiStart = html.indexOf("  async function api(");
  const apiEnd = html.indexOf("\n\n  /* ---------- 状态", apiStart);
  if ([storeStart, storeEnd, apiStart, apiEnd].some((index) => index < 0)) throw new Error("chat auth code not found");
  const context: any = { localStorage: storage, fetch: fetcher, t: (key: string) => key };
  runInNewContext(`${html.slice(storeStart, storeEnd)}\n${html.slice(apiStart, apiEnd)}\nglobalThis.auth = { LS, saveToken, api };`, context);
  return context.auth as { LS: { token: string }; saveToken(value: string): string; api(path: string, options?: RequestInit): Promise<any> };
}

function wakeTransport(sessionID: string, sent: () => void): QueueTransport {
  return {
    protocol: "v2",
    promptQueue: async (target, id, text) => {
      expect(target).toBe(sessionID);
      sent();
      return { id, sessionID: target, type: "user", time: { created: 20 }, delivery: "queue", payload: { text } };
    },
  };
}

function centerFetch(options: { beforeSummary?: (count: number) => Promise<void>; failFirst?: boolean }) {
  let summaries = 0;
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/rooms/summary") {
      summaries++;
      if (options.failFirst && summaries === 1) throw new Error("offline");
      await options.beforeSummary?.(summaries);
      return Response.json([{ id: "wake-room", latestMsgTs: 20 }]);
    }
    if (url.pathname === "/rooms/wake-room/registry") return Response.json({
      recipient: { name: "recipient", host: os.hostname(), lastReadTs: 0, directory: temp },
    });
    if (url.pathname === "/inbox") return Response.json({
      items: [{ id: "wake-message", roomId: "wake-room", roomName: "Wake", senderId: "sender", text: "hello", createdAt: 20 }],
      queuedTs: {},
    });
    return Response.json({});
  };
  return { fetcher: fetcher as unknown as typeof fetch, summaries: () => summaries };
}

describe.serial("OpenCode compatibility transports", () => {
  test.serial("web auth saves through storage failure, recovers 401, reloads token, and supports open servers", async () => {
    const requests: Array<{ path: string; authorization: string }> = [];
    const protectedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      requests.push({ path: String(input), authorization });
      return authorization === "Bearer valid-token"
        ? Response.json({ ok: true })
        : Response.json({ error: "unauthorized" }, { status: 401 });
    }) as unknown as typeof fetch;
    const brokenStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); },
      removeItem: () => { throw new Error("storage unavailable"); },
    } as unknown as Storage;
    const brokenAuth = await browserAuth(brokenStorage, protectedFetch);
    await expect(brokenAuth.api("/rooms")).rejects.toMatchObject({ status: 401 });
    const tokenInput = { value: " valid-token " };
    tokenInput.value = brokenAuth.saveToken(tokenInput.value);
    expect(tokenInput.value).toBe("valid-token");
    expect(brokenAuth.LS.token).toBe("valid-token");
    await brokenAuth.api("/rooms");
    await brokenAuth.api("/rooms/room-id/join", { method: "POST", body: "{}" });
    await brokenAuth.api("/inbox?sessionID=session-id");
    expect(requests.map((request) => request.authorization)).toEqual([
      "", "Bearer valid-token", "Bearer valid-token", "Bearer valid-token",
    ]);

    const values = new Map<string, string>();
    const persistentStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    const staleAuth = await browserAuth(persistentStorage, protectedFetch);
    staleAuth.saveToken("stale-token");
    await expect(staleAuth.api("/rooms")).rejects.toMatchObject({ status: 401 });
    staleAuth.saveToken("valid-token");
    await staleAuth.api("/rooms");
    const reloadedAuth = await browserAuth(persistentStorage, protectedFetch);
    expect(reloadedAuth.LS.token).toBe("valid-token");
    await reloadedAuth.api("/rooms/room-id/join", { method: "POST", body: "{}" });

    const openRequests: string[] = [];
    const openAuth = await browserAuth({
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    } as unknown as Storage, (async (_input: string | URL | Request, init?: RequestInit) => {
      openRequests.push(new Headers(init?.headers).get("Authorization") ?? "");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch);
    await openAuth.api("/rooms");
    expect(openRequests).toEqual([""]);
  });

  test.serial("transport does not guess a local server URL", () => {
    expect(createQueueTransport().serverUrl).toBeUndefined();
  });

  test.serial("V1 server entrypoint registers the room tool", async () => {
    const hooks = await server({
      serverUrl: new URL("http://v1.example"),
      directory: temp,
    } as any);
    expect(hooks.tool?.room).toBeDefined();
    expect(await hooks.tool!.room!.execute({ action: "list" }, { sessionID: "v1-entry" } as any)).toBe("no rooms yet");
    await hooks.dispose?.();
  });

  test.serial("V1 chat hook awaits metadata but not the inbox fetch", async () => {
    let finishObserve!: () => void;
    let finishInbox!: () => void;
    let inboxStarted = false;
    const observeWait = new Promise<void>((resolve) => { finishObserve = resolve; });
    const inboxWait = new Promise<void>((resolve) => { finishInbox = resolve; });
    const runtime: any = { protocol: "v1", selfServerUrl: "", selfDirectory: temp, transport: {}, center: { center: "", token: "", directory: temp } };
    const makeHooks = (checkInbox: () => Promise<void>) => createV1Server({
      runtime: () => runtime,
      run: (_runtime, callback) => callback(),
      room: {} as any,
      observe: async () => observeWait,
      checkInbox: async () => { inboxStarted = true; await checkInbox(); },
      wake: async () => {},
      central: true,
    })({ serverUrl: new URL("http://v1.example"), directory: temp } as any);
    const hooks = await makeHooks(async () => inboxWait);
    let finished = false;
    const request = hooks["chat.message"]!({ sessionID: "observed" }, {} as any).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(inboxStarted).toBe(false);
    finishObserve();
    await request;
    expect(inboxStarted).toBe(true);
    finishInbox();
    await hooks.dispose?.();
  });

  test.serial("V1 chat hook handles a rejected fire-and-forget inbox check", async () => {
    const runtime: any = { protocol: "v1", selfServerUrl: "", selfDirectory: temp, transport: {}, center: { center: "", token: "", directory: temp } };
    const hooks = await createV1Server({
      runtime: () => runtime,
      run: (_runtime, callback) => callback(),
      room: {} as any,
      observe: async () => {},
      checkInbox: async () => { throw new Error("offline"); },
      wake: async () => {},
      central: true,
    })({ serverUrl: new URL("http://v1.example"), directory: temp } as any);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await hooks["chat.message"]!({ sessionID: "observed" }, {} as any);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      await hooks.dispose?.();
    }
  });

  test.serial("V1 async HTTP acceptance and failure are distinguished", async () => {
    let body = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://v1.example/session/sess/prompt_async");
      body = String(init?.body);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(await sendAsyncNotification({ serverUrl: "http://v1.example" }, "sess", "notice")).toBe("delivered");
    expect(JSON.parse(body)).toEqual({ parts: [{ type: "text", text: "notice" }] });
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    expect(await sendAsyncNotification({ serverUrl: "http://v1.example" }, "sess", "notice")).toBe("rejected");
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    expect(await sendAsyncNotification({ serverUrl: "http://v1.example" }, "sess", "notice")).toBe("rejected");
  });

  test.serial("central inbox dispatches V1 notifications asynchronously and keeps failures unread", async () => {
    const item = { roomId: "r", roomName: "room", senderId: "alice", text: "hello", createdAt: 10 };
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      return Response.json({});
    }) as unknown as typeof fetch;
    expect(await pushItemsToSession({ center: "http://center", token: "" }, "v1-session", [item], {
      serverUrl: "http://v1.example", protocol: "v1",
    })).toBe("delivered");
    expect(calls.some((url) => url.endsWith("/prompt_async"))).toBe(true);
    expect(calls).toContain("http://v1.example/session/v1-session/prompt_async");
    expect(calls.some((url) => url.endsWith("/queued"))).toBe(true);

    calls.length = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/prompt_async")) return new Response(null, { status: 503 });
      return Response.json({});
    }) as unknown as typeof fetch;
    expect(await pushItemsToSession({ center: "http://center", token: "" }, "v1-failed", [item], {
      serverUrl: "http://v1.example", protocol: "v1",
    })).toBe("rejected");
    expect(calls.some((url) => url.endsWith("/queued"))).toBe(false);
  });

  test.serial("V1 notification logs the root prompt_async endpoint", async () => {
    await saveRegistry({ logged: {
      "v1-log-target": { name: "target", serverUrl: "http://v1.example/", apiPrefix: "", protocol: "v1", lastReadTs: 0 },
    } });
    let sentUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      sentUrl = String(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const notifier = createNotifier({
      transport: () => ({ protocol: "v1" }),
      bumpQueued: async () => true,
    });
    await notifier.notifyRoom("logged", "room", "", "sender", [
      { id: "m", roomId: "logged", senderId: "alice", senderSessionID: "sender", text: "hello", createdAt: 100 },
    ]);
    expect(sentUrl).toBe("http://v1.example/session/v1-log-target/prompt_async");
    expect(await readFile(path.join(temp, "notify.log"), "utf8")).toContain(sentUrl);
  });

  test.serial("V2 exposes tool and command and uses persistent queue prompt", async () => {
    expect(plugin).toMatchObject({ id: "chat-room", server, setup });
    expect(id).toBe("chat-room");
    let registeredTool: any;
    let registeredCommand: any;
    const prompts: unknown[] = [];
    const context: any = {
      location: { directory: temp },
      session: { prompt: async (input: unknown) => { prompts.push(input); return { id: "q", sessionID: "s", type: "user", time: { created: 1 }, delivery: "queue", payload: { text: "queued" } }; }, hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn: (editor: any) => void) => fn({ add: (value: unknown) => { registeredTool = value; } }) },
      command: { transform: async (fn: (editor: any) => void) => fn({ add: (value: unknown) => { registeredCommand = value; } }) },
    };
    const cleanup = await setup(context);
    expect(registeredTool.description).toContain("Chat room");
    expect(registeredTool.name).toBe("room");
    expect(registeredTool.options).toMatchObject({ codemode: false });
    expect(registeredCommand.name).toBe("room");
    await registeredTool.execute({ action: "list" }, { sessionID: "s" });
    await registeredCommand.execute({ sessionID: "s", prompt: { text: "list", files: [{ uri: "file:///note.txt" }], agents: [], skills: [] }, delivery: "queue" });
    expect(prompts[0]).toMatchObject({ sessionID: "s", text: "list\n\nThe user invoked /room. Use the room tool to perform this command." });
    expect(prompts[0]).toMatchObject({ files: [{ uri: "file:///note.txt" }], delivery: "queue" });
    await cleanup();
  });

  test.serial("V2 queue acceptance requires the returned admission identity", async () => {
    const seen: unknown[] = [];
    const transport = {
      promptQueue: async (sessionID: string, id: string, text: string) => {
        seen.push({ sessionID, id, text });
        return { id, sessionID, type: "user", time: { created: 1 }, delivery: "queue", payload: { text } };
      },
    };
    expect(await sendQueue(transport, "s", "notice", "admission")).toBe("delivered");
    expect(seen).toEqual([{ sessionID: "s", id: "admission", text: "notice" }]);
    expect(await sendQueue({ promptQueue: async () => ({}) }, "s", "notice", "admission")).toBe("rejected");
  });

  test.serial("V2 HTTP queue request uses the flat public payload", async () => {
    let received: unknown;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      received = JSON.parse(String(init?.body));
      return Response.json({
        id: "http-admission", sessionID: "http-session", time: { created: 1 },
        type: "user", delivery: "queue", payload: { text: "notice" },
      });
    }) as unknown as typeof fetch;
    expect(await sendQueue({ serverUrl: "http://v2.example", protocol: "v2" }, "http-session", "notice", "http-admission")).toBe("delivered");
    expect(received).toEqual({ id: "http-admission", text: "notice", delivery: "queue", resume: true });
  });

  test.serial("concurrent V2 wake scans remain isolated by runtime", async () => {
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = centerFetch({ beforeSummary: async (count) => { if (count === 1) { started(); await gate; } } });
    globalThis.fetch = fake.fetcher;
    let sentA = 0;
    let sentB = 0;
    const opts = { center: "http://center", token: "", directory: temp };
    const first = wakeSessions(opts, wakeTransport("A", () => sentA++), "", new Set());
    await firstStarted;
    await wakeSessions(opts, wakeTransport("recipient", () => sentB++), "", new Set(["recipient"]));
    release();
    await first;
    expect(sentA).toBe(0);
    expect(sentB).toBe(1);
    expect(fake.summaries()).toBe(2);
  });

  test.serial("wake scans still suppress overlap for the same runtime", async () => {
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = centerFetch({ beforeSummary: async (count) => { if (count === 1) { started(); await gate; } } });
    globalThis.fetch = fake.fetcher;
    let sent = 0;
    const transport = wakeTransport("recipient", () => sent++);
    const opts = { center: "http://center", token: "", directory: temp };
    const first = wakeSessions(opts, transport, "", new Set(["recipient"]));
    await firstStarted;
    await wakeSessions(opts, transport, "", new Set(["recipient"]));
    expect(fake.summaries()).toBe(1);
    release();
    await first;
    expect(sent).toBe(1);
  });

  test.serial("a failed wake scan releases its runtime guard for retry", async () => {
    const fake = centerFetch({ failFirst: true });
    globalThis.fetch = fake.fetcher;
    let sent = 0;
    const transport = wakeTransport("recipient", () => sent++);
    const opts = { center: "http://center", token: "", directory: temp };
    await wakeSessions(opts, transport, "", new Set(["recipient"]));
    await wakeSessions(opts, transport, "", new Set(["recipient"]));
    expect(fake.summaries()).toBe(2);
    expect(sent).toBe(1);
  });

  test.serial("V2 local polling does not send an empty notification", async () => {
    let roomTool: any;
    const sessionID = "idle-session";
    const context: any = {
      location: { directory: temp },
      session: { prompt: async () => ({ id: "q", sessionID, type: "user", time: { created: 1 }, delivery: "queue", payload: { text: "" } }), hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn: (editor: any) => void) => { fn({ add: (value: unknown) => { roomTool = value; } }); return { dispose: async () => {} }; } },
      command: { transform: async (fn: (editor: any) => void) => { fn({ add() {} }); return { dispose: async () => {} }; } },
    };
    const cleanup = await setup(context);
    try {
      const created = await roomTool.execute({ action: "create", name: `idle-${Date.now()}` }, { sessionID });
      expect(String(created.content[0].text)).toContain("Room ");
      let sends = 0;
      await pollKnownSessions(new Set([sessionID]), {
        protocol: "v2",
        promptQueue: async () => { sends++; return {}; },
      }, { center: "", token: "", directory: temp });
      expect(sends).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test.serial("V2 setup runtimes retain separate directories", async () => {
    const makeInstance = async (directory: string, sessionID: string) => {
      let roomTool: any;
      const context: any = {
        location: { directory },
        session: { prompt: async () => ({}), hook: async () => ({ dispose: async () => {} }) },
        tool: { transform: async (fn: (editor: any) => void) => { fn({ add: (value: unknown) => { roomTool = value; } }); return { dispose: async () => {} }; } },
        command: { transform: async (fn: (editor: any) => void) => { fn({ add() {} }); return { dispose: async () => {} }; } },
      };
      return { roomTool, sessionID, cleanup: await setup(context), getTool: () => roomTool };
    };
    const firstDir = path.join(temp, "first");
    const secondDir = path.join(temp, "second");
    const first = await makeInstance(firstDir, "runtime-one");
    const second = await makeInstance(secondDir, "runtime-two");
    try {
      await first.getTool().execute({ action: "create", name: `first-${Date.now()}` }, { sessionID: first.sessionID });
      await second.getTool().execute({ action: "create", name: `second-${Date.now()}` }, { sessionID: second.sessionID });
      const registry = await loadRegistry();
      const entries = Object.values(registry).flatMap((members) => Object.entries(members));
      expect(entries.find(([id]) => id === first.sessionID)?.[1].directory).toBe(firstDir);
      expect(entries.find(([id]) => id === second.sessionID)?.[1].directory).toBe(secondDir);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test.serial("observed memberships refresh only their transport metadata", async () => {
    const preserved = { name: "same-name", lastReadTs: 42, lastQueuedTs: 51 };
    await saveRegistry({ room: {
      ownV2: { ...preserved, serverUrl: "http://old", apiPrefix: "/api", protocol: "v1", directory: "old" },
      ownLegacy: { ...preserved, serverUrl: "http://legacy", apiPrefix: "/api", directory: "legacy" },
      ownV1: { ...preserved, serverUrl: "", apiPrefix: "/api", protocol: "v2", directory: "old-v2" },
      foreign: { ...preserved, serverUrl: "http://foreign", apiPrefix: "/api", protocol: "v1", directory: "foreign" },
    } });
    let onPrompt: ((input: { sessionID: string }) => void | Promise<void>) | undefined;
    const v2Context: any = {
      location: { directory: "v2-project" },
      session: {
        prompt: async () => ({}),
        hook: async (_name: string, callback: typeof onPrompt) => { onPrompt = callback; return { dispose: async () => {} }; },
      },
      tool: { transform: async (fn: (editor: any) => void) => { fn({ add() {} }); return { dispose: async () => {} }; } },
      command: { transform: async (fn: (editor: any) => void) => { fn({ add() {} }); return { dispose: async () => {} }; } },
    };
    const cleanupV2 = await setup(v2Context);
    try {
      await onPrompt?.({ sessionID: "ownV2" });
      await onPrompt?.({ sessionID: "ownLegacy" });
      let registry = await loadRegistry();
      expect(registry.room!.ownV2).toMatchObject({ protocol: "v2", serverUrl: "", directory: "v2-project", apiPrefix: "/api", ...preserved });
      expect(registry.room!.ownLegacy).toMatchObject({ protocol: "v2", serverUrl: "", directory: "v2-project", apiPrefix: "/api", ...preserved });
      expect(registry.room!.foreign).toMatchObject({ protocol: "v1", serverUrl: "http://foreign", directory: "foreign", ...preserved });

      const hooks = await server({ serverUrl: new URL("http://v1-project"), directory: "v1-project" } as any);
      await hooks["chat.message"]?.({ sessionID: "ownV1" }, {} as any);
      registry = await loadRegistry();
      expect(registry.room!.ownV1).toMatchObject({ protocol: "v1", serverUrl: "http://v1-project/", directory: "v1-project", apiPrefix: "", ...preserved });
      await hooks.dispose?.();
    } finally {
      await cleanupV2();
    }
  });

  test.serial("each V2 setup cleans up only its own poller", async () => {
    const setIntervalOriginal = globalThis.setInterval;
    const clearIntervalOriginal = globalThis.clearInterval;
    const timers: number[] = [];
    const cleared: number[] = [];
    globalThis.setInterval = (() => timers.push(timers.length + 1) && timers.length) as unknown as typeof setInterval;
    globalThis.clearInterval = ((timer) => { cleared.push(timer as number); }) as typeof clearInterval;
    const makeContext = (): any => ({
      location: { directory: temp },
      session: { prompt: async () => ({}), hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async (fn: (editor: any) => void) => fn({ add() {} }) },
      command: { transform: async (fn: (editor: any) => void) => fn({ add() {} }) },
    });
    try {
      const first = await setup(makeContext());
      const second = await setup(makeContext());
      first();
      expect(cleared).toEqual([1]);
      second();
      expect(cleared).toEqual([1, 2]);
    } finally {
      globalThis.setInterval = setIntervalOriginal;
      globalThis.clearInterval = clearIntervalOriginal;
    }
  });
});

afterAll(async () => {
  if (originalStateDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = originalStateDir;
  if (originalCenterUrl === undefined) delete process.env.CHAT_ROOM_SERVER_URL;
  else process.env.CHAT_ROOM_SERVER_URL = originalCenterUrl;
  if (originalCenterToken === undefined) delete process.env.CHAT_ROOM_SERVER_TOKEN;
  else process.env.CHAT_ROOM_SERVER_TOKEN = originalCenterToken;
  if (originalWakeUrl === undefined) delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
  else process.env.CHAT_ROOM_WAKE_SERVE_URL = originalWakeUrl;
  await rm(temp, { recursive: true, force: true });
});
