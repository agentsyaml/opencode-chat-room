import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadRoomConfig, resolveServerSettings, type ServerSettings } from "../config/file-config.ts";
import { databasePath, readState, recallMessage, sendReply, writeState } from "../state/store.ts";
import { findResource, uploadResource } from "../rooms/resources.ts";
import {
  channelRoutes,
  createChannelController,
  createDeliveryResultHandler,
  startChannels,
  stopChannels,
  type ChannelController,
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

function writeNamedChannelConfig(directory: string, name: string, roomId: string, account: string): string {
  const file = path.join(directory, name);
  writeFileSync(file, `stateFile: ignored.sqlite
accounts:
  - id: ${account}
    platform: telegram
    adapter: { command: ["unused"] }
rules:
  - id: forward
    version: 1
    from: { platform: chatroom, account: center, room: ${roomId}, event: message.forward_requested }
    to: [ { platform: telegram, account: ${account}, room: chat } ]
`);
  return file;
}

function adminEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

function adminRequest(url: URL, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function adminPut(url: URL, body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PLUGIN_SOURCE = `
let buffer = "";
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "send") {
      respond(request.id, {
        state: "sent",
        providerMessage: { endpoint: request.params.target, nativeMessageId: "native-" + request.id },
      });
    } else {
      respond(request.id, {
        version: 1,
        eventSchema: 1,
        maxFrameBytes: 1048576,
        accounts: {},
        platform: process.env.PLUGIN_REPORT_PLATFORM || "telegram",
      });
    }
    newline = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`;

const FEISHU_PLUGIN_SOURCE = PLUGIN_SOURCE.replace('|| "telegram"', '|| "feishu"');

const TYPED_PLUGIN_SOURCE = `
enum Reported { Platform = "typed-platform" }
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { version: 1, eventSchema: 1, platform: Reported.Platform, maxFrameBytes: 1048576, accounts: {} },
    }) + "\\n");
    newline = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`;

async function uploadPlugin(
  controller: ChannelController,
  body: Record<string, unknown>,
): Promise<{ response: Response | undefined; json: Record<string, unknown> }> {
  const url = new URL("http://center.test/channeld/plugins");
  const response = await controller.handle(adminRequest(url, body), url);
  return {
    response,
    json: response ? await response.clone().json() as Record<string, unknown> : {},
  };
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

async function forwardMessage(
  runtime: ChannelsRuntime | undefined,
  roomId: string,
  messageId: string,
  target: { platform: string; account: string; room: string },
): Promise<number> {
  const url = new URL(`http://center.test/rooms/${roomId}/forward`);
  const response = await channelRoutes(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: "session-alice", messageId, target }),
  }), url, runtime);
  return response?.status ?? 0;
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

test("an inbound Feishu attachment becomes a room resource and marker", async () => {
  const { roomId, directory } = await makeRoom("inbound-attachment");
  const configPath = path.join(directory, "channeld.yml");
  writeFileSync(configPath, `stateFile: ignored.sqlite
accounts:
  - id: feishu-main
    platform: feishu
    adapter: { command: ["unused"] }
inbound:
  - from: { platform: feishu, account: feishu-main, room: oc_allowed }
    to: { room: ${roomId} }
`);
  const { spawnAdapter } = fakeAdapter("sent");
  const attachmentDir = await mkdtemp(path.join(tmpdir(), "chat-room-channeld-"));
  const file = path.join(attachmentDir, "photo.png");
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(file, bytes);
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    const event: IngestEvent = {
      schemaVersion: 1,
      eventId: "evt-image",
      kind: "message.created",
      source: { platform: "feishu", accountId: "feishu-main", roomId: "oc_allowed" },
      actor: { platform: "feishu", identityNamespace: "open_id", nativeUserId: "ou_alice" },
      providerEventId: "evt-image",
      sourceDedupKey: "feishu:feishu-main:evt-image",
      receivedAt: new Date(0).toISOString(),
      content: { attachments: [{ kind: "image", name: "photo.png", mimeType: "image/png", size: bytes.length, path: file }] },
    };
    expect((await runtime!.host.ingest(event)).duplicate).toBe(false);
    await waitFor(async () => {
      const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
      return texts.some((text) => text.includes("[[resource:") && text.includes("[image]"));
    });
    const text = await readState((svc) => svc.getRoom(roomId).messages.at(-1)?.text ?? "");
    expect(text).toContain("message_id=evt-image chat_id=oc_allowed sender=ou_alice");
    const id = /\[\[resource:([0-9a-f-]{36})\]\]/.exec(text)?.[1];
    expect(id).toBeTruthy();
    expect(await findResource(roomId, id!)).toMatchObject({ name: "photo.png", mimeType: "image/png", size: bytes.length });
  } finally {
    await stopChannels(runtime);
    await rm(attachmentDir, { recursive: true, force: true });
  }
});

test("a forward resolves a room resource marker into an adapter file", async () => {
  const { roomId, directory } = await makeRoom("forward-attachment");
  const resource = await uploadResource(
    roomId,
    "photo.png",
    new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]).stream(),
    1024 * 1024,
    { sessionID: "session-alice", name: "Alice" },
  );
  const messageId = await sendMessage(roomId, `photo\n[[resource:${resource.id}]]`);
  const configPath = writeChannelConfig(directory, roomId);
  const { sends, spawnAdapter } = fakeAdapter("sent");
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    expect(await forwardMessage(runtime, roomId, messageId, { platform: "telegram", account: "test", room: "chat" })).toBe(202);
    await waitFor(() => sends.length === 1);
    const payload = sends[0]!.payload as { text: string; attachments: Array<Record<string, unknown>> };
    expect(payload.text).toContain("photo");
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]).toMatchObject({
      kind: "image", name: "photo.png", mimeType: "image/png", resourceId: resource.id, roomId,
    });
    expect(String(payload.attachments[0]!.path)).toContain("chat-room-outbound-");
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

