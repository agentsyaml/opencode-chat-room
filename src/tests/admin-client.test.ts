import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "admin-isolated-"));
const originalStateDir = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = stateDir;
const credentials = await import("../agent/admin-credentials.ts");
const { adminTool } = await import("../agent/admin-client.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(async () => {
  try { await rm(stateDir, { recursive: true, force: true }); }
  finally { if (originalStateDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR; else process.env.CHAT_ROOM_STATE_DIR = originalStateDir; }
});

test.serial("claim binds native identity, persists capability privately, and never returns it", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ capability: "secret-cap", adminRoom: { roomId: "admin" } }), { status: 200 });
  }) as typeof fetch;
  const result = await adminTool({ action: "admin_claim", roomId: "admin", enrollmentKey: "one-time" },
    { sessionID: "native-session" }, { center: "https://center.example", token: "normal-token" },
    { protocol: "v2", receiverOwnerID: "native-owner" });
  expect(result).not.toContain("secret-cap");
  expect(result).not.toContain("one-time");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sessionID: "native-session", receiverOwnerID: "native-owner", enrollmentKey: "one-time" });
  expect(await credentials.loadAdminCapability({ center: "https://center.example", roomId: "admin", sessionID: "native-session", ownerID: "native-owner" })).toBe("secret-cap");
  expect(await credentials.loadAdminCapability({ center: "https://center.example", roomId: "admin", sessionID: "other-session", ownerID: "native-owner" })).toBeUndefined();
  expect(await credentials.loadAdminCapability({ center: "https://center.example", roomId: "admin", sessionID: "native-session", ownerID: "other-owner" })).toBeUndefined();
  expect(await credentials.loadAdminCapability({ center: "https://other.example", roomId: "admin", sessionID: "native-session", ownerID: "native-owner" })).toBeUndefined();
  expect(await credentials.loadAdminCapability({ center: "https://center.example", roomId: "other-room", sessionID: "native-session", ownerID: "native-owner" })).toBeUndefined();
  const files = await readdir(path.join(stateDir, "admin-capabilities"));
  expect(files).toHaveLength(1);
  expect(files[0]!.endsWith(".json")).toBe(true);
  expect(files.join()).not.toContain("secret-cap");
  expect((await stat(path.join(stateDir, "admin-capabilities", files[0]!))).mode & 0o777).toBe(0o600);
  expect((await stat(path.join(stateDir, "admin-capabilities"))).mode & 0o777).toBe(0o700);
});

test.serial("claim failures never echo enrollment keys or capabilities", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ error: "one-time secret-cap rejected" }, { status: 409 }), { preconnect: originalFetch.preconnect });
  const output = await adminTool({ action: "admin_claim", roomId: "admin", enrollmentKey: "one-time" },
    { sessionID: "native-session" }, { center: "https://center.example", token: "" },
    { protocol: "v2", receiverOwnerID: "native-owner" });
  expect(output).not.toContain("one-time");
  expect(output).not.toContain("secret-cap");
  expect(output).toContain("HTTP 409");
});

test.serial("designated admin removes members through the kick endpoint", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return Response.json({ ok: true });
  }, { preconnect: originalFetch.preconnect });
  const args = { action: "admin_remove_member", roomId: "room-1", targetSessionID: "target-1" } as const;
  const transport = { protocol: "v2" as const, receiverOwnerID: "agent-owner" };
  const output = await adminTool(args, { sessionID: "agent-session" }, { center: "https://center.example", token: "normal-token" }, transport);
  expect(output).toBe('{"ok":true}');
  expect(calls[0]!.url).toBe("https://center.example/rooms/room-1/kick");
  expect(calls[0]!.init.method).toBe("POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers["X-Chat-Agent-Session"]).toBe("agent-session");
  expect(headers["X-Chat-Agent-Owner"]).toBe("agent-owner");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sessionID: "agent-session", targetSessionID: "target-1" });
  globalThis.fetch = Object.assign(async () => Response.json({ error: "the designated agent administrator cannot remove human administrators" }, { status: 403 }), { preconnect: originalFetch.preconnect });
  const denied = await adminTool(args, { sessionID: "agent-session" }, { center: "https://center.example", token: "" }, transport);
  expect(denied).toBe("error: the designated agent administrator cannot remove human administrators");
  expect(await adminTool({ ...args, targetSessionID: "" }, { sessionID: "agent-session" }, { center: "https://center.example", token: "" }, transport)).toBe("error: targetSessionID is required");
});
