import { afterEach, describe, expect, test } from "bun:test";
import { apply, type HostAgent, type HostContext, type RawToolDefinition, type ToolRun } from "../src/plugin.ts";
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

interface Injected {
  id: string;
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  source: { kind: string };
}

function harness(config: { url: string; deliveryIntervalMs?: number }) {
  let definition: RawToolDefinition | undefined;
  let onResult: ((exec: ToolRun) => unknown) | undefined;
  const injected: Injected[] = [];
  const agent: HostAgent = {
    session: { id: "session-1" },
    inject(message) {
      injected.push(message as Injected);
    },
  };
  const ctx = {
    tools: { register(value: RawToolDefinition) { definition = value as RawToolDefinition; } },
    on(_event: "tools/result", handler: (exec: ToolRun) => unknown) { onResult = handler as typeof onResult; },
  };
  apply(ctx as unknown as HostContext, { ...config, token: "secret" });
  const signal = new AbortController().signal;
  return {
    definition: definition!,
    injected,
    run: (args: unknown) => definition!.execute(args, { agent, signal }),
    emit: () => onResult!({ agent, signal }),
  };
}

const config = (url: string) => ({ url, deliveryIntervalMs: 1000 });

describe("room plugin", () => {
  test("join tracks the session and the next tool result injects unread context once", async () => {
    const fake = center(({ method, path }) => {
      if (method === "POST" && path === "/rooms/r1/join") return [201, { id: "r1", name: "dev" }];
      if (method === "GET" && path === "/inbox") {
        return [200, { member: true, hasMore: false, queuedTs: {}, items: [
          { id: "m1", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "hello room", createdAt: 100 },
        ] }];
      }
      if (method === "POST" && path === "/read") return [200, { ok: true }];
      return undefined;
    });
    const h = harness(config(fake.url));
    expect(h.definition.name).toBe("room");
    expect(h.definition.parameters).toMatchObject({ required: ["action"] });
    expect((h.definition.parameters.properties as Record<string, { maxLength?: number }>).text?.maxLength).toBe(5000);
    const properties = h.definition.parameters.properties as Record<string, { enum?: string[]; type?: string; maxItems?: number; maxLength?: number }>;
    expect(properties.action?.enum).toContain("task_list");
    expect(properties.status?.enum).toEqual(["todo", "doing", "done"]);
    expect(properties.dueDate?.type).toBe("string");
    expect(properties.participants?.maxItems).toBe(50);
    expect(properties.conclusion?.maxLength).toBe(5000);
    expect(properties.steps?.maxItems).toBe(30);
    expect(await h.run({ action: "join", roomId: "r1", name: "alice" })).toEqual({ text: "joined room r1 (dev)" });
    expect(fake.requests.find((request) => request.path === "/rooms/r1/join")?.body).toMatchObject({
      sessionID: "dsh:session-1", participantId: "alice", participantName: "alice",
    });
    const joinBody = fake.requests.find((request) => request.path === "/rooms/r1/join")?.body as { host?: unknown } | undefined;
    expect(String(joinBody?.host ?? "").length).toBeGreaterThan(0);

    await h.emit();
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]!.source.kind).toBe("dsh-chat-room");
    expect(h.injected[0]!.content[0]!.text).toContain("bob: (id: m1) hello room");
    expect(fake.requests.find((request) => request.path === "/read")?.body).toEqual({ roomId: "r1", sessionID: "dsh:session-1", ts: 100 });

    await h.emit();
    expect(h.injected).toHaveLength(1);
    expect(fake.requests.filter((request) => request.path === "/inbox")).toHaveLength(1);
  });

  test("leave stops delivery once the last room is left", async () => {
    let member = false;
    const fake = center(({ method, path }) => {
      if (method === "POST" && path === "/rooms/r1/join") { member = true; return [200, { id: "r1", name: "dev" }]; }
      if (method === "POST" && path === "/rooms/r1/leave") { member = false; return [200, { id: "r1", name: "dev" }]; }
      if (method === "GET" && path === "/inbox") return [200, { member, items: [], hasMore: false, queuedTs: {} }];
      return undefined;
    });
    const h = harness(config(fake.url));
    await h.run({ action: "join", roomId: "r1", name: "alice" });
    await h.run({ action: "leave", roomId: "r1" });
    await h.emit();
    expect(fake.requests.filter((request) => request.path === "/inbox")).toHaveLength(1);
    expect(h.injected).toHaveLength(0);
    await expect(h.definition.execute({ action: "members" }, { signal: new AbortController().signal }))
      .rejects.toThrow(/calling agent/);
    await expect(h.run({ action: "members" })).rejects.toThrow(TypeError);
  });

  test("leaving one room keeps delivery for the other", async () => {
    const rooms = new Set<string>();
    const fake = center(({ method, path }) => {
      const join = path.match(/^\/rooms\/(r[12])\/join$/);
      if (method === "POST" && join) { rooms.add(join[1]!); return [200, { id: join[1], name: join[1] }]; }
      const leave = path.match(/^\/rooms\/(r[12])\/leave$/);
      if (method === "POST" && leave) { rooms.delete(leave[1]!); return [200, { id: leave[1], name: leave[1] }]; }
      if (method === "GET" && path === "/inbox") {
        return [200, { member: rooms.size > 0, hasMore: false, queuedTs: {}, items: rooms.has("r2") ? [
          { id: "m2", roomId: "r2", roomName: "room two", roomKind: "group", senderId: "bob", text: "still here", createdAt: 200 },
        ] : [] }];
      }
      if (method === "POST" && path === "/read") return [200, { ok: true }];
      return undefined;
    });
    const h = harness(config(fake.url));
    await h.run({ action: "join", roomId: "r1", name: "alice" });
    await h.run({ action: "join", roomId: "r2", name: "alice" });
    await h.run({ action: "leave", roomId: "r1" });
    await h.emit();
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]!.content[0]!.text).toContain("still here");
    expect(fake.requests.find((request) => request.path === "/read")?.body).toMatchObject({ roomId: "r2" });

    await h.run({ action: "leave", roomId: "r2" });
    await h.emit();
    expect(h.injected).toHaveLength(1);
  });

  test("a non-member inbox reply clears the subscription", async () => {
    const fake = center(({ method, path }) => {
      if (method === "POST" && path === "/rooms/r1/join") return [201, { id: "r1", name: "dev" }];
      if (method === "GET" && path === "/inbox") return [200, { member: false, items: [], hasMore: false, queuedTs: {} }];
      return undefined;
    });
    const h = harness(config(fake.url));
    await h.run({ action: "join", roomId: "r1", name: "alice" });
    await h.emit();
    await h.emit();
    expect(fake.requests.filter((request) => request.path === "/inbox")).toHaveLength(1);
  });

  test("create sends an agent host so protected rooms classify it as an agent", async () => {
    const fake = center(({ method, path }) => {
      if (method === "POST" && path === "/rooms") return [201, { id: "r1", name: "dev" }];
      if (method === "GET" && path === "/inbox") return [200, { member: true, items: [], hasMore: false, queuedTs: {} }];
      return undefined;
    });
    const h = harness(config(fake.url));
    expect(await h.run({ action: "create", name: "dev" })).toEqual({ text: "created room r1 (dev)" });
    const body = fake.requests.find((request) => request.path === "/rooms")?.body as { host?: unknown } | undefined;
    expect(String(body?.host ?? "").length).toBeGreaterThan(0);
  });

  test("a joined join_status starts delivery after a pending join", async () => {
    const fake = center(({ method, path }) => {
      if (method === "POST" && path === "/rooms/r1/join") return [202, { status: "pending" }];
      if (method === "GET" && path === "/rooms/r1/join-requests/status") return [200, { status: "joined" }];
      if (method === "GET" && path === "/inbox") return [200, { member: true, hasMore: false, queuedTs: {}, items: [
        { id: "m1", roomId: "r1", roomName: "dev", roomKind: "group", senderId: "bob", text: "approved", createdAt: 100 },
      ] }];
      return undefined;
    });
    const h = harness(config(fake.url));
    expect((await h.run({ action: "join", roomId: "r1", name: "alice" })).text).toContain("pending:");
    await h.emit();
    expect(h.injected).toHaveLength(0);
    expect(await h.run({ action: "join_status", roomId: "r1" })).toEqual({ text: "joined room r1" });
    await h.emit();
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]!.content[0]!.text).toContain("approved");
  });

  test("poll requires an explicit room so it cannot mark another room read", async () => {
    const fake = center(() => [200, { member: true, items: [], hasMore: false, queuedTs: {} }]);
    const h = harness(config(fake.url));
    await expect(h.run({ action: "poll" })).rejects.toThrow(/poll requires roomId/);
    expect(fake.requests).toHaveLength(0);
  });

  test("central failures reject the tool call", async () => {
    const fake = center(() => [500, { error: "boom" }]);
    const h = harness(config(fake.url));
    await expect(h.run({ action: "join", roomId: "r1", name: "alice" })).rejects.toThrow(/500.*boom/);
  });
});