test("admin control routes stay hidden unless CHATROOM_ALLOW_ADMIN is true", async () => {
  const { roomId, directory } = await makeRoom("admin-gate");
  const configPath = writeChannelConfig(directory, roomId);
  const { spawnAdapter } = fakeAdapter("sent");
  const env = adminEnv();
  delete env.CHATROOM_ALLOW_ADMIN;
  const controller = createChannelController(settings(configPath), {
    spawnAdapter,
    deliveryIntervalMs: 10,
    env,
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const reloadUrl = new URL("http://center.test/channeld/reload");
    expect(await controller.handle(adminRequest(reloadUrl, {}), reloadUrl)).toBeUndefined();
    const pluginsUrl = new URL("http://center.test/channeld/plugins");
    expect(await controller.handle(adminRequest(pluginsUrl, { name: "x.js" }), pluginsUrl)).toBeUndefined();
    const integrationUrl = new URL("http://center.test/channeld/integration");
    expect(await controller.handle(new Request(integrationUrl), integrationUrl)).toBeUndefined();

    const statusUrl = new URL("http://center.test/channeld/status");
    expect((await controller.handle(new Request(statusUrl), statusUrl))?.status).toBe(200);
  } finally {
    await controller.stop();
  }
});

test("a disabled relay enables with a valid config without restarting", async () => {
  const { roomId, directory } = await makeRoom("admin-enable");
  const configPath = writeChannelConfig(directory, roomId);
  const { sends, spawnAdapter } = fakeAdapter("sent");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    expect(controller.enabled).toBe(false);
    const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
    expect(await controller.handle(new Request(targetsUrl), targetsUrl)).toBeUndefined();

    const enableUrl = new URL("http://center.test/channeld/enable");
    const enable = await controller.handle(adminRequest(enableUrl, { config: configPath }), enableUrl);
    expect(enable?.status).toBe(200);
    expect(await enable?.json()).toMatchObject({ enabled: true, persisted: false, restartRequired: true });
    expect(controller.enabled).toBe(true);
    expect((await controller.handle(new Request(targetsUrl), targetsUrl))?.status).toBe(200);

    const messageId = await sendMessage(roomId, "live enable");
    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const forwarded = await controller.handle(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account: "test", room: "chat" },
      }),
    }), url);
    expect(forwarded?.status).toBe(202);
    await waitFor(() => sends.length === 1);
  } finally {
    await controller.stop();
  }
});

test("enabling without a config, or with an invalid one, stays off", async () => {
  const { roomId } = await makeRoom("admin-enable-invalid");
  const directory = useState("admin-enable-invalid");
  const invalidPath = writeNamedChannelConfig(directory, "broken.yml", roomId, "test");
  writeFileSync(invalidPath, "accounts:\n  - id: test\nrules: []\n");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const enableUrl = new URL("http://center.test/channeld/enable");
    const noConfig = await controller.handle(adminRequest(enableUrl, {}), enableUrl);
    expect(noConfig?.status).toBe(400);
    expect(await noConfig?.json()).toMatchObject({ error: expect.stringContaining("configuration") });
    expect(controller.enabled).toBe(false);

    const invalid = await controller.handle(adminRequest(enableUrl, { config: invalidPath }), enableUrl);
    expect(invalid?.status).toBe(400);
    expect(controller.enabled).toBe(false);
  } finally {
    await controller.stop();
  }
});

test("an invalid reload keeps the old runtime and config untouched", async () => {
  const { roomId, directory } = await makeRoom("admin-invalid-reload");
  const configPath = writeNamedChannelConfig(directory, "good.yml", roomId, "test");
  const invalidPath = path.join(directory, "invalid.yml");
  writeFileSync(invalidPath, `accounts:
  - id: test
    platform: telegram
    adapter: { command: ["unused"] }
rules:
  - id: broken
    version: 1
    from: { platform: chatroom, account: center, room: ${roomId} }
    to: [ { platform: telegram, account: missing, room: chat } ]
`);
  const { sends, spawnAdapter } = fakeAdapter("sent");
  const controller = createChannelController(settings(configPath), {
    spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const before = controller.runtime;
    const reloadUrl = new URL("http://center.test/channeld/reload");
    const response = await controller.handle(adminRequest(reloadUrl, { config: invalidPath }), reloadUrl);
    expect(response?.status).toBe(400);
    const text = await response?.text();
    expect(text?.toLowerCase()).not.toContain("channeld");
    expect(controller.runtime).toBe(before);

    const messageId = await sendMessage(roomId, "old config still works");
    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const forwarded = await controller.handle(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account: "test", room: "chat" },
      }),
    }), url);
    expect(forwarded?.status).toBe(202);
    await waitFor(() => sends.length === 1);
  } finally {
    await controller.stop();
  }
});

test("disable stops forwarding and status without affecting other routes", async () => {
  const { roomId, directory } = await makeRoom("admin-disable");
  const configPath = writeChannelConfig(directory, roomId);
  const controller = createChannelController(settings(configPath), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
    const statusUrl = new URL("http://center.test/channeld/status");
    expect((await controller.handle(new Request(targetsUrl), targetsUrl))?.status).toBe(200);
    expect((await controller.handle(new Request(statusUrl), statusUrl))?.status).toBe(200);

    const disableUrl = new URL("http://center.test/channeld/disable");
    const disabled = await controller.handle(adminRequest(disableUrl), disableUrl);
    expect(disabled?.status).toBe(200);
    expect(await disabled?.json()).toMatchObject({ enabled: false });
    expect(controller.enabled).toBe(false);
    expect(await controller.handle(new Request(targetsUrl), targetsUrl)).toBeUndefined();
    expect(await controller.handle(new Request(statusUrl), statusUrl)).toBeUndefined();
    const { request, url } = forwardRequest(roomId);
    expect(await controller.handle(request, url)).toBeUndefined();
  } finally {
    await controller.stop();
  }
});

