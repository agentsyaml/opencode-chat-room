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
    expect(await h.run({ action: "join", roomId: "r1", name: "alice" })).toEqual({ text: "joined room r1 (dev)" });
    expect(fake.requests.find((request) => request.path === "/rooms/r1/join")?.body).toMatchObject({
      sessionID: "dsh:session-1", participantId: "alice", participantName: "alice",
    });

    await h.emit();
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]!.source.kind).toBe("dsh-chat-room");
    expect(h.injected[0]!.content[0]!.text).toContain("bob: hello room");
    expect(fake.requests.find((request) => request.path === "/read")?.body).toEqual({ roomId: "r1", sessionID: "dsh:session-1", ts: 100 });

    await h.emit();
    expect(h.injected).toHaveLength(1);
    expect(fake.requests.filter((request) => request.path === "/inbox")).toHaveLength(1);
  });

  test("leave stops delivery and missing context is rejected", async () => {
    const fake = center(({ method, path }) => {
      if (method === "POST" && (path === "/rooms/r1/join" || path === "/rooms/r1/leave")) return [200, { id: "r1", name: "dev" }];
      if (method === "GET" && path === "/inbox") return [200, { member: true, items: [], hasMore: false, queuedTs: {} }];
      return undefined;
    });
    const h = harness(config(fake.url));
    await h.run({ action: "join", roomId: "r1", name: "alice" });
    await h.run({ action: "leave", roomId: "r1" });
    await h.emit();
    expect(fake.requests.filter((request) => request.path === "/inbox")).toHaveLength(0);
    await expect(h.definition.execute({ action: "members" }, { signal: new AbortController().signal }))
      .rejects.toThrow(/calling agent/);
    await expect(h.run({ action: "members" })).rejects.toThrow(TypeError);
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

  test("central failures reject the tool call", async () => {
    const fake = center(() => [500, { error: "boom" }]);
    const h = harness(config(fake.url));
    await expect(h.run({ action: "join", roomId: "r1", name: "alice" })).rejects.toThrow(/500.*boom/);
  });
});