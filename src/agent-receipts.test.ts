import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import type { QueueTransport } from "./queue-transport";

const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL", "CHAT_ROOM_SERVER_HOST", "CHAT_ROOM_SERVER_PORT"] as const;
const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of keys.slice(4)) delete process.env[key];
const root = mkdtempSync(path.join(tmpdir(), "agent-receipts-"));
process.env.HOME = path.join(root, "home");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.CHAT_ROOM_STATE_DIR = path.join(root, "rooms");
process.env.CHAT_ROOM_SERVER_HOST = "127.0.0.1";
process.env.CHAT_ROOM_SERVER_PORT = String(50_000 + Math.floor(Math.random() * 10_000));
const { prepareReceiptCandidate, observeReceiptContext: observeScoped, flushReceiptCandidates, receiptDestination } = await import("./agent-receipts");
const state = await import("./receiver-state");
const prompt = "<notification>full private text</notification>";
const base = (overrides = {}) => ({
  admissionID: "admission", sessionID: "session", roomID: "room", membershipID: "membership",
  receiverOwnerID: "owner", destination: receiptDestination("https://center.invalid/base/"),
  items: [{ id: "message-1", text: "full message" }], prompt, capped: false, ...overrides,
});
const user = (id = "admission", text = prompt, role = "user") => ({ id, role, content: [{ type: "text", text }] });
const observeReceiptContext = (sessionID: string, messages: readonly unknown[], destination = "https://center.invalid/base", ownerID = "owner") => observeScoped(sessionID, messages, destination, ownerID);
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) prior[key] === undefined ? delete process.env[key] : process.env[key] = prior[key];
  state.closeReceiverState();
  rmSync(root, { recursive: true, force: true });
});

test("only exact user context ID and full-text hash make one durable receipt proof", () => {
  expect(prepareReceiptCandidate(base({ destination: "https://context.invalid" }))).toBeDefined();
  expect(observeReceiptContext("session", [user("other"), user("admission", prompt, "assistant"), user("admission", `${prompt} altered`)], "https://context.invalid")).toBe(0);
  expect(observeReceiptContext("same-display-name-other-session", [user()], "https://context.invalid")).toBe(0);
  expect(observeReceiptContext("session", [user()], "https://context.invalid")).toBe(1);
  expect(observeReceiptContext("session", [user()], "https://context.invalid")).toBe(0);
});

test("capped previews and unstable item IDs never produce a candidate", () => {
  expect(prepareReceiptCandidate(base({ capped: true }))).toBeUndefined();
  expect(prepareReceiptCandidate(base({ items: [{ text: "full message" }] }))).toBeUndefined();
  expect(observeReceiptContext("session", [user()])).toBe(0);
});

test("admission alone is not read evidence", async () => {
  const candidate = prepareReceiptCandidate(base({ admissionID: "not-yet-observed", destination: "https://unobserved.invalid" }))!;
  let uploads = 0;
  globalThis.fetch = (async () => { uploads++; return Response.json({ ok: true }); }) as unknown as typeof fetch;
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner", center: "https://unobserved.invalid" });
  expect(uploads).toBe(0);
});

test("many stalled proofs flush after watcher polling, one bounded request at a time", async () => {
  const dest = "https://stall.invalid";
  for (let i = 0; i < 4; i++) {
    prepareReceiptCandidate(base({ admissionID: `stall-${i}`, destination: dest }));
    observeReceiptContext("session", [user(`stall-${i}`)], dest);
  }
  const order: string[] = [];
  let requests = 0;
  let started!: () => void;
  const startedRequest = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/inbox?")) { order.push("poll"); return Response.json({ items: [] }); }
    requests++; order.push("request");
    started();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
  }) as unknown as typeof fetch;
  const { pollKnownSessions } = await import("../plugin");
  const options = { destination: dest, receiverOwnerID: "owner", center: dest };
  const poll = pollKnownSessions(new Set(["session"]), { protocol: "v2", receiverOwnerID: "owner" }, { center: dest, token: "" });
  await startedRequest;
  const duplicate = flushReceiptCandidates(options);
  expect(flushReceiptCandidates(options)).toBe(duplicate);
  await Promise.all([poll, duplicate]);
  expect(order.indexOf("poll")).toBeLessThan(order.indexOf("request"));
  expect(requests).toBe(1);
  const remaining = state.readyReceiptCandidates(dest, "owner", Date.now());
  expect(remaining).toHaveLength(4);
  remaining.forEach(({ id }) => state.deleteReceiptCandidate(id));
});

