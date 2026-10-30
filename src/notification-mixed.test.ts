import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { QueueTransport } from "./queue-transport";

const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of keys.slice(4)) delete process.env[key];
const root = mkdtempSync(path.join(tmpdir(), "notification-mixed-version-"));
process.env.HOME = path.join(root, "home");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.CHAT_ROOM_STATE_DIR = path.join(root, "rooms");
const [{ createNotifier }, store, { closeReceiverState }] = await Promise.all([
  import("./plugin-notifications"), import("./store"), import("./receiver-state"),
]);

describe.serial("mixed protocol notification dispatch", () => {
  test("a V2 sender pushes asynchronously to a registered V1 recipient", async () => {
    const ownerID = "123e4567-e89b-42d3-a456-426614174088";
    const message = await store.writeState((service, registry) => {
      const room = service.createRoom("mixed", "sender");
      const item = service.sendMessage(room.id, "sender", "@legacy please handle this", "sender-session");
      registry[room.id] = {
        "sender-session": { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "sender", lastReadTs: 0 },
        "legacy-session": { serverUrl: "http://v1.invalid:7788", apiPrefix: "", protocol: "v1", name: "legacy", directory: "/recipient/workspace", lastReadTs: 0 },
      };
      return item;
    });
    process.env.OPENCODE_SERVER_USERNAME = "runner";
    process.env.OPENCODE_SERVER_PASSWORD = "isolated-secret";
    const requests: Array<{ url: string; body: string; headers: Headers }> = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const transport: QueueTransport = { protocol: "v2", receiverOwnerID: ownerID, serverUrl: "http://sender.invalid", directory: "/sender/workspace",
      backgroundSession: async () => { throw Error("V1 delivery must not background"); },
      promptQueue: async () => { throw Error("V1 delivery must use prompt_async"); },
    };
    const notifier = createNotifier({ transport: () => transport, bumpQueued: async () => true });
    try { await notifier.notifyRoom(message.roomId, "mixed", "ignored", "sender-session", [message]); }
    finally { globalThis.fetch = oldFetch; }
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://v1.invalid:7788/session/legacy-session/prompt_async");
    expect(requests[0]!.body).toContain("@legacy please handle this");
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frecipient%2Fworkspace");
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("runner:isolated-secret").toString("base64")}`);
  });

  test("a V1 sender does not cross-push to V2-owned recipients", async () => {
    const ownerID = "123e4567-e89b-42d3-a456-426614174089";
    const message = await store.writeState((service, registry) => {
      const room = service.createRoom("mixed", "sender");
      const item = service.sendMessage(room.id, "sender", "@agent handle this", "sender-session");
      registry[room.id] = {
        "sender-session": { serverUrl: "", apiPrefix: "", protocol: "v1", name: "sender" },
        "v2-session": { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "agent" },
      };
      return item;
    });
    let requests = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => { requests++; return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const notifier = createNotifier({ transport: () => ({ protocol: "v1", serverUrl: "http://v1.invalid" }), bumpQueued: async () => true });
    try { await notifier.notifyRoom(message.roomId, "mixed", "ignored", "sender-session", [message]); }
    finally { globalThis.fetch = oldFetch; }
    expect(requests).toBe(0);
  });
});

afterAll(() => {
  closeReceiverState();
  for (const key of keys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