test("a failed new host restores the previous runtime without echoing details", async () => {
  const { roomId, directory } = await makeRoom("admin-restore");
  const oldPath = writeNamedChannelConfig(directory, "old.yml", roomId, "test");
  const brokenPath = writeNamedChannelConfig(directory, "broken-host.yml", roomId, "broken");
  const sends: unknown[] = [];
  const spawnAdapter: SpawnAdapter = (account) => {
    if (account.id === "broken") {
      return {
        start: async () => { throw new Error("token=topsecret channeld"); },
        send: async () => ({ state: "permanent", detail: "unused" }),
        stop: async () => {},
      };
    }
    return {
      start: async () => {},
      send: async (_deliveryId, _attemptId, _idempotencyKey, target) => {
        sends.push(target);
        return { state: "sent", providerMessage: { endpoint: target, nativeMessageId: `native-${sends.length}` } };
      },
      stop: async () => {},
    };
  };
  const controller = createChannelController(settings(oldPath), {
    spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const reloadUrl = new URL("http://center.test/channeld/reload");
    const failed = await controller.handle(adminRequest(reloadUrl, { config: brokenPath }), reloadUrl);
    expect(failed?.status).toBe(502);
    const text = await failed!.text();
    expect(text.toLowerCase()).not.toContain("channeld");
    expect(text).not.toContain("topsecret");
    expect(JSON.parse(text)).toMatchObject({ enabled: true, restored: true });
    expect(controller.enabled).toBe(true);
    expect(controller.runtime?.config.accounts.map((account) => account.id)).toEqual(["test"]);

    const messageId = await sendMessage(roomId, "restored runtime");
    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const forwarded = await controller.handle(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account: "test", room: "chat" },
      }),
    }), url);
    expect(forwarded?.status).toBe(202);
    await waitFor(() => sends.length === 1);
  } finally {
    await controller.stop();
  }
});

test("reloading the same config does not duplicate terminal system messages", async () => {
  const { roomId, directory } = await makeRoom("admin-no-duplicate");
  const configPath = writeChannelConfig(directory, roomId);
  const { sends, spawnAdapter } = fakeAdapter("sent");
  const controller = createChannelController(settings(configPath), {
    spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const messageId = await sendMessage(roomId, "one message");
    const url = new URL(`http://center.test/rooms/${roomId}/forward`);
    const forwarded = await controller.handle(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account: "test", room: "chat" },
      }),
    }), url);
    expect(forwarded?.status).toBe(202);
    await waitFor(async () => {
      const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
      return sends.length === 1 && texts.includes("Forwarded to telegram/test/chat");
    });

    const reloadUrl = new URL("http://center.test/channeld/reload");
    expect((await controller.handle(adminRequest(reloadUrl, { config: configPath }), reloadUrl))?.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
    expect(texts.filter((text) => text.startsWith("Forwarded to "))).toHaveLength(1);
    expect(sends).toHaveLength(1);
  } finally {
    await controller.stop();
  }
});

test("admin changes persist in an existing JSON room config and report it", async () => {
  const { roomId, directory } = await makeRoom("admin-persist");
  const configPath = writeChannelConfig(directory, roomId);
  const roomConfig = path.join(directory, "chatroom.json");
  writeFileSync(roomConfig, JSON.stringify({
    server: { token: "keep-me", channeld: { enabled: false, config: "stale.yml" } },
    client: { url: "http://example.invalid" },
  }));
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true", CHAT_ROOM_CONFIG: roomConfig }),
  });
  try {
    await controller.start();
    const enableUrl = new URL("http://center.test/channeld/enable");
    const enabled = await controller.handle(adminRequest(enableUrl, { config: configPath }), enableUrl);
    expect(await enabled?.json()).toMatchObject({ enabled: true, persisted: true, restartRequired: false });
    const saved = JSON.parse(await Bun.file(roomConfig).text()) as {
      server: { token: string; channeld: { enabled: boolean; config: string } };
      client: { url: string };
    };
    expect(saved.server.token).toBe("keep-me");
    expect(saved.server.channeld).toMatchObject({ enabled: true, config: configPath });
    expect(saved.client.url).toBe("http://example.invalid");

    const disableUrl = new URL("http://center.test/channeld/disable");
    const disabled = await controller.handle(adminRequest(disableUrl), disableUrl);
    expect(await disabled?.json()).toMatchObject({ enabled: false, persisted: true });
    const afterDisable = JSON.parse(await Bun.file(roomConfig).text()) as {
      server: { channeld: { enabled: boolean; config: string } };
    };
    expect(afterDisable.server.channeld).toMatchObject({ enabled: false, config: configPath });
  } finally {
    await controller.stop();
  }
});

test("admin changes persist in an existing YAML room config", async () => {
  const { roomId, directory } = await makeRoom("admin-persist-yaml");
  const configPath = writeChannelConfig(directory, roomId);
  const roomConfig = path.join(directory, "chatroom.yaml");
  writeFileSync(roomConfig, "server:\n  token: keep-yaml\n  channeld:\n    enabled: false\n");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true", CHAT_ROOM_CONFIG: roomConfig }),
  });
  try {
    await controller.start();
    const enableUrl = new URL("http://center.test/channeld/enable");
    const enabled = await controller.handle(adminRequest(enableUrl, { config: configPath }), enableUrl);
    expect(await enabled?.json()).toMatchObject({ enabled: true, persisted: true });
    const saved = await Bun.file(roomConfig).text();
    expect(saved).toContain("token: keep-yaml");
    expect(saved).toContain("enabled: true");
    expect(saved).toContain(configPath);
  } finally {
    await controller.stop();
  }
});

