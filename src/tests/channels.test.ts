import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadRoomConfig, resolveServerSettings, type ServerSettings } from "../config/file-config.ts";
import { databasePath, readState, recallMessage, writeState } from "../state/store.ts";
import {
  channelRoutes,
  createDeliveryResultHandler,
  startChannels,
  stopChannels,
  type ChannelsRuntime,
} from "../../server/channels.ts";
import type { SpawnAdapter } from "../../packages/chat-room-channeld/src/host.ts";
import type { IngestEvent } from "../../packages/chat-room-channeld/src/protocol.ts";
import type { DeliveryRow } from "../../packages/chat-room-channeld/src/state.ts";

const root = mkdtempSync(path.join(tmpdir(), "chat-room-channeld-center-"));
const previousStateDir = process.env.CHAT_ROOM_STATE_DIR;
const previousChanneld = process.env.CHAT_ROOM_CHANNELD;
const previousChanneldConfig = process.env.CHAT_ROOM_CHANNELD_CONFIG;

afterAll(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("CHAT_ROOM_STATE_DIR", previousStateDir);
  restore("CHAT_ROOM_CHANNELD", previousChanneld);
  restore("CHAT_ROOM_CHANNELD_CONFIG", previousChanneldConfig);
  rmSync(root, { recursive: true, force: true });
});

function useState(label: string): string {
  const directory = path.join(root, label);
  mkdirSync(directory, { recursive: true });
  process.env.CHAT_ROOM_STATE_DIR = directory;
  return directory;
}

function settings(configPath?: string, enabled = true): ServerSettings {
  return {
    host: "127.0.0.1",
    port: "4399",
    wakeServeUrl: "",
    channeld: { enabled, ...(configPath ? { config: configPath } : {}) },
  };
}

function writeChannelConfig(directory: string, roomId: string): string {
  const file = path.join(directory, "channeld.yml");
  writeFileSync(file, `stateFile: ignored.sqlite
accounts:
  - id: test
    platform: telegram
    adapter: { command: ["unused"] }
rules:
  - id: forward
    version: 1
    from: { platform: chatroom, account: center, room: ${roomId}, event: message.forward_requested }
    to: [ { platform: telegram, account: test, room: chat } ]
`);
  return file;
}

function writeTwoAccountConfig(directory: string, roomId: string): string {
  const file = path.join(directory, "channeld.yml");
  writeFileSync(file, `stateFile: ignored.sqlite
accounts:
  - id: test
    platform: telegram
    adapter: { command: ["unused"] }
  - id: dead
    platform: telegram
    adapter: { command: ["unused"] }
rules:
  - id: forward
    version: 1
    from: { platform: chatroom, account: center, room: ${roomId}, event: message.forward_requested }
    to:
      - { platform: telegram, account: test, room: chat }
      - { platform: telegram, account: dead, room: chat }
`);
  return file;
}

async function makeRoom(label: string): Promise<{ roomId: string; directory: string }> {
  const directory = useState(label);
  const roomId = await writeState((svc, registry) => {
    const room = svc.createRoom("Channel room", "Alice");
    registry[room.id] = {
      "session-alice": { serverUrl: "", apiPrefix: "/api", name: "Alice", membershipID: "membership-alice" },
    };
    return room.id;
  });
  return { roomId, directory };
}

async function sendMessage(roomId: string, text: string): Promise<string> {
  const result = await writeState((svc) => svc.sendMessage(roomId, "Alice", text, "session-alice"));
  return result.id;
}

/** Store sends and accept every delivery with the given terminal state. */
function fakeAdapter(state: "sent" | "permanent" | "unknown" = "sent") {
  const sends: Array<{ target: unknown; payload: unknown }> = [];
  const spawnAdapter: SpawnAdapter = () => ({
    start: async () => {},
    send: async (_deliveryId, _attemptId, _idempotencyKey, target, payload) => {
      sends.push({ target, payload });
      if (state === "sent") {
        return { state, providerMessage: { endpoint: target, nativeMessageId: `native-${sends.length}` } };
      }
      return { state, detail: "rejected by test" };
    },
    stop: async () => {},
  });
  return { sends, spawnAdapter };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

function forwardRequest(roomId: string): { request: Request; url: URL } {
  const url = new URL(`http://center.test/rooms/${roomId}/forward`);
  return {
    url,
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId: "message-id",
        target: { platform: "telegram", account: "test", room: "chat" },
      }),
    }),
  };
}

