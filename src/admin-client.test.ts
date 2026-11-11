import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "admin-isolated-"));
const originalStateDir = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = stateDir;
const credentials = await import("./admin-credentials");
const { adminTool, adminToolSchema } = await import("./admin-client");
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

test("public admin schema no longer accepts task or recurring-plan actions", () => {
  for (const action of ["task_progress", "admin_dispatch", "admin_tasks", "admin_task_update", "admin_plans", "admin_plan_create", "admin_plan_update", "admin_plan_delete"]) {
    expect(adminToolSchema.safeParse({ action, roomId: "room" }).success).toBe(false);
  }
  expect(adminToolSchema.safeParse({ action: "admin_overview", roomId: "room" }).success).toBe(true);
  expect(adminToolSchema.safeParse({ action: "admin_history", roomId: "room", targetRoomId: "target" }).success).toBe(true);
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