test("without a writable config location admin changes report restart required", async () => {
  const { roomId, directory } = await makeRoom("admin-no-persist");
  const configPath = writeChannelConfig(directory, roomId);
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({
      CHATROOM_ALLOW_ADMIN: "true",
      CHAT_ROOM_CONFIG: path.join(directory, "missing-chatroom.json"),
    }),
  });
  try {
    await controller.start();
    const enableUrl = new URL("http://center.test/channeld/enable");
    const enabled = await controller.handle(adminRequest(enableUrl, { config: configPath }), enableUrl);
    expect(await enabled?.json()).toMatchObject({ enabled: true, persisted: false, restartRequired: true });
    expect(existsSync(path.join(directory, "missing-chatroom.json"))).toBe(false);
  } finally {
    await controller.stop();
  }
});

test("plugin upload derives platform and validates handshake and file limits", async () => {
  const { directory } = await makeRoom("plugin-upload");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const good = await uploadPlugin(controller, {
      name: "adapter.js",
      source: PLUGIN_SOURCE,
    });
    expect(good.response?.status).toBe(201);
    expect(good.json).toMatchObject({ name: "adapter.js", platform: "telegram" });
    const pluginId = good.json.pluginId as string;
    expect(typeof pluginId).toBe("string");
    expect(existsSync(path.join(directory, "integrations", "plugins", pluginId, "adapter.js"))).toBe(true);

    const downloadUrl = new URL(`http://center.test/channeld/plugins/${pluginId}/download`);
    const downloaded = await controller.handle(new Request(downloadUrl), downloadUrl);
    expect(downloaded?.status).toBe(200);
    expect(await downloaded!.text()).toBe(PLUGIN_SOURCE);
    expect(downloaded!.headers.get("content-disposition")).toContain("adapter.js");
    expect(downloaded!.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloaded!.headers.get("cache-control")).toBe("no-store");

    const missingDownload = new URL("http://center.test/channeld/plugins/does-not-exist/download");
    expect((await controller.handle(new Request(missingDownload), missingDownload))?.status).toBe(404);
    const traversalDownload = new URL("http://center.test/channeld/plugins/..%2Fescape.js/download");
    expect((await controller.handle(new Request(traversalDownload), traversalDownload))?.status).toBe(404);

    const oversized = await uploadPlugin(controller, {
      name: "big.js",
      source: "x".repeat(256 * 1024 + 1),
    });
    expect(oversized.response?.status).toBe(400);

    const unsafe = await uploadPlugin(controller, {
      name: "../escape.js",
      source: PLUGIN_SOURCE,
    });
    expect(unsafe.response?.status).toBe(400);

    const plugins = path.join(directory, "integrations", "plugins");
    expect(readdirSync(plugins)).toEqual([pluginId]);

    const integrationUrl = new URL("http://center.test/channeld/integration");
    const listed = await controller.handle(new Request(integrationUrl), integrationUrl);
    const listedText = await listed!.text();
    expect((JSON.parse(listedText) as { plugins: unknown[] }).plugins).toEqual([
      { pluginId, name: "adapter.js", platform: "telegram" },
    ]);
    expect(listedText).not.toContain(directory);
  } finally {
    await controller.stop();
  }
});

test("plugin upload accepts non-erasable TypeScript through the adapter transform", async () => {
  const { directory } = await makeRoom("plugin-upload-ts");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const serverOptions = process.env.NODE_OPTIONS;
    const typed = await uploadPlugin(controller, {
      name: "typed-adapter.ts",
      source: TYPED_PLUGIN_SOURCE,
    });
    expect(typed.response?.status).toBe(201);
    expect(typed.json).toMatchObject({ name: "typed-adapter.ts", platform: "typed-platform" });
    const pluginId = typed.json.pluginId as string;
    expect(existsSync(path.join(directory, "integrations", "plugins", pluginId, "typed-adapter.ts"))).toBe(true);
    expect(process.env.NODE_OPTIONS).toBe(serverOptions);
  } finally {
    await controller.stop();
  }
});

test("integration PUT creates managed accounts and GET hides env values and paths", async () => {
  const { roomId, directory } = await makeRoom("integration-put");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const uploaded = await uploadPlugin(controller, {
      name: "adapter.js",
      platform: "telegram",
      source: PLUGIN_SOURCE,
    });
    const pluginId = uploaded.json.pluginId as string;
    const rule = {
      id: "forward",
      version: 1,
      from: { platform: "chatroom", account: "center", room: roomId, event: "message.forward_requested" },
      transforms: [],
      to: [{ platform: "telegram", account: "acct", room: "chat" }],
    };
    const url = new URL("http://center.test/channeld/integration");
    const put = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{ id: "acct", platform: "telegram", pluginId, env: { API_TOKEN: "secret-value" } }],
      rules: [rule],
    }), url);
    expect(put?.status).toBe(200);
    const putText = await put!.text();
    expect(putText).not.toContain("secret-value");
    expect(putText).not.toContain("command");
    const putBody = JSON.parse(putText) as {
      enabled: boolean;
      accounts: Array<{ id: string; pluginId: string; envKeys: string[]; state: string }>;
      rules: unknown[];
    };
    expect(putBody.enabled).toBe(true);
    expect(putBody.accounts[0]).toMatchObject({
      id: "acct",
      pluginId,
      envKeys: ["API_TOKEN"],
      state: "started",
    });
    expect(putBody.rules).toHaveLength(1);

    const managedFile = path.join(directory, "integrations", "channeld.yml");
    const managed = await Bun.file(managedFile).text();
    expect(managed).toContain("node");
    expect(managed).toContain(pluginId);
    expect(managed).toContain("secret-value");

    const get = await controller.handle(new Request(url), url);
    expect(get?.status).toBe(200);
    const getText = await get!.text();
    expect(getText).not.toContain("secret-value");
    expect(getText).not.toContain("command");
    expect(getText).not.toContain(path.join(directory, "integrations"));
    expect(JSON.parse(getText)).toMatchObject({
      enabled: true,
      accounts: [{ id: "acct", platform: "telegram", pluginId, envKeys: ["API_TOKEN"] }],
    });
    expect(controller.runtime?.config.accounts[0]?.adapter.command[0]).toBe("node");

    const targetsUrl = new URL(`http://center.test/rooms/${roomId}/forward-targets?sessionID=session-alice`);
    expect((await controller.handle(new Request(targetsUrl), targetsUrl))?.status).toBe(200);

    const disabled = await controller.handle(adminPut(url, {
      enabled: false,
      accounts: [{ id: "acct", platform: "telegram", pluginId, env: { API_TOKEN: "secret-value" } }],
      rules: [],
    }), url);
    expect(disabled?.status).toBe(200);
    expect((JSON.parse(await disabled!.text()) as { enabled: boolean }).enabled).toBe(false);
    expect(controller.enabled).toBe(false);
    expect(await controller.handle(new Request(targetsUrl), targetsUrl)).toBeUndefined();
  } finally {
    await controller.stop();
  }
});

