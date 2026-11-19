import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { deleteAgentResource } from "../center/center-client.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("delete resource client sends the session header and fails safely", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(url), init });
    return Response.json({ ok: true });
  }, { preconnect: originalFetch.preconnect });
  const result = await deleteAgentResource({ center: "https://center.example", token: "secret" }, "room-1", "resource-1", "session-1");
  expect(result).toBe("deleted resource resource-1");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://center.example/rooms/room-1/resources/resource-1");
  expect(calls[0]!.init?.method).toBe("DELETE");
  const headers = calls[0]!.init?.headers as Record<string, string>;
  expect(headers["X-Session-ID"]).toBe("session-1");
  expect(headers.Authorization).toBe("Bearer secret");
  expect(headers["Content-Type"]).toBe("application/json");
});

test("delete resource client reports server errors instead of throwing", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ error: "forbidden" }, { status: 403 }), { preconnect: originalFetch.preconnect });
  await expect(deleteAgentResource({ center: "https://center.example", token: "" }, "room-1", "resource-1", "session-1")).resolves.toBe("error: forbidden");
  await expect(deleteAgentResource({ center: "", token: "" }, "room-1", "resource-1", "session-1")).resolves.toContain("error: resource deletion requires");
  await expect(deleteAgentResource({ center: "https://center.example", token: "" }, "", "resource-1", "session-1")).resolves.toBe("error: roomId is required; use a room UUID from the room list, not the room name");
  await expect(deleteAgentResource({ center: "https://center.example", token: "" }, "room-1", "", "session-1")).resolves.toBe("error: resourceId is required; use the resource UUID returned by upload_resource");
});

test("the room tool dispatches delete_resource to the center", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "resource-delete-tool-"));
  const previous = { url: process.env.CHAT_ROOM_SERVER_URL, token: process.env.CHAT_ROOM_SERVER_TOKEN, state: process.env.CHAT_ROOM_STATE_DIR };
  process.env.CHAT_ROOM_SERVER_URL = "https://center.example";
  process.env.CHAT_ROOM_SERVER_TOKEN = "secret";
  process.env.CHAT_ROOM_STATE_DIR = dir;
  let deleted: { url: string; session?: string | null } | undefined;
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.method === "DELETE") {
      deleted = { url: String(url), session: new Headers(init.headers).get("x-session-id") };
      return Response.json({ ok: true });
    }
    return Response.json({});
  }, { preconnect: originalFetch.preconnect });
  try {
    const { setup, roomArgs } = await import("../../plugin.ts");
    const { roomSchema } = await import("../runtime/v2-plugin.ts");
    expect(roomArgs.safeParse({ action: "delete_resource", roomId: "room-1", resourceId: "resource-1" }).success).toBe(true);
    expect(roomSchema().safeParse({ action: "delete_resource", roomId: "room-1", resourceId: "resource-1" }).success).toBe(true);
    const registered: Array<Record<string, any>> = [];
    const dispose = async () => {};
    const context = {
      location: { directory: dir }, app: {},
      session: { hook: async () => ({ dispose }), prompt: async () => ({}) },
      skill: { transform: async (callback: any) => { callback({ get: () => undefined, add: () => {} }); return { dispose }; } },
      tool: { transform: async (callback: any) => { callback({ add: (tool: Record<string, any>) => { registered.push(tool); } }); return { dispose }; } },
      command: { transform: async () => ({ dispose }) }, permission: { assert: async () => {} },
    };
    const stop = await setup(context as never);
    try {
      const room = registered.find((tool) => tool.name === "room");
      const result = await room!.execute({ action: "delete_resource", roomId: "room-1", resourceId: "resource-1" }, { sessionID: "session-1", agent: "agent", messageID: "m", id: "c", signal: new AbortController().signal });
      expect(result.content[0].text).toBe("deleted resource resource-1");
      expect(deleted).toEqual({ url: "https://center.example/rooms/room-1/resources/resource-1", session: "session-1" });
    } finally { await stop(); }
  } finally {
    for (const [key, value] of Object.entries({ CHAT_ROOM_SERVER_URL: previous.url, CHAT_ROOM_SERVER_TOKEN: previous.token, CHAT_ROOM_STATE_DIR: previous.state })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});