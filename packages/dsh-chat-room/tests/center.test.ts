import { afterEach, describe, expect, test } from "bun:test";
import { CenterError, parseRoomArgs, roomAction } from "../src/center.ts";
import { resolveConfig } from "../src/config.ts";
import { startFakeCenter } from "./fake-center.ts";

const running: Array<{ stop(): void }> = [];
function center(handler: Parameters<typeof startFakeCenter>[0]) {
  const fake = startFakeCenter(handler);
  running.push(fake);
  return fake;
}
afterEach(() => {
  for (const fake of running.splice(0)) fake.stop();
});

const cfg = (url: string) => resolveConfig({ url, token: "secret" });

describe("central actions", () => {
  test("list, create, join, send and members map to central routes", async () => {
    const fake = center(({ method, path }) => {
      if (method === "GET" && path === "/rooms") return [200, [{ id: "r1", name: "dev", participants: [{}, {}] }]];
      if (method === "POST" && path === "/rooms") return [201, { id: "r1", name: "dev" }];
      if (method === "POST" && path === "/rooms/r1/join") return [201, { id: "r1", name: "dev" }];
      if (method === "POST" && path === "/rooms/r1/messages") return [200, { ok: true }];
      if (method === "GET" && path === "/rooms/r1") return [200, { participants: [{ name: "alice" }, { name: "bob" }] }];
      return undefined;
    });
    const config = cfg(fake.url);
    expect(await roomAction(config, parseRoomArgs({ action: "list" }), "dsh:s1")).toBe("r1 (dev): 2 members");
    expect(await roomAction(config, parseRoomArgs({ action: "create", name: "dev" }), "dsh:s1")).toContain("r1");
    expect(await roomAction(config, parseRoomArgs({ action: "join", roomId: "r1", name: "alice" }), "dsh:s1")).toContain("r1");
    expect(await roomAction(config, parseRoomArgs({ action: "send", roomId: "r1", text: "hi", isQuestion: true }), "dsh:s1")).toContain("r1");
    expect(await roomAction(config, parseRoomArgs({ action: "members", roomId: "r1" }), "dsh:s1")).toBe("alice\nbob");
    expect(fake.requests.every((request) => request.authorization === "Bearer secret")).toBe(true);
    expect(fake.requests.find((request) => request.path === "/rooms/r1/messages")?.body).toEqual({ sessionID: "dsh:s1", text: "hi", isQuestion: true });
    expect(fake.requests.find((request) => request.method === "POST" && request.path === "/rooms")?.body).toMatchObject({ sessionID: "dsh:s1", name: "dev" });
  });

  test("poll reads unread messages and advances the read watermark", async () => {
    const fake = center(({ method, path }) => {
      if (method === "GET" && path === "/inbox") {
        return [200, { member: true, hasMore: false, queuedTs: {}, items: [
          { id: "m1", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "hello", createdAt: 100 },
          { id: "m2", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "again", createdAt: 200 },
        ] }];
      }
      if (method === "POST" && path === "/read") return [200, { ok: true }];
      return undefined;
    });
    const result = await roomAction(cfg(fake.url), parseRoomArgs({ action: "poll", roomId: "r1" }), "dsh:s1");
    expect(result).toBe("[bob] hello\n[bob] again");
    const inbox = fake.requests.find((request) => request.path === "/inbox")!;
    expect(inbox.query.get("excludeSelf")).toBe("1");
    expect(inbox.query.get("roomId")).toBe("r1");
    expect(fake.requests.find((request) => request.path === "/read")?.body).toEqual({ roomId: "r1", sessionID: "dsh:s1", ts: 200 });
  });

  test("server failures keep their status and message", async () => {
    const fake = center(() => [403, { error: "not a member" }]);
    await expect(roomAction(cfg(fake.url), parseRoomArgs({ action: "members", roomId: "r1" }), "dsh:s1"))
      .rejects.toThrow(/403.*not a member/);
    await expect(roomAction(cfg(fake.url), parseRoomArgs({ action: "members" }), "dsh:s1")).rejects.toThrow(TypeError);
    expect(() => parseRoomArgs({ action: "explode" })).toThrow(TypeError);
    expect(() => resolveConfig({ url: "ftp://nope" })).toThrow(TypeError);
    expect(() => resolveConfig({ url: "http://127.0.0.1", deliveryIntervalMs: 10 })).toThrow(TypeError);
    expect(CenterError).toBeDefined();
  });
});