test("integration PUT preserves, replaces, and validates inbound routes", async () => {
  const { roomId, directory } = await makeRoom("integration-inbound");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const uploaded = await uploadPlugin(controller, {
      name: "adapter.js",
      source: FEISHU_PLUGIN_SOURCE,
    });
    expect(uploaded.response?.status).toBe(201);
    const pluginId = uploaded.json.pluginId as string;
    const accounts = [{ id: "acct", platform: "feishu", pluginId }];
    const inbound = [{
      from: { platform: "feishu", account: "acct", room: "oc_allowed" },
      to: { room: roomId },
    }];
    const url = new URL("http://center.test/channeld/integration");
    const put = await controller.handle(adminPut(url, { enabled: true, accounts, inbound }), url);
    expect(put?.status).toBe(200);
    expect((JSON.parse(await put!.text()) as { inbound: unknown[] }).inbound).toEqual(inbound);

    // Saving accounts/rules without inbound keeps the existing route.
    const saveAgain = await controller.handle(adminPut(url, { enabled: true, accounts }), url);
    expect(saveAgain?.status).toBe(200);
    expect((JSON.parse(await saveAgain!.text()) as { inbound: unknown[] }).inbound).toEqual(inbound);
    expect(await Bun.file(path.join(directory, "integrations", "channeld.yml")).text()).toContain("oc_allowed");

    // Explicit [] clears it.
    const cleared = await controller.handle(adminPut(url, { enabled: true, accounts, inbound: [] }), url);
    expect(cleared?.status).toBe(200);
    expect((JSON.parse(await cleared!.text()) as { inbound: unknown[] }).inbound).toEqual([]);
    expect(await Bun.file(path.join(directory, "integrations", "channeld.yml")).text()).not.toContain("oc_allowed");

    const restored = await controller.handle(adminPut(url, { enabled: true, accounts, inbound }), url);
    expect(restored?.status).toBe(200);
    const invalid = await controller.handle(adminPut(url, {
      enabled: true,
      accounts,
      inbound: [{ from: { platform: "feishu", account: "missing", room: "oc_allowed" }, to: { room: roomId } }],
    }), url);
    expect(invalid?.status).toBe(400);
    const invalidText = await invalid!.text();
    expect(invalidText).toContain("unknown account");
    expect(invalidText).not.toContain(directory);

    const get = await controller.handle(new Request(url), url);
    expect(get?.status).toBe(200);
    expect((JSON.parse(await get!.text()) as { inbound: unknown[] }).inbound).toEqual(inbound);
  } finally {
    await controller.stop();
  }
});

test("an external channeld config is read-only in the integration API", async () => {
  const { roomId, directory } = await makeRoom("integration-external");
  const configPath = path.join(directory, "external-channeld.yml");
  const externalYaml = `stateFile: ignored.sqlite
accounts:
  - id: external
    platform: telegram
    adapter: { command: ["unused"] }
    env: { API_TOKEN: "external-secret" }
rules:
  - id: forward
    version: 1
    from: { platform: chatroom, account: center, room: ${roomId}, event: message.forward_requested }
    to: [ { platform: telegram, account: external, room: chat } ]
inbound:
  - from: { platform: telegram, account: external, room: oc_allowed }
    to: { room: ${roomId} }
`;
  writeFileSync(configPath, externalYaml);
  const controller = createChannelController(settings(configPath), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    expect(controller.enabled).toBe(true);
    const url = new URL("http://center.test/channeld/integration");
    const get = await controller.handle(new Request(url), url);
    expect(get?.status).toBe(200);
    const getText = await get!.text();
    expect(getText).not.toContain("external-secret");
    const snapshot = JSON.parse(getText) as {
      source: string;
      editable: boolean;
      accounts: Array<Record<string, unknown>>;
      rules: unknown[];
      inbound: unknown[];
    };
    expect(snapshot.source).toBe("external");
    expect(snapshot.editable).toBe(false);
    expect(snapshot.accounts).toEqual([{
      id: "external",
      platform: "telegram",
      pluginId: "",
      envKeys: ["API_TOKEN"],
      state: "started",
    }]);
    expect(snapshot.rules).toHaveLength(1);
    expect(snapshot.inbound).toHaveLength(1);

    const put = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{ id: "replacement", platform: "telegram", pluginId: "missing" }],
    }), url);
    expect(put?.status).toBe(409);
    expect(await put!.text()).toContain("external configuration file");
    expect(controller.enabled).toBe(true);
    expect(await Bun.file(configPath).text()).toBe(externalYaml);
    expect(existsSync(path.join(directory, "integrations", "channeld.yml"))).toBe(false);

    const disableUrl = new URL("http://center.test/channeld/disable");
    expect((await controller.handle(adminRequest(disableUrl), disableUrl))?.status).toBe(200);
    expect(controller.enabled).toBe(false);

    const uploaded = await uploadPlugin(controller, {
      name: "adapter.js",
      platform: "telegram",
      source: PLUGIN_SOURCE,
    });
    const pluginId = uploaded.json.pluginId as string;
    const create = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{ id: "managed", platform: "telegram", pluginId }],
      rules: [],
    }), url);
    expect(create?.status).toBe(200);
    expect((JSON.parse(await create!.text()) as { source: string }).source).toBe("managed");
    expect(existsSync(path.join(directory, "integrations", "channeld.yml"))).toBe(true);
    expect(await Bun.file(configPath).text()).toBe(externalYaml);
  } finally {
    await controller.stop();
  }
});