function eventFor(roomId: string): IngestEvent {
  return {
    schemaVersion: 1,
    eventId: "fwd-test",
    kind: "message.forward_requested",
    source: { platform: "chatroom", accountId: "center", roomId },
    actor: { platform: "chatroom", identityNamespace: "session", nativeUserId: "session-alice" },
    sourceDedupKey: "forward:message-id:telegram/test/chat",
    receivedAt: new Date(0).toISOString(),
  };
}

function deliveryFor(deliveryId: string, state: DeliveryRow["state"], lastError: string | null): DeliveryRow {
  return {
    deliveryId,
    eventId: "fwd-test",
    ruleId: "forward",
    ruleVersion: 1,
    target: "telegram/test/chat",
    idempotencyKey: "key",
    payload: "{}",
    state,
    attemptCount: 1,
    nextAttemptAt: null,
    lastError,
    providerMessage: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

test("server.channeld defaults off and environment overrides the file", () => {
  expect(resolveServerSettings({}, {}).channeld).toEqual({ enabled: false, config: undefined, stateFile: undefined });
  const file = { server: { channeld: { enabled: true, config: "/tmp/channeld.yml", stateFile: "/tmp/custom.sqlite" } } };
  expect(resolveServerSettings(file, {}).channeld).toEqual({
    enabled: true,
    config: "/tmp/channeld.yml",
    stateFile: "/tmp/custom.sqlite",
  });
  expect(resolveServerSettings(file, { CHAT_ROOM_CHANNELD: "0" }).channeld.enabled).toBe(false);
  expect(resolveServerSettings({}, { CHAT_ROOM_CHANNELD: "1", CHAT_ROOM_CHANNELD_CONFIG: "/env/channeld.yml" }).channeld)
    .toEqual({ enabled: true, config: "/env/channeld.yml", stateFile: undefined });
});

test("server.channeld rejects non-boolean enabled values", () => {
  const directory = useState("invalid-config");
  const file = path.join(directory, "chatroom.json");
  writeFileSync(file, JSON.stringify({ server: { channeld: { enabled: "yes" } } }));
  expect(() => loadRoomConfig({ CHAT_ROOM_CONFIG: file, HOME: directory, XDG_CONFIG_HOME: directory }, directory))
    .toThrow("server.channeld.enabled");
});

test("enabled without a usable config fails startup with a clear message", async () => {
  useState("startup-failure");
  await expect(startChannels(settings())).rejects.toThrow("server.channeld is enabled but no config file is set");
  await expect(startChannels(settings(path.join(root, "missing-channeld.yml"))))
    .rejects.toThrow("channeld config: cannot read");
});

test("an adapter start failure stops the host instead of failing the server", async () => {
  const directory = useState("adapter-failure");
  const configPath = writeChannelConfig(directory, "any-room");
  let stops = 0;
  const failing: SpawnAdapter = () => ({
    start: async () => { throw new Error("adapter failed to start"); },
    send: async () => ({ state: "permanent", detail: "unused" }),
    stop: async () => { stops += 1; },
  });
  const failed = await startChannels(settings(configPath), { spawnAdapter: failing });
  expect(failed).toBeUndefined();
  expect(stops).toBeGreaterThanOrEqual(1);
  expect(existsSync(path.join(directory, "channeld.sqlite"))).toBe(true);
  const roomId = "any-room";
  const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
  expect(await channelRoutes(new Request(targetsUrl), targetsUrl, failed)).toBeUndefined();

  // The state file is not left locked: a fresh host can take over.
  const runtime = await startChannels(settings(configPath), { spawnAdapter: fakeAdapter("sent").spawnAdapter });
  expect(runtime).toBeDefined();
  await stopChannels(runtime);
});

test("disabled forward targets are omitted and rejected without creating state", async () => {
  const { roomId, directory } = await makeRoom("forward-unavailable");
  const messageId = await sendMessage(roomId, "hello unavailable");
  const configPath = writeTwoAccountConfig(directory, roomId);
  const sends: Array<{ target: unknown; payload: unknown }> = [];
  const spawnAdapter: SpawnAdapter = (account) => {
    if (account.id === "dead") {
      return {
        start: async () => { throw new Error("adapter failed to start"); },
        send: async () => ({ state: "permanent", detail: "unused" }),
        stop: async () => {},
      };
    }
    return {
      start: async () => {},
      send: async (_deliveryId, _attemptId, _idempotencyKey, target, payload) => {
        sends.push({ target, payload });
        return {
          state: "sent",
          providerMessage: { endpoint: target, nativeMessageId: `native-${sends.length}` },
        };
      },
      stop: async () => {},
    };
  };
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    expect(runtime).toBeDefined();
    expect(runtime!.host.targetStatus("telegram", "dead")).toBe("disabled");
    expect(runtime!.host.targetStatus("telegram", "missing")).toBe("missing");
    expect(runtime!.host.targetStatus("other", "test")).toBe("missing");

    const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
    const targetsResponse = await channelRoutes(new Request(targetsUrl), targetsUrl, runtime);
    expect(targetsResponse?.status).toBe(200);
    expect(await targetsResponse?.json()).toEqual({
      targets: [{ platform: "telegram", account: "test", room: "chat" }],
    });

    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const post = (account: string) => channelRoutes(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account, room: "chat" },
      }),
    }), url, runtime);

    const unavailable = await post("dead");
    expect(unavailable?.status).toBe(409);
    expect(await unavailable?.json()).toEqual({ error: "forward target is unavailable" });

    const channel = new DatabaseSync(path.join(directory, "channeld.sqlite"));
    expect((channel.prepare("SELECT COUNT(*) AS count FROM channel_events").get() as { count: number }).count).toBe(0);
    expect((channel.prepare("SELECT COUNT(*) AS count FROM channel_deliveries").get() as { count: number }).count).toBe(0);
    channel.close();

    const accepted = await post("test");
    expect(accepted?.status).toBe(202);
    await waitFor(() => sends.length === 1);
    expect(sends[0]?.target).toEqual({ platform: "telegram", accountId: "test", roomId: "chat" });

    const after = new DatabaseSync(path.join(directory, "channeld.sqlite"));
    expect((after.prepare("SELECT COUNT(*) AS count FROM channel_events WHERE dedup_key NOT LIKE 'result.published:%'").get() as { count: number }).count).toBe(1);
    expect((after.prepare("SELECT COUNT(*) AS count FROM channel_deliveries").get() as { count: number }).count).toBe(1);
    after.close();
  } finally {
    await stopChannels(runtime);
  }
});