test("V2 prompt hook is not evidence; primary context hook marks the proof ready", async () => {
  const candidate = prepareReceiptCandidate(base({ admissionID: "hook-admission", destination: "https://hook.invalid" }))!;
  const { createV2Setup } = await import("./v2-plugin");
  const hooks = new Map<string, (input: never) => unknown>();
  const registration = { dispose: async () => {} };
  const context = {
    app: { version: "" }, location: { directory: "/isolated" },
    session: { hook: async (name: string, callback: (input: never) => unknown) => { hooks.set(name, callback); return registration; }, prompt: async () => {} },
    tool: { transform: async () => registration }, command: { transform: async () => registration },
  };
  let receiverPoll: ((ids: ReadonlySet<string>, target: QueueTransport, center: { center: string; token: string; directory?: string }) => Promise<void>) | undefined;
  const setup = createV2Setup({ runtime: (_directory, transport) => ({ protocol: "v2", selfServerUrl: "", selfDirectory: "", transport, center: { center: "https://hook.invalid", token: "" } }),
    run: (_runtime, callback) => callback(), execute: async () => "", observe: async () => {}, poll: async () => {},
    attachReceiver: (value) => { receiverPoll = value.poll; return async () => {}; } });
  const cleanup = await setup(context as never);
  let uploads = 0;
  globalThis.fetch = (async () => { uploads++; return Response.json({ acceptedIDs: ["message-1"] }); }) as unknown as typeof fetch;
  await hooks.get("prompt")!({ sessionID: "session" } as never);
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner", center: "https://hook.invalid" });
  expect(uploads).toBe(0);
  await hooks.get("context")!({ sessionID: "session", messages: [user("hook-admission")] } as never);
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner", center: "https://hook.invalid" });
  expect(uploads).toBe(0);
  await receiverPoll!(new Set(["session"]), { protocol: "v2", receiverOwnerID: "owner" }, { center: "https://hook.invalid", token: "" });
  await hooks.get("context")!({ sessionID: "session", messages: [user("hook-admission")] } as never);
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner", center: "https://hook.invalid" });
  expect(uploads).toBe(1);
  await cleanup();
});

test("first context lazily resolves the verified owner and marks its receipt", async () => {
  const candidate = prepareReceiptCandidate(base({ admissionID: "first-context", destination: "https://first-context.invalid" }))!;
  const { createV2Setup } = await import("./v2-plugin");
  let hook!: (input: never) => void | Promise<void>, lookups = 0, uploads = 0;
  const registration = { dispose: async () => {} };
  const setup = createV2Setup({ runtime: (_directory, transport) => ({ protocol: "v2", selfServerUrl: "", selfDirectory: "", transport, center: { center: "https://first-context.invalid", token: "" } }),
    run: (_runtime, callback) => callback(), execute: async () => "", observe: async () => {}, poll: async () => {},
    resolveOwner: async () => { lookups++; return "owner"; }, attachReceiver: () => async () => {} });
  const context = { app: { version: "" }, location: { directory: "/isolated" },
    session: { hook: async (name: string, callback: (input: never) => unknown) => { if (name === "context") hook = callback as (input: never) => void | Promise<void>; return registration; }, prompt: async () => {} },
    tool: { transform: async () => registration }, command: { transform: async () => registration } };
  const cleanup = await setup(context as never);
  globalThis.fetch = (async () => { uploads++; return Response.json({ acceptedIDs: ["message-1"] }); }) as unknown as typeof fetch;
  await hook({ sessionID: "session", messages: [user("first-context")] } as never);
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner", center: "https://first-context.invalid" });
  expect(lookups).toBe(1);
  expect(uploads).toBe(1);
  await cleanup();
});

test("center delivery preserves the ownerless V2 fallback", async () => {
  const { pushItemsToSession } = await import("./center-inbox");
  let prompts = 0;
  globalThis.fetch = (async () => Response.json({ session: { protocol: "v2", receiverOwnerID: "verified-owner", membershipID: "membership", name: "agent" } })) as unknown as typeof fetch;
  await pushItemsToSession({ center: "https://owner-gate.invalid", token: "" }, "session", [
    { id: "owner-gated-message", roomId: "owner-gated-room", roomName: "test", senderId: "alice", text: "full text", createdAt: 10 },
  ], { protocol: "v2", promptQueue: async () => { prompts++; } });
  expect(prompts).toBe(1);
});