test("integration env edits merge, prune, clear, and never expose values", async () => {
  const { roomId, directory } = await makeRoom("integration-env");
  const envs: Array<[string, Record<string, string> | undefined]> = [];
  const spawnAdapter: SpawnAdapter = (account) => {
    envs.push([account.id, account.env]);
    return {
      start: async () => {},
      send: async () => ({ state: "sent" }),
      stop: async () => {},
    };
  };
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const uploaded = await uploadPlugin(controller, {
      name: "adapter.js",
      platform: "telegram",
      source: PLUGIN_SOURCE,
    });
    const pluginId = uploaded.json.pluginId as string;
    const url = new URL("http://center.test/channeld/integration");
    const rule = {
      id: "forward",
      version: 1,
      from: { platform: "chatroom", account: "center", room: roomId, event: "message.forward_requested" },
      transforms: [],
      to: [{ platform: "telegram", account: "acct", room: "chat" }],
    };
    const put = (env?: Record<string, string>, envDelete?: string[]) => controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{
        id: "acct",
        platform: "telegram",
        pluginId,
        ...(env === undefined ? {} : { env }),
        ...(envDelete === undefined ? {} : { envDelete }),
      }],
      rules: [rule],
    }), url);
    const managedFile = path.join(directory, "integrations", "channeld.yml");
    const lastEnv = (): Record<string, string> | undefined => {
      for (let index = envs.length - 1; index >= 0; index -= 1) {
        if (envs[index]?.[0] === "acct") return envs[index]?.[1];
      }
      return undefined;
    };

    const created = await put({ API_TOKEN: "first-secret", OTHER: "kept" });
    expect(created?.status).toBe(200);
    expect((JSON.parse(await created!.text()) as {
      accounts: Array<{ envKeys: string[] }>;
    }).accounts[0]?.envKeys).toEqual(["API_TOKEN", "OTHER"]);
    expect(lastEnv()).toEqual({ API_TOKEN: "first-secret", OTHER: "kept" });

    const merged = await put({ API_TOKEN: "second-secret" });
    expect(merged?.status).toBe(200);
    const mergedText = await merged!.text();
    expect((JSON.parse(mergedText) as {
      accounts: Array<{ envKeys: string[] }>;
    }).accounts[0]?.envKeys).toEqual(["API_TOKEN", "OTHER"]);
    expect(lastEnv()).toEqual({ API_TOKEN: "second-secret", OTHER: "kept" });
    expect(mergedText).not.toContain("second-secret");

    const preserved = await put();
    expect(preserved?.status).toBe(200);
    expect(lastEnv()).toEqual({ API_TOKEN: "second-secret", OTHER: "kept" });

    const pruned = await put(undefined, ["OTHER"]);
    expect(pruned?.status).toBe(200);
    expect(lastEnv()).toEqual({ API_TOKEN: "second-secret" });

    const patched = await put({ FRESH: "value" }, ["API_TOKEN"]);
    expect(patched?.status).toBe(200);
    expect(lastEnv()).toEqual({ FRESH: "value" });

    const cleared = await put({});
    expect(cleared?.status).toBe(200);
    expect((JSON.parse(await cleared!.text()) as {
      accounts: Array<{ envKeys: string[] }>;
    }).accounts[0]?.envKeys).toEqual([]);
    expect(lastEnv()).toEqual({});
    const clearedText = await Bun.file(managedFile).text();
    expect(clearedText).not.toContain("first-secret");
    expect(clearedText).not.toContain("second-secret");
  } finally {
    await controller.stop();
  }
});

test("integration env edits reject overlap and enforce bounds after merge", async () => {
  const { roomId, directory } = await makeRoom("integration-env-bounds");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const uploaded = await uploadPlugin(controller, {
      name: "adapter.js",
      platform: "telegram",
      source: PLUGIN_SOURCE,
    });
    const pluginId = uploaded.json.pluginId as string;
    const url = new URL("http://center.test/channeld/integration");
    const rule = {
      id: "forward",
      version: 1,
      from: { platform: "chatroom", account: "center", room: roomId, event: "message.forward_requested" },
      transforms: [],
      to: [{ platform: "telegram", account: "acct", room: "chat" }],
    };
    const put = (items: Array<Record<string, unknown>>) => controller.handle(adminPut(url, {
      enabled: true,
      accounts: items.map((item) => ({ id: "acct", platform: "telegram", pluginId, ...item })),
      rules: [rule],
    }), url);
    const managedFile = path.join(directory, "integrations", "channeld.yml");
    const envOf = (id: string) => controller.runtime?.config.accounts.find((item) => item.id === id)?.env;

    const created = await put([{ env: { KEEP: "one" } }]);
    expect(created?.status).toBe(200);
    const before = await Bun.file(managedFile).text();

    const command = await put([{ command: ["sh", "-c", "echo pwn"], args: ["--bad"] }]);
    expect(command?.status).toBe(400);
    expect(await command!.text()).toContain("managed by the server");
    expect(await Bun.file(managedFile).text()).toBe(before);
    expect(envOf("acct")).toEqual({ KEEP: "one" });

    const overlap = await put([{ env: { SECRET: "new" }, envDelete: ["SECRET"] }]);
    expect(overlap?.status).toBe(400);
    expect(await overlap!.text()).toContain("both env and envDelete");
    expect(await Bun.file(managedFile).text()).toBe(before);
    expect(envOf("acct")).toEqual({ KEEP: "one" });

    expect((await put([{ envDelete: "KEEP" }]))?.status).toBe(400);
    expect((await put([{ envDelete: ["1BAD"] }]))?.status).toBe(400);
    expect((await put([{ env: { CHANNELD_ACCOUNT_ID: "x" } }]))?.status).toBe(400);
    const kept = await put([{ envDelete: ["GHOST"] }]);
    expect(kept?.status).toBe(200);
    expect(envOf("acct")).toEqual({ KEEP: "one" });
    const removed = await put([{ envDelete: ["KEEP"] }]);
    expect(removed?.status).toBe(200);
    expect(envOf("acct")).toEqual({});
    expect((await put([{ env: {} }]))?.status).toBe(200);

    const full = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`KEY_${index}`, "v"]));
    const filled = await put([{ env: full }]);
    expect(filled?.status).toBe(200);
    expect(Object.keys(envOf("acct") ?? {})).toHaveLength(64);
    const overflow = await put([{ env: { EXTRA: "v" } }]);
    expect(overflow?.status).toBe(400);
    expect(await overflow!.text()).toContain("64");
    expect(Object.keys(envOf("acct") ?? {})).toHaveLength(64);
    expect((await put([{ env: { LONG: "x".repeat(8193) } }]))?.status).toBe(400);

    const fresh = await put([{ env: {} }, { id: "fresh", envDelete: ["GHOST"] }]);
    expect(fresh?.status).toBe(200);
    expect(controller.runtime?.config.accounts.map((item) => [item.id, item.env]))
      .toEqual([["acct", {}], ["fresh", {}]]);
  } finally {
    await controller.stop();
  }
});