test("forward rejects unknown sessions and non-members with 404", async () => {
  const { roomId, directory } = await makeRoom("forward-auth-404");
  const messageId = await sendMessage(roomId, "hello");
  const { spawnAdapter } = fakeAdapter("sent");
  const runtime = await startChannels(settings(writeChannelConfig(directory, roomId)), {
    spawnAdapter,
    deliveryIntervalMs: 10,
  });
  try {
    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    for (const sessionID of ["session-unknown", "session-bob"]) {
      const response = await channelRoutes(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID,
          messageId,
          target: { platform: "telegram", account: "test", room: "chat" },
        }),
      }), url, runtime);
      expect(response?.status).toBe(404);
    }
    const channel = new DatabaseSync(path.join(directory, "channeld.sqlite"));
    expect((channel.prepare("SELECT COUNT(*) AS count FROM channel_events").get() as { count: number }).count).toBe(0);
    expect((channel.prepare("SELECT COUNT(*) AS count FROM channel_deliveries").get() as { count: number }).count).toBe(0);
    channel.close();
  } finally {
    await stopChannels(runtime);
  }
});

test("a removed participant loses forward access even with a stale registry row", async () => {
  const { roomId, directory } = await makeRoom("removed-member");
  const messageId = await sendMessage(roomId, "hello");
  const configPath = writeChannelConfig(directory, roomId);
  const { spawnAdapter } = fakeAdapter("sent");
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    expect(runtime).toBeDefined();
    const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
    expect((await channelRoutes(new Request(targetsUrl), targetsUrl, runtime))?.status).toBe(200);

    // Leave the registry row in place, as a kick path that only edits participants would.
    await writeState((svc) => { svc.leaveRoom(roomId, "Alice"); });
    expect((await channelRoutes(new Request(targetsUrl), targetsUrl, runtime))?.status).toBe(404);

    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account: "test", room: "chat" },
      }),
    });
    expect((await channelRoutes(request, url, runtime))?.status).toBe(404);
  } finally {
    await stopChannels(runtime);
  }
});

