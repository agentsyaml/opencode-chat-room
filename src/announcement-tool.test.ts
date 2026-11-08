import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const directory = mkdtempSync(path.join(tmpdir(), "chat-room-announcement-tool-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = directory;
const store = await import("./store");
const { runAnnouncementTool } = await import("./announcement-tool");
const { centerAction } = await import("./center-client");
const roomID = await store.writeState((service) => service.createRoom("__Test_tool", "owner").id);
const memberRoom = await store.writeState((service, registry) => {
  const room = service.createRoom("__Test_tool_member", "owner");
  registry[room.id] = { member: { serverUrl: "", apiPrefix: "", name: "agent" } };
  return room.id;
});
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

test("standalone tool validates writes and never joins rooms", async () => {
  expect(await runAnnouncementTool({ action: "announcement_write", roomId: roomID, announcementName: "x" }, "outsider")).toContain("content");
  expect(await runAnnouncementTool({ action: "announcement_write", roomId: roomID, announcementName: "x", content: 8 as never }, "outsider")).toContain("content");
  expect(await runAnnouncementTool({ action: "announcement_write", roomId: roomID, announcementName: "x".repeat(65), content: "ok" }, "outsider")).toContain("name");
  expect(await runAnnouncementTool({ action: "announcement_write", roomId: roomID, announcementName: "x", content: "😀".repeat(5001) }, "outsider")).toContain("content");
  expect(await runAnnouncementTool({ action: "announcement_write", roomId: roomID, announcementName: "x", content: "ok" }, "outsider")).toBe("error: not joined");
  expect(await store.loadRegistry()).not.toHaveProperty(roomID);
  expect(await runAnnouncementTool({ action: "announcement_write", roomId: memberRoom, announcementName: "x", content: "ok" }, "member")).toBe("announcement saved: x");
  expect(await runAnnouncementTool({ action: "announcement_read", roomId: memberRoom, announcementName: "x" }, "outsider")).toContain("ok");
  expect((await store.loadRegistry())[memberRoom]).toHaveProperty("member");
});

test("central tool actions use only announcement endpoints and preserve request bodies", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(input), method: init?.method ?? "GET", body });
    const data = init?.method === "PUT" ? { announcement: { name: "plan", content: body.content } } : init?.method === "DELETE" ? { ok: true } : init?.method === "GET" && String(input).endsWith("/plan") ? { announcement: { name: "plan", content: "read" } } : { announcements: [] };
    return Response.json(data);
  }, { preconnect: originalFetch.preconnect });
  const opts = { center: "http://__Test_center", token: "token" };
  await centerAction(opts, { action: "announcement_list", roomId: "r" }, "s");
  await centerAction(opts, { action: "announcement_read", roomId: "r", announcementName: "plan" }, "s");
  await centerAction(opts, { action: "announcement_write", roomId: "r", announcementName: "plan", content: "body" }, "s");
  await centerAction(opts, { action: "announcement_delete", roomId: "r", announcementName: "plan" }, "s");
  expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT", "DELETE"]);
  expect(requests[2]?.body).toEqual({ sessionID: "s", content: "body" });
  expect(requests.every(({ url }) => url.includes("/rooms/r/announcements"))).toBe(true);
  globalThis.fetch = originalFetch;
});