test("invalid integration input keeps the old runtime and managed config", async () => {
  const { roomId, directory } = await makeRoom("integration-invalid");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter: fakeAdapter("sent").spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const uploaded = await uploadPlugin(controller, {
      name: "adapter.js",
      platform: "telegram",
      source: PLUGIN_SOURCE,
    });
    const pluginId = uploaded.json.pluginId as string;
    const url = new URL("http://center.test/channeld/integration");
    const baseRule = {
      id: "forward",
      version: 1,
      from: { platform: "chatroom", account: "center", room: roomId, event: "message.forward_requested" },
      transforms: [],
      to: [{ platform: "telegram", account: "acct", room: "chat" }],
    };
    const valid = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{ id: "acct", platform: "telegram", pluginId }],
      rules: [baseRule],
    }), url);
    expect(valid?.status).toBe(200);
    const beforeRuntime = controller.runtime;
    const managedFile = path.join(directory, "integrations", "channeld.yml");
    const beforeText = await Bun.file(managedFile).text();

    const missingTarget = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{ id: "acct", platform: "telegram", pluginId }],
      rules: [{ ...baseRule, to: [{ platform: "telegram", account: "missing", room: "chat" }] }],
    }), url);
    expect(missingTarget?.status).toBe(400);
    expect((await missingTarget!.text()).toLowerCase()).not.toContain("channeld");
    expect(controller.runtime).toBe(beforeRuntime);
    expect(await Bun.file(managedFile).text()).toBe(beforeText);

    const missingPlugin = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{ id: "acct", platform: "telegram", pluginId: "missing-plugin" }],
      rules: [baseRule],
    }), url);
    expect(missingPlugin?.status).toBe(400);
    expect(controller.runtime).toBe(beforeRuntime);
  } finally {
    await controller.stop();
  }
});

test("removing a plugin through PUT stops only its account and deletes its files", async () => {
  const { roomId, directory } = await makeRoom("integration-remove");
  const { sends, spawnAdapter } = fakeAdapter("sent");
  const controller = createChannelController(settings(undefined, false), {
    spawnAdapter,
    deliveryIntervalMs: 10,
    env: adminEnv({ CHATROOM_ALLOW_ADMIN: "true" }),
    persistSettings: () => false,
  });
  try {
    await controller.start();
    const first = await uploadPlugin(controller, {
      name: "first.js",
      platform: "telegram",
      source: PLUGIN_SOURCE,
    });
    const second = await uploadPlugin(controller, {
      name: "second.js",
      platform: "telegram",
      source: PLUGIN_SOURCE,
    });
    const firstId = first.json.pluginId as string;
    const secondId = second.json.pluginId as string;
    const url = new URL("http://center.test/channeld/integration");
    const ruleFor = (account: string) => ({
      id: `forward-${account}`,
      version: 1,
      from: { platform: "chatroom", account: "center", room: roomId, event: "message.forward_requested" },
      transforms: [],
      to: [{ platform: "telegram", account, room: "chat" }],
    });
    const both = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [
        { id: "first", platform: "telegram", pluginId: firstId },
        { id: "second", platform: "telegram", pluginId: secondId },
      ],
      rules: [ruleFor("first"), ruleFor("second")],
    }), url);
    expect(both?.status).toBe(200);
    expect(controller.runtime?.config.accounts.map((account) => account.id)).toEqual(["first", "second"]);

    const removed = await controller.handle(adminPut(url, {
      enabled: true,
      accounts: [{ id: "first", platform: "telegram", pluginId: firstId }],
      rules: [ruleFor("first")],
    }), url);
    expect(removed?.status).toBe(200);
    expect(controller.runtime?.config.accounts.map((account) => account.id)).toEqual(["first"]);
    expect(controller.runtime?.host.targetStatus("telegram", "first")).toBe("ready");
    expect(controller.runtime?.host.targetStatus("telegram", "second")).toBe("missing");
    expect(existsSync(path.join(directory, "integrations", "plugins", secondId))).toBe(false);
    expect(existsSync(path.join(directory, "integrations", "plugins", firstId))).toBe(true);

    const messageId = await sendMessage(roomId, "still healthy");
    const forwardUrl = new URL(`http://center.test/rooms/${roomId}/forward`);
    const forwarded = await controller.handle(new Request(forwardUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "session-alice",
        messageId,
        target: { platform: "telegram", account: "first", room: "chat" },
      }),
    }), forwardUrl);
    expect(forwarded?.status).toBe(202);
    await waitFor(() => sends.length === 1);
  } finally {
    await controller.stop();
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
test("a reply forward quotes its provider parent only for the same target", async () => {
  const { roomId, directory } = await makeRoom("native-reply");
  const configPath = path.join(directory, "channeld.yml");
  writeFileSync(configPath, `stateFile: ignored.sqlite
accounts:
  - id: test
    platform: telegram
    adapter: { command: ["unused"] }
  - id: other
    platform: telegram
    adapter: { command: ["unused"] }
rules:
  - id: forward
    version: 1
    from: { platform: chatroom, account: center, room: ${roomId}, event: message.forward_requested }
    to:
      - { platform: telegram, account: test, room: chat }
      - { platform: telegram, account: other, room: chat }
`);
  const target = { platform: "telegram", account: "test", room: "chat" };
  const other = { platform: "telegram", account: "other", room: "chat" };
  const { sends, spawnAdapter } = fakeAdapter("sent");
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    expect(runtime).toBeDefined();

    const first = await sendMessage(roomId, "A");
    expect(await forwardMessage(runtime, roomId, first, target)).toBe(202);
    await waitFor(() => sends.length === 1);
    await Bun.sleep(50);

    const reply = await sendReply(roomId, first, "session-alice", "B reply");
    if (reply.status !== "ok") throw new Error(`reply failed: ${reply.status}`);
    expect(await forwardMessage(runtime, roomId, reply.message.id, target)).toBe(202);
    await waitFor(() => sends.length === 2);
    expect(sends[1]!.payload).toEqual({
      text: "B reply",
      parent: { endpoint: { platform: "telegram", accountId: "test", roomId: "chat" }, nativeMessageId: "native-1" },
    });

    expect(await forwardMessage(runtime, roomId, reply.message.id, other)).toBe(202);
    await waitFor(() => sends.length === 3);
    expect(sends[2]!.payload).toEqual({ text: "B reply" });

    const unfowarded = await sendMessage(roomId, "A2");
    const reply2 = await sendReply(roomId, unfowarded, "session-alice", "B2 reply");
    if (reply2.status !== "ok") throw new Error(`reply failed: ${reply2.status}`);
    expect(await forwardMessage(runtime, roomId, reply2.message.id, target)).toBe(202);
    await waitFor(() => sends.length === 4);
    expect(sends[3]!.payload).toEqual({ text: "B2 reply" });
  } finally {
    await stopChannels(runtime);
  }
});