test("malformed percent escapes return 404 instead of throwing", async () => {
  const { roomId, directory } = await makeRoom("bad-encoding");
  const { spawnAdapter } = fakeAdapter("sent");
  const runtime = await startChannels(settings(writeChannelConfig(directory, roomId)), { spawnAdapter });
  try {
    const forwardUrl = new URL("http://center.test/rooms/%E0%A4%A/forward");
    const forward = await channelRoutes(new Request(forwardUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), forwardUrl, runtime);
    expect(forward?.status).toBe(404);
    const targetsUrl = new URL("http://center.test/rooms/%E0%A4%A/forward-targets?sessionID=session-alice");
    expect((await channelRoutes(new Request(targetsUrl), targetsUrl, runtime))?.status).toBe(404);
  } finally {
    await stopChannels(runtime);
  }
});

test("a long failure detail is truncated below the message limit", async () => {
  const { roomId } = await makeRoom("long-detail");
  const handler = createDeliveryResultHandler();
  const delivery = deliveryFor("dlv-long", "permanent", "short");
  const detail = "x".repeat(6000);
  handler(eventFor(roomId), delivery, {
    receiptId: "receipt-long",
    deliveryId: "dlv-long",
    attemptId: "att-1",
    state: "permanent",
    providerMessage: null,
    detail,
    observedAt: 1,
  });
  await waitFor(async () => {
    const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
    return texts.includes(`Forward to telegram/test/chat failed: ${"x".repeat(500)}`);
  });
  const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
  const failure = texts.find((text) => text.startsWith("Forward to "));
  expect(failure).toBe(`Forward to telegram/test/chat failed: ${"x".repeat(500)}`);
  expect(failure!.length).toBeLessThan(5000);
});

test("the flag off creates no database, routes, or messages", async () => {
  const { roomId, directory } = await makeRoom("flag-off");
  await sendMessage(roomId, "hello");
  const runtime = await startChannels(settings(undefined, false));
  expect(runtime).toBeUndefined();
  expect(existsSync(path.join(directory, "channeld.sqlite"))).toBe(false);

  const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
  expect(await channelRoutes(new Request(targetsUrl), targetsUrl, runtime)).toBeUndefined();
  const statusUrl = new URL("http://center.test/channeld/status");
  expect(await channelRoutes(new Request(statusUrl), statusUrl, runtime)).toBeUndefined();
  const { request, url } = forwardRequest(roomId);
  expect(await channelRoutes(request, url, runtime)).toBeUndefined();
  expect((await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text)))).toEqual(["hello"]);
});

test("ordinary messages never publish; only an explicit forward notifies", async () => {
  const { roomId, directory } = await makeRoom("explicit-publish");
  const configPath = writeChannelConfig(directory, roomId);
  const { sends, spawnAdapter } = fakeAdapter("sent");
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    await sendMessage(roomId, "ordinary one");
    await sendMessage(roomId, "ordinary two");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sends).toHaveLength(0);
    const ordinary = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
    expect(ordinary).toEqual(["ordinary one", "ordinary two"]);

    const statusUrl = new URL("http://center.test/channeld/status");
    const before = await (await channelRoutes(new Request(statusUrl), statusUrl, runtime))?.json() as {
      events: number;
      queueDepth: number;
    };
    expect(before).toMatchObject({ events: 0, queueDepth: 0 });

    const messageId = await sendMessage(roomId, "publish me");
    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const response = await channelRoutes(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account: "test", room: "chat" },
      }),
    }), url, runtime);
    expect(response?.status).toBe(202);
    await waitFor(async () => {
      const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
      return sends.length === 1 && texts.includes("Forwarded to telegram/test/chat");
    });
  } finally {
    await stopChannels(runtime);
  }
});