test("ready proof survives queue cleanup and restart across transient center failure", async () => {
  const originalCandidate = prepareReceiptCandidate(base({ admissionID: "restart-admission" }))!;
  state.deletePendingAdmission("session", "room");
  expect(observeReceiptContext("session", [user("restart-admission")])).toBe(1);
  let calls = 0;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    bodies.push(JSON.parse(String(init?.body)));
    return calls === 1 ? new Response("{}", { status: 503 }) : Response.json({ acceptedIDs: ["message-1"] });
  }) as unknown as typeof fetch;
  const options = { destination: originalCandidate.destination, receiverOwnerID: "owner", center: "https://center.invalid/base", token: "current-token" };
  await flushReceiptCandidates({ ...options, receiverOwnerID: "wrong-owner" });
  await flushReceiptCandidates({ ...options, destination: "https://other.invalid" });
  expect(calls).toBe(0);
  await flushReceiptCandidates(options);
  state.closeReceiverState();
  await flushReceiptCandidates(options);
  await flushReceiptCandidates(options);
  expect(calls).toBe(2);
  expect(bodies[1]).toEqual({ sessionID: "session", membershipID: "membership", receiverOwnerID: "owner", messageIDs: ["message-1"], evidence: "context" });
  expect(JSON.stringify(bodies)).not.toContain("current-token");
});

test("a membership-generation conflict discards stale proof", async () => {
  const candidate = prepareReceiptCandidate(base({ admissionID: "rejoined-admission", roomID: "rejoined-room" }))!;
  observeReceiptContext("session", [user("rejoined-admission")]);
  globalThis.fetch = (async () => new Response("membership changed", { status: 409 })) as unknown as typeof fetch;
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner", center: "https://center.invalid/base" });
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner", center: "https://center.invalid/base" });
  expect(observeReceiptContext("session", [user("rejoined-admission")])).toBe(0);
});

test("malformed successful receipt responses keep proof for retry", async () => {
  const candidate = prepareReceiptCandidate(base({ admissionID: "wrong-ack", destination: "https://bad-ack.invalid" }))!;
  observeReceiptContext("session", [user("wrong-ack")], candidate.destination);
  globalThis.fetch = (async () => Response.json({ acceptedIDs: ["different-id"] })) as unknown as typeof fetch;
  const options = { destination: candidate.destination, receiverOwnerID: "owner", center: "https://bad-ack.invalid" };
  await flushReceiptCandidates(options);
  expect(state.readyReceiptCandidates(candidate.destination, "owner", Date.now())).toHaveLength(1);
  globalThis.fetch = (async () => Response.json({ acceptedIDs: ["message-1"] })) as unknown as typeof fetch;
  await flushReceiptCandidates(options);
  expect(state.readyReceiptCandidates(candidate.destination, "owner", Date.now())).toHaveLength(0);
});

test("standalone flush rejects proof from a previous membership generation", async () => {
  const store = await import("./store");
  const roomID = await store.writeState((service, registry) => {
    const room = service.createRoom("receipt-room", "room-owner");
    service.joinRoom(room.id, { id: "session", name: "agent" });
    registry[room.id] = { session: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: "owner", membershipID: "new-generation", name: "agent" } };
    return room.id;
  });
  const candidate = prepareReceiptCandidate(base({ admissionID: "stale-local", roomID, membershipID: "old-generation", destination: receiptDestination("") }))!;
  observeReceiptContext("session", [user("stale-local")], candidate.destination);
  await flushReceiptCandidates({ destination: candidate.destination, receiverOwnerID: "owner" });
  expect(observeReceiptContext("session", [user("stale-local")], candidate.destination)).toBe(0);
});

test("explicit center poll receipts only the returned IDs with captured recipient identity", async () => {
  const { centerAction } = await import("./center-client");
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const value = { url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(value);
    if (value.url.endsWith("/registry")) return Response.json({ session: { membershipID: "membership", receiverOwnerID: "owner" } });
    if (value.url.includes("/inbox?")) return Response.json({ member: true, items: [
      { id: "returned-1", senderId: "alice", text: "one", createdAt: 10 },
      { id: "returned-2", senderId: "bob", text: "two", createdAt: 11 },
    ] });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  await centerAction({ center: "https://poll.invalid", token: "" }, { action: "poll", roomId: "room" }, "session");
  expect(calls.at(-1)?.body).toEqual({ roomId: "room", sessionID: "session", ts: 11,
    messageIDs: ["returned-1", "returned-2"], membershipID: "membership", evidence: "tool", receiverOwnerID: "owner" });
});

test("membership conflict never falls back to an unguarded center read", async () => {
  const { centerAction } = await import("./center-client");
  const reads: unknown[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/registry")) return Response.json({ session: { membershipID: "old" } });
    if (String(url).includes("/inbox?")) return Response.json({ member: true, items: [{ id: "id", senderId: "a", text: "x", createdAt: 1 }] });
    reads.push(init?.body && JSON.parse(String(init.body)));
    return new Response("rejoined", { status: 409 });
  }) as unknown as typeof fetch;
  await centerAction({ center: "https://poll.invalid", token: "" }, { action: "poll", roomId: "room" }, "session");
  expect(reads).toHaveLength(1);
  expect(reads[0]).toMatchObject({ membershipID: "old", messageIDs: ["id"], evidence: "tool" });
});