test("inbound Feishu events become one room notification and never outbound rules", async () => {
  const { roomId, directory } = await makeRoom("inbound-notification");
  const configPath = path.join(directory, "channeld.yml");
  writeFileSync(configPath, `stateFile: ignored.sqlite
accounts:
  - id: feishu-main
    platform: feishu
    adapter: { command: ["unused"] }
  - id: sink
    platform: telegram
    adapter: { command: ["unused"] }
rules:
  - id: must-not-run
    version: 1
    from: { platform: feishu, account: feishu-main, room: oc_allowed, event: message.created }
    to: [ { platform: telegram, account: sink, room: chat } ]
inbound:
  - from: { platform: feishu, account: feishu-main, room: oc_allowed }
    to: { room: ${roomId} }
  - from: { platform: feishu, account: feishu-main, room: oc_missing }
    to: { room: room-that-does-not-exist }
`);
  const { sends, spawnAdapter } = fakeAdapter("sent");
  let runtime: ChannelsRuntime | undefined;
  try {
    runtime = await startChannels(settings(configPath), { spawnAdapter, deliveryIntervalMs: 10 });
    expect(runtime).toBeDefined();
    const channels = runtime!;
    const event = (eventId: string, chatId = "oc_allowed"): IngestEvent => ({
      schemaVersion: 1,
      eventId,
      kind: "message.created",
      source: { platform: "feishu", accountId: "feishu-main", roomId: chatId },
      actor: { platform: "feishu", identityNamespace: "open_id", nativeUserId: "ou_alice" },
      providerEventId: eventId,
      sourceDedupKey: `feishu:feishu-main:${eventId}`,
      receivedAt: new Date(0).toISOString(),
      content: { text: "hello from feishu" },
    });

    expect((await channels.host.ingest(event("evt-1"))).duplicate).toBe(false);
    expect((await channels.host.ingest(event("evt-1"))).duplicate).toBe(true);
    await waitFor(async () => {
      const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
      return texts.filter((text) => text.startsWith("[Feishu ")).length === 1;
    });

    // A missing room target must fail the ingest (no successful ack) and stay contained.
    await expect(channels.host.ingest(event("evt-missing", "oc_missing"))).rejects.toThrow();
    const db = new DatabaseSync(databasePath());
    db.prepare("INSERT OR IGNORE INTO rooms(id,name,owner_id,created_at,kind) VALUES(?,?,?,?, 'group')")
      .run("room-that-does-not-exist", "Inbound target", "Alice", Date.now());
    db.close();

    // The retry commits and writes exactly once; a duplicate retry adds nothing.
    expect((await channels.host.ingest(event("evt-missing", "oc_missing"))).duplicate).toBe(false);
    expect((await channels.host.ingest(event("evt-missing", "oc_missing"))).duplicate).toBe(true);
    expect((await channels.host.ingest(event("evt-2"))).duplicate).toBe(false);
    await waitFor(async () => {
      const texts = await readState((svc) => svc.getRoom(roomId).messages.map((message) => message.text));
      const inbound = texts.filter((text) => text.startsWith("[Feishu "));
      return inbound.length === 2
        && inbound.some((text) => text.includes("message_id=evt-1 chat_id=oc_allowed"))
        && inbound.some((text) => text.includes("message_id=evt-2 chat_id=oc_allowed"));
    });
    const missingRoomTexts = await readState((svc) =>
      svc.getRoom("room-that-does-not-exist").messages.map((message) => message.text)
    );
    expect(missingRoomTexts).toHaveLength(1);
    expect(sends).toHaveLength(0);
  } finally {
    await stopChannels(runtime);
  }
});