test("a forward creates one delivery, one system message, and a stable dedup key", async () => {
  const { roomId, directory } = await makeRoom("forward");
  const messageId = await sendMessage(roomId, "hello channel");
  const configPath = writeChannelConfig(directory, roomId);
  const { sends, spawnAdapter } = fakeAdapter("sent");
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    expect(runtime).toBeDefined();

    const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
    const targetsResponse = await channelRoutes(new Request(targetsUrl), targetsUrl, runtime);
    expect(targetsResponse?.status).toBe(200);
    expect(await targetsResponse?.json()).toEqual({ targets: [{ platform: "telegram", account: "test", room: "chat" }] });

    const outsiderUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-bob`);
    expect((await channelRoutes(new Request(outsiderUrl), outsiderUrl, runtime))?.status).toBe(404);

    const body = {
      sessionID: "session-alice",
      messageId,
      target: { platform: "telegram", account: "test", room: "chat" },
    };
    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const post = (requestId?: string) => channelRoutes(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...(requestId ? { requestId } : {}) }),
    }), url, runtime);
    const first = await post("request-one");
    expect(first?.status).toBe(202);
    const firstBody = await first?.json() as { eventId: string };
    expect(typeof firstBody.eventId).toBe("string");

    await waitFor(async () => {
      const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
      return sends.length === 1 && texts.includes("Forwarded to telegram/test/chat");
    });
    expect(sends[0]?.target).toEqual({ platform: "telegram", accountId: "test", roomId: "chat" });
    expect(sends[0]?.payload).toEqual({ text: "hello channel" });

    const statusUrl = new URL("http://center.test/channeld/status");
    const statusResponse = await channelRoutes(new Request(statusUrl), statusUrl, runtime);
    expect(statusResponse?.status).toBe(200);
    const stats = await statusResponse?.json() as {
      events: number;
      publishedResults: number;
      queueDepth: number;
      deliveries: { total: number; sent: number };
      accounts: Array<{ account: string }>;
    };
    expect(stats).toMatchObject({
      events: 2,
      publishedResults: 1,
      queueDepth: 0,
      deliveries: { total: 1, sent: 1 },
    });
    expect(stats.accounts).toContainEqual(expect.objectContaining({ account: "telegram/test" }));
    expect(JSON.stringify(stats)).not.toContain("hello channel");

    // Same message and target: the dedup key returns the first event, not a twin.
    const replay = await post("request-two");
    expect(replay?.status).toBe(202);
    expect((await replay?.json() as { eventId: string }).eventId).toBe(firstBody.eventId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sends).toHaveLength(1);

    const channel = new DatabaseSync(path.join(directory, "channeld.sqlite"));
    expect((channel.prepare("SELECT COUNT(*) AS count FROM channel_events").get() as { count: number }).count).toBe(2);
    expect((channel.prepare("SELECT COUNT(*) AS count FROM channel_deliveries").get() as { count: number }).count).toBe(1);
    channel.close();
    expect(existsSync(path.join(directory, "ignored.sqlite"))).toBe(false);

    const room = new DatabaseSync(path.join(directory, "chat-room.sqlite"));
    const tables = (room.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'channel_%'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    room.close();
    expect(tables).toEqual([]);

    expect(await recallMessage(roomId, messageId, "session-alice")).toMatchObject({ status: "ok" });
    expect((await post())?.status).toBe(404);
    const missing = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, messageId: "missing-message" }),
    });
    expect((await channelRoutes(missing, url, runtime))?.status).toBe(404);
    const outsider = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, sessionID: "session-bob" }),
    });
    expect((await channelRoutes(outsider, url, runtime))?.status).toBe(404);
  } finally {
    await stopChannels(runtime);
  }
});

test("a terminal unknown without a receipt publishes one failure message", async () => {
  const { roomId } = await makeRoom("unknown-no-receipt");
  const handler = createDeliveryResultHandler();
  const event = eventFor(roomId);
  const delivery = deliveryFor("dlv-unknown", "unknown", "adapter exited (code=1 signal=null)");
  handler(event, delivery, undefined);
  handler(event, delivery, undefined);
  handler(event, deliveryFor("dlv-retry", "retryable", null), undefined);
  await waitFor(async () => {
    const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
    return texts.includes("Forward to telegram/test/chat failed: adapter exited (code=1 signal=null)");
  });
  const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
  expect(texts.filter((text) => text.startsWith("Forward to "))).toHaveLength(1);
});