test("older centers keep the legacy cursor poll without fabricating receipts", async () => {
  const { centerAction } = await import("./center-client");
  const reads: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/registry")) return new Response("missing", { status: 404 });
    if (String(url).includes("/inbox?")) return Response.json({ member: true, items: [{ id: "returned", senderId: "a", text: "x", createdAt: 2 }] });
    reads.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  await centerAction({ center: "https://old-center.invalid", token: "" }, { action: "poll", roomId: "room" }, "session");
  expect(reads).toEqual([{ roomId: "room", sessionID: "session", ts: 2 }]);
});

test("standalone explicit poll records only its returned message IDs as tool evidence", async () => {
  const store = await import("./store");
  const { acknowledgeStandalonePoll } = await import("../plugin");
  const fixture = await store.writeState((service, registry) => {
    const room = service.createRoom("tool-receipt-room", "owner");
    service.joinRoom(room.id, { id: "reader", name: "shared-name" });
    service.joinRoom(room.id, { id: "sender", name: "shared-name" });
    const returned = service.sendMessage(room.id, "sender", "returned", "sender-1");
    const unseen = service.sendMessage(room.id, "sender", "unseen", "sender-2");
    unseen.createdAt = returned.createdAt + 100;
    (registry[room.id] ??= {}).reader = { serverUrl: "", apiPrefix: "", protocol: "v2", receiverOwnerID: "owner-id", name: "shared-name", membershipID: "membership-id", lastReadTs: 0 };
    return { roomID: room.id, returned, unseen };
  });
  await acknowledgeStandalonePoll(fixture.roomID, "reader", fixture.returned.createdAt, [fixture.returned], { membershipID: "membership-id", receiverOwnerID: "owner-id" });
  expect(await store.readReceipts(fixture.roomID, [fixture.returned.id])).toEqual([{ messageID: fixture.returned.id, readers: [expect.objectContaining({ sessionID: "reader", evidence: "tool" })] }]);
  expect(await store.readReceipts(fixture.roomID, [fixture.unseen.id])).toEqual([{ messageID: fixture.unseen.id, readers: [] }]);
  await acknowledgeStandalonePoll(fixture.roomID, "reader", fixture.unseen.createdAt, [fixture.unseen], { membershipID: "rejoined-generation", receiverOwnerID: "owner-id" });
  expect((await store.loadRegistry())[fixture.roomID]?.reader?.lastReadTs).toBe(fixture.returned.createdAt);
  expect(await store.readReceipts(fixture.roomID, [fixture.unseen.id])).toEqual([{ messageID: fixture.unseen.id, readers: [] }]);
});

test("ownerless V2 standalone polls advance through every page with exact receipts", async () => {
  const store = await import("./store"), { acknowledgeStandalonePoll } = await import("../plugin");
  const fixture = await store.writeState((service, registry) => {
    const room = service.createRoom("ownerless-poll", "sender");
    service.joinRoom(room.id, { id: "reader", name: "Reader" });
    const messages = Array.from({ length: 205 }, (_, i) => service.sendMessage(room.id, "sender", `message-${i}`, "sender-session"));
    registry[room.id] = { reader: { serverUrl: "", apiPrefix: "/api", protocol: "v2", membershipID: "ownerless-generation", name: "Reader", lastReadTs: 0 } };
    return { roomID: room.id, messages };
  });
  const pageSizes: number[] = [], readIDs: string[] = [];
  let cursor = 0;
  while (true) {
    const page = await store.readUnreadMessages(fixture.roomID, cursor, 100, "reader", "Reader");
    if (!page.items.length) break;
    pageSizes.push(page.items.length);
    readIDs.push(...page.items.map((item) => item.id));
    await acknowledgeStandalonePoll(fixture.roomID, "reader", page.items.at(-1)!.createdAt, page.items, { membershipID: "ownerless-generation" });
    cursor = (await store.loadRegistry())[fixture.roomID]!.reader!.lastReadTs!;
  }
  expect(pageSizes).toEqual([100, 100, 5]);
  expect(readIDs).toEqual(fixture.messages.map((message) => message.id));
  const firstPage = await store.readReceipts(fixture.roomID, readIDs.slice(0, 100));
  expect(firstPage!.every((item) => item.readers[0]?.evidence === "tool")).toBe(true);
});

test("ownerless V2 central polls advance through the real inbox and read routes", async () => {
  const store = await import("./store"), { centerAction } = await import("./center-client");
  const token = "isolated-poll-token", previousToken = process.env.CHAT_ROOM_SERVER_TOKEN;
  process.env.CHAT_ROOM_SERVER_TOKEN = token;
  const server = (await import("../server/chat-server")).default, originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => server.fetch(new Request(input, init))) as typeof fetch;
  try {
    const fixture = await store.writeState((service, registry) => {
      const room = service.createRoom("ownerless-central-poll", "sender");
      service.joinRoom(room.id, { id: "reader", name: "Reader" });
      const messages = Array.from({ length: 205 }, (_, i) => service.sendMessage(room.id, "sender", `message-${i}`, "sender-session"));
      registry[room.id] = { reader: { serverUrl: "", apiPrefix: "/api", protocol: "v2", membershipID: "central-ownerless-generation", name: "Reader", lastReadTs: 0, lastQueuedTs: 0 } };
      return { roomID: room.id, messages };
    });
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const text = await centerAction({ center: "http://center.invalid", token }, { action: "poll", roomId: fixture.roomID }, "reader");
      sizes.push((text.match(/message-\d+/g) ?? []).length);
    }
    expect(sizes).toEqual([100, 100, 5]);
    expect((await store.loadRegistry())[fixture.roomID]!.reader!.lastReadTs).toBe(fixture.messages.at(-1)!.createdAt);
    const receipts = await store.readReceipts(fixture.roomID, fixture.messages.slice(0, 100).map((message) => message.id));
    expect(receipts!.every((item) => item.readers[0]?.evidence === "tool")).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    previousToken === undefined ? delete process.env.CHAT_ROOM_SERVER_TOKEN : process.env.CHAT_ROOM_SERVER_TOKEN = previousToken;
  }
});

test("owned V2 reads require the owner and current join generation", async () => {
  const store = await import("./store");
  const ownerID = "123e4567-e89b-42d3-a456-426614174000", otherOwner = "123e4567-e89b-42d3-a456-426614174001";
  process.env.CHAT_ROOM_SERVER_TOKEN = "isolated-poll-token";
  const server = (await import("../server/chat-server")).default;
  const fixture = await store.writeState((service, registry) => {
    const room = service.createRoom("owned-poll", "sender");
    service.joinRoom(room.id, { id: "Reader", name: "Reader" });
    const message = service.sendMessage(room.id, "sender", "proof", "sender-session");
    registry[room.id] = { reader: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, membershipID: "old-generation", name: "Reader", lastReadTs: 0 } };
    return { roomID: room.id, message };
  });
  const postRead = (membershipID: string, receiverOwnerID?: string) => server.fetch(new Request("http://local/read", {
    method: "POST", headers: { Authorization: "Bearer isolated-poll-token", "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: fixture.roomID, sessionID: "reader", ts: fixture.message.createdAt, messageIDs: [fixture.message.id], membershipID, evidence: "tool", ...(receiverOwnerID ? { receiverOwnerID } : {}) }),
  }));
  expect((await postRead("old-generation")).status).toBe(409);
  expect((await postRead("old-generation", otherOwner)).status).toBe(409);
  expect((await postRead("wrong-generation", ownerID)).status).toBe(409);
  expect((await store.loadRegistry())[fixture.roomID]!.reader!.lastReadTs).toBe(0);
  expect((await postRead("old-generation", ownerID)).status).toBe(200);
  await server.fetch(new Request(`http://local/rooms/${fixture.roomID}/leave`, { method: "POST", headers: { Authorization: "Bearer isolated-poll-token", "Content-Type": "application/json" }, body: JSON.stringify({ sessionID: "reader" }) }));
  await server.fetch(new Request(`http://local/rooms/${fixture.roomID}/join`, { method: "POST", headers: { Authorization: "Bearer isolated-poll-token", "Content-Type": "application/json" }, body: JSON.stringify({ sessionID: "reader", participantId: "Reader", participantName: "Reader", protocol: "v2", receiverOwnerID: ownerID }) }));
  const current = (await store.loadRegistry())[fixture.roomID]!.reader!;
  expect(current.membershipID).not.toBe("old-generation");
  expect((await postRead("old-generation", ownerID)).status).toBe(409);
  expect((await store.loadRegistry())[fixture.roomID]!.reader!.lastReadTs).toBe(current.lastReadTs);
});
