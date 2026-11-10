import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { backgroundServiceKey } from "./queue-transport";

const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR"] as const;
const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const root = mkdtempSync(path.join(tmpdir(), "room-notification-races-"));
process.env.HOME = path.join(root, "home");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_STATE_HOME = path.join(root, "xdg-state");
process.env.CHAT_ROOM_STATE_DIR = path.join(root, "rooms");
const [store, { createNotifier }, receiverState, queue, inbox, { wakeSessions }] = await Promise.all([
  import("./store"), import("./plugin-notifications"), import("./receiver-state"), import("./queue"), import("./center-inbox"), import("./center-wake"),
]);
const { closeReceiverState } = receiverState;
const initialFetch = globalThis.fetch;
async function waitForGate(gate: Promise<void>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([gate, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("notification race gate timed out")), 5_000);
    })]);
  } finally { clearTimeout(timer!); }
}
const ownerID = "123e4567-e89b-42d3-a456-426614174078";
const sessionID = "race-session";

describe.serial("notification membership races", () => {
  test("local removal during backgrounding cannot retract an admitted prompt", async () => {
    const { roomID, triggerTs } = await store.writeState((service, registry) => {
      const room = service.createRoom("race", "owner");
      service.joinRoom(room.id, { id: "alice", name: "alice" });
      const message = service.sendMessage(room.id, "alice", "@agent handle this", "sender");
      registry[room.id] = { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "agent", lastReadTs: 0 } };
      return { roomID: room.id, triggerTs: message.createdAt };
    });
    let entered!: () => void, release!: (value: boolean) => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const background = new Promise<boolean>((resolve) => { release = resolve; });
    let prompts = 0, bumps = 0;
    const notifier = createNotifier({ transport: () => ({ protocol: "v2" }), bumpQueued: async () => { bumps++; return true; } });
    const delivery = notifier.notifyTarget(sessionID, { roomId: roomID, roomName: "race", messages: [
      { id: "trigger", roomId: roomID, senderId: "alice", senderSessionID: "sender", text: "@agent handle this", createdAt: triggerTs },
    ] }, {
      protocol: "v2", receiverOwnerID: ownerID,
      backgroundSession: async () => { entered(); return background; },
      promptQueue: async (sid: string, id: string, _text: string, delivery: "queue" | "steer") => {
        prompts++; return { id, sessionID: sid, delivery };
      },
    });
    try {
      await waitForGate(waiting);
      await store.writeState((_service, registry) => { delete registry[roomID]; });
    } finally {
      release(false);
      await delivery;
    }
    expect(prompts).toBe(1);
    expect(bumps).toBe(1);
    expect(queue.pendingAdmission(sessionID, roomID)?.state).toBe("admitted");
    expect(receiverState.claimBackgroundAttempt(sessionID, roomID, backgroundServiceKey({ protocol: "v2", receiverOwnerID: ownerID }), triggerTs)).toBe(false);
  });

  test("read-through after rejoin prunes an old pending request before a new steer", async () => {
    const roomID = `rejoin-${crypto.randomUUID()}`, oldTs = Date.now() - 2, newTs = Date.now() - 1;
    await store.writeState((service, registry) => {
      service.hydrate([{ id: roomID, name: "rejoin", ownerId: "owner", createdAt: 0, participants: new Map(), messages: [] }]);
      registry[roomID] = { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "agent", lastReadTs: 0 } };
    });
    const old = { id: "pre-leave", roomId: roomID, senderId: "alice", senderSessionID: "sender", text: "@agent old", createdAt: oldTs };
    const newer = { ...old, id: "post-rejoin", text: "@agent new", createdAt: newTs };
    const prompts: string[] = [], ids: string[] = [];
    let sends = 0;
    const notifier = createNotifier({ transport: () => ({ protocol: "v2" }), bumpQueued: async () => true });
    const transport = { protocol: "v2" as const, receiverOwnerID: ownerID, backgroundSession: async () => false,
      promptQueue: async (sid: string, id: string, text: string, delivery: "queue" | "steer") => {
        ids.push(id); prompts.push(text); if (sends++ === 0) throw Error("lost response"); return { id, sessionID: sid, delivery };
      } };
    await notifier.notifyTarget(sessionID, { roomId: roomID, roomName: "rejoin", messages: [old] }, transport);
    await store.writeState((_service, registry) => {
      delete registry[roomID]![sessionID];
      registry[roomID]![sessionID] = { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "agent", lastReadTs: oldTs };
    });
    await notifier.notifyTarget(sessionID, { roomId: roomID, roomName: "rejoin", messages: [old, newer] }, transport);
    expect(ids[1]).not.toBe(ids[0]);
    expect(prompts[1]).not.toContain("@agent old");
    expect(prompts[1]).toContain("@agent new");
  });

  test("normalizes pre-version pending admissions before persisting one background claim", () => {
    const roomID = `legacy-admission-${crypto.randomUUID()}`, now = Date.now();
    receiverState.savePendingAdmission(sessionID, roomID, {
      id: "stable-legacy-id", prompt: "old request", itemCount: 1, maxTs: 1, capped: false,
      state: "pending", items: [{ senderId: "alice", text: "@agent work", createdAt: 1 }],
    }, now + 60_000, now);
    const admission = queue.pendingAdmission(sessionID, roomID)!;
    expect(Number.isFinite(admission.createdAt)).toBe(true);
    expect(receiverState.claimBackgroundAttempt(sessionID, roomID, "service", admission.maxTs)).toBe(true);
    expect(receiverState.claimBackgroundAttempt(sessionID, roomID, "service", admission.maxTs)).toBe(false);
  });

  test("a pending retry keeps its quote, but refreshes admission when the excerpt changes", () => {
    const roomID = `answer-retry-${crypto.randomUUID()}`;
    const item = { id: "answer", senderId: "alice", text: "yes", createdAt: 10, answerQuestionExcerpt: "old question" };
    const first = queue.getOrCreatePendingAdmission(sessionID, roomID, [item], "prompt with old question", 10, false);
    const retry = queue.getOrCreatePendingAdmission(sessionID, roomID, [item], "prompt with old question", 10, false);
    const later = { ...item, id: "later", createdAt: 11, text: "later message" };
    const originalRetry = queue.getOrCreatePendingAdmission(sessionID, roomID, [item, later], "combined prompt", 11, false);
    const refreshedItem = { ...item, answerQuestionExcerpt: "updated question" };
    const refreshed = queue.getOrCreatePendingAdmission(sessionID, roomID, [refreshedItem], "prompt with updated question", 10, false);
    expect(retry.id).toBe(first.id);
    expect(originalRetry.id).toBe(first.id);
    expect(refreshed.id).not.toBe(first.id);
    expect(refreshed.prompt).toContain("updated question");
  });

  test("watermarks survive clock advance, 1024 other admissions, and receiver restart", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const roomID = `durable-${crypto.randomUUID()}`;
    try {
      expect(receiverState.claimBackgroundAttempt(sessionID, roomID, "service", 100)).toBe(true);
      now += 6 * 60_000;
      for (let index = 0; index < 1_025; index++) {
        expect(receiverState.claimBackgroundAttempt(sessionID, `other-${index}`, "service", index + 1)).toBe(true);
      }
      receiverState.closeReceiverState();
      expect(receiverState.claimBackgroundAttempt(sessionID, roomID, "service", 100)).toBe(false);
    } finally {
      Date.now = originalNow;
      receiverState.closeReceiverState();
    }
  });

  test("an accepted steer with failed queue acknowledgement cannot re-background the old unread message", async () => {
    const roomID = `ack-failure-${crypto.randomUUID()}`, triggerTs = Date.now();
    await store.writeState((service, registry) => {
      service.hydrate([{ id: roomID, name: "ack", ownerId: "owner", createdAt: 0, participants: new Map(), messages: [] }]);
      registry[roomID] = { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "agent", lastReadTs: 0 } };
    });
    let backgrounds = 0;
    const ids: string[] = [];
    const notifier = createNotifier({ transport: () => ({ protocol: "v2" }), bumpQueued: async () => false });
    const transport = { protocol: "v2" as const, receiverOwnerID: ownerID,
      backgroundSession: async () => { backgrounds++; return false; },
      promptQueue: async (sid: string, id: string, _text: string, delivery: "queue" | "steer") => {
        ids.push(id); return { id, sessionID: sid, delivery };
      } };
    const batch = { roomId: roomID, roomName: "ack", messages: [
      { id: "unread", roomId: roomID, senderId: "alice", senderSessionID: "sender", text: "@agent work", createdAt: triggerTs },
    ] };
    await notifier.notifyTarget(sessionID, batch, transport);
    queue.clearPendingAdmission(sessionID, roomID, Number.MAX_SAFE_INTEGER);
    await notifier.notifyTarget(sessionID, batch, transport);
    expect(backgrounds).toBe(1);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  test("local watermark advances only through explicitly addressed messages", async () => {
    const roomID = `addressed-${crypto.randomUUID()}`;
    await store.writeState((service, registry) => {
      service.hydrate([{ id: roomID, name: "addressed", ownerId: "owner", createdAt: 0, participants: new Map(), messages: [] }]);
      registry[roomID] = { [sessionID]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", receiverOwnerID: ownerID, name: "agent", lastReadTs: 0 } };
    });
    const addressed = { id: "a", roomId: roomID, senderId: "alice", senderSessionID: "alice-session", text: "@all first", createdAt: 100 };
    const ordinary = { ...addressed, id: "b", text: "routine follow-up", createdAt: 110 };
    const newer = { ...addressed, id: "c", text: "<at>@所有人</at> next", createdAt: 120 };
    const backgrounds: number[] = [], prompts: string[] = [];
    let sends = 0;
    const notifier = createNotifier({ transport: () => ({ protocol: "v2" }), bumpQueued: async (_room, _sid, ts) => {
      await store.writeState((_service, registry) => { registry[roomID]![sessionID]!.lastQueuedTs = ts; });
      queue.clearPendingAdmission(sessionID, roomID, ts); return true;
    } });
    const transport = { protocol: "v2" as const, receiverOwnerID: ownerID,
      backgroundSession: async () => { backgrounds.push(backgrounds.length + 1); return false; },
      promptQueue: async (sid: string, id: string, text: string, delivery: "queue" | "steer") => {
        prompts.push(text); return { id: sends++ ? id : "lost-response", sessionID: sid, delivery };
      } };
    await notifier.notifyTarget(sessionID, { roomId: roomID, roomName: "addressed", messages: [addressed] }, transport);
    await notifier.notifyTarget(sessionID, { roomId: roomID, roomName: "addressed", messages: [addressed, ordinary] }, transport);
    await notifier.notifyTarget(sessionID, { roomId: roomID, roomName: "addressed", messages: [addressed, ordinary, newer] }, transport);
    expect(backgrounds).toEqual([1, 2]);
    expect(prompts[1]).toContain("routine follow-up");
    expect(prompts[2]).toContain("<at>@所有人</at> next");
    expect(prompts[2]).not.toContain("@all first");
  });

  test("central removal during verification prevents steer and background", async () => {
    const roomID = `center-${crypto.randomUUID()}`, triggerTs = Date.now();
    let registryReads = 0, prompts = 0, backgrounds = 0, queued = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/registry")) {
        registryReads++;
        return Response.json(registryReads === 1 ? { [sessionID]: { name: "agent", protocol: "v2", receiverOwnerID: ownerID, roomKind: "group" } } : {});
      }
      if (init?.method === "POST" && String(input).includes("/queued")) queued++;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const delivery = inbox.pushItemsToSession({ center: "http://center.invalid", token: "test" }, sessionID, [
        { id: "message", roomId: roomID, roomName: "race", senderId: "alice", text: "@agent handle this", createdAt: triggerTs },
      ], { protocol: "v2", receiverOwnerID: ownerID,
        backgroundSession: async () => { backgrounds++; return false; },
        promptQueue: async () => { prompts++; return {}; },
      });
      await delivery;
    } finally { globalThis.fetch = oldFetch; }
    expect(registryReads).toBe(2);
    expect(prompts).toBe(0);
    expect(backgrounds).toBe(0);
    expect(queued).toBe(0);
    expect(queue.pendingAdmission(sessionID, roomID)).toBeUndefined();
    expect(receiverState.claimBackgroundAttempt(sessionID, roomID, backgroundServiceKey({ protocol: "v2", receiverOwnerID: ownerID }, "http://center.invalid"), triggerTs)).toBe(true);
  });

  test("center pushes reject a kicked legacy member but still deliver to a current protocol-less member", async () => {
    const opts = { center: "http://center.invalid", token: "test" };
    const roomID = `legacy-${crypto.randomUUID()}`;
    const item = { id: "legacy-msg", roomId: roomID, roomName: "legacy", senderId: "alice", text: "@agent work", createdAt: Date.now() };
    let registryReads = 0, sent = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/registry")) return Response.json(++registryReads === 1 ? { [sessionID]: { name: "agent", lastReadTs: 0 } } : {});
      if (url.includes("primary.invalid")) { sent++; return new Response(null, { status: 404 }); }
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await inbox.pushItemsToSession(opts, sessionID, [item], { protocol: "v1", serverUrl: "http://primary.invalid" });
    } finally { globalThis.fetch = oldFetch; }
    expect(registryReads).toBe(2);
    expect(sent).toBe(0);

    const validFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/registry")) return Response.json({ [sessionID]: { name: "agent", lastReadTs: 0 } });
      if (url.includes("serve.invalid")) { sent++; return new Response(null, { status: 204 }); }
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      expect(await inbox.pushItemsToSession(opts, sessionID, [item], { protocol: "v1", serverUrl: "http://serve.invalid" })).toBe("delivered");
    } finally { globalThis.fetch = validFetch; }
    expect(sent).toBe(1);
  });

  test("serve fallback shares group, broadcast, direct, self, and system addressing rules", async () => {
    const opts = { center: "http://center.invalid", token: "test" };
    const oldFetch = globalThis.fetch;
    const cases = [
      ["@all work", "group", "alice", "other", true],
      ["<at>@所有人</at> work", "group", "alice", "other", true],
      ["ordinary direct text", "direct", "alice", "other", true],
      ["@agent self", "group", "alice", sessionID, false],
      ["@agent system", "group", "system", "system", false],
    ] as const;
    try {
      for (const [text, roomKind, senderId, senderSessionID, expected] of cases) {
        const roomID = `wake-${crypto.randomUUID()}`;
        let sent = 0;
        const item = { id: roomID, roomId: roomID, roomName: "wake", senderId, senderSessionID, text, createdAt: Date.now(), roomKind };
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("center.invalid/rooms/summary")) return Response.json([{ id: roomID, latestMsgTs: item.createdAt }]);
          if (url.includes("/registry")) return Response.json({ [sessionID]: { name: "agent", protocol: "v1", host: hostname(), roomKind, lastReadTs: 0 } });
          if (url.includes("/inbox")) return Response.json({ items: [item], queuedTs: {} });
          if (url.includes("/wake-claim")) return Response.json({ ok: true });
          if (url.includes("primary.invalid")) return new Response(null, { status: 404 });
          if (url.includes("serve.invalid")) { sent++; return new Response(null, { status: 204 }); }
          return Response.json({ ok: true });
        }) as typeof fetch;
        await wakeSessions(opts, { protocol: "v1", serverUrl: "http://primary.invalid" }, "http://serve.invalid");
        expect(sent === 1).toBe(expected);
      }
    } finally { globalThis.fetch = oldFetch; }
  });

  test("serve fallback rechecks V1 membership after the wake claim", async () => {
    const opts = { center: "http://center.invalid", token: "test" }, roomID = `wake-race-${crypto.randomUUID()}`;
    let registryReads = 0, served = 0;
    const oldFetch = globalThis.fetch;
    const member = { name: "agent", protocol: "v1" as const, host: hostname(), roomKind: "group" as const, lastReadTs: 0 };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("center.invalid/rooms/summary")) return Response.json([{ id: roomID, latestMsgTs: 20 }]);
      if (url.includes("/registry")) return Response.json(++registryReads < 5 ? { [sessionID]: member } : {});
      if (url.includes("/inbox")) return Response.json({ items: [{ id: "@all", roomId: roomID, roomName: "race", senderId: "alice", text: "@all work", createdAt: 20 }], queuedTs: {} });
      if (url.includes("/wake-claim")) return Response.json({ ok: true });
      if (url.includes("primary.invalid")) return new Response(null, { status: 404 });
      if (url.includes("serve.invalid")) { served++; return new Response(null, { status: 204 }); }
      return Response.json({ ok: true });
    }) as typeof fetch;
    try { await wakeSessions(opts, { protocol: "v1", serverUrl: "http://primary.invalid" }, "http://serve.invalid"); }
    finally { globalThis.fetch = oldFetch; }
    expect(registryReads).toBe(5);
    expect(served).toBe(0);
  });

  test("central read advances during backgrounding and filters the next request", async () => {
    const roomID = `read-${crypto.randomUUID()}`, oldTs = Date.now() - 20_000, newTs = oldTs + 1;
    const opts = { center: "http://center.invalid", token: "test" };
    let readTs = 0, backgrounds = 0, prompts: string[] = [], entered!: () => void, release!: (value: boolean) => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const background = new Promise<boolean>((resolve) => { release = resolve; });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/registry")) return Response.json({ [sessionID]: { protocol: "v2", receiverOwnerID: ownerID, name: "agent", lastReadTs: readTs, roomKind: "group" } });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const batch = [
      { id: "old", roomId: roomID, roomName: "read", senderId: "alice", text: "@agent old", createdAt: oldTs },
      { id: "new", roomId: roomID, roomName: "read", senderId: "alice", text: "@agent new", createdAt: newTs },
    ];
    const transport = { protocol: "v2" as const, receiverOwnerID: ownerID,
      backgroundSession: async () => { if (++backgrounds === 1) { entered(); return background; } return false; },
      promptQueue: async (sid: string, id: string, text: string, delivery: "queue" | "steer") => { prompts.push(text); return { id, sessionID: sid, delivery }; },
    };
    let first: Promise<unknown> | undefined;
    try {
      first = inbox.pushItemsToSession(opts, sessionID, batch, transport);
      await waitForGate(waiting);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("@agent old");
      expect(prompts[0]).toContain("@agent new");
      readTs = oldTs;
      release(false);
      await first;
      expect(queue.pendingAdmission(sessionID, roomID)).toBeUndefined();
      await inbox.pushItemsToSession(opts, sessionID, batch, transport);
    } finally {
      release(false);
      if (first) await first;
      globalThis.fetch = oldFetch;
    }
    expect(backgrounds).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("@agent old");
    expect(prompts[1]).toContain("@agent new");
  });

  test("central watermark ignores ordinary items but advances for a newer mention", async () => {
    const roomID = `center-addressed-${crypto.randomUUID()}`, opts = { center: "http://center.invalid", token: "test" };
    let queuedTs = 0, backgrounds = 0, sends = 0;
    const prompts: string[] = [], oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/registry")) return Response.json({ [sessionID]: { name: "agent", protocol: "v2", receiverOwnerID: ownerID, lastReadTs: 0, lastQueuedTs: queuedTs, roomKind: "group" } });
      if (url.includes("/queued") && init?.method === "POST") queuedTs = Number((JSON.parse(String(init.body)) as { ts: number }).ts);
      return Response.json({ ok: true });
    }) as typeof fetch;
    const addressed = { id: "a", roomId: roomID, roomName: "center", senderId: "alice", senderSessionID: "alice-session", text: "<at>@all</at> first", createdAt: 100 };
    const ordinary = { ...addressed, id: "b", text: "routine follow-up", createdAt: 110 };
    const newer = { ...addressed, id: "c", text: "@所有人 next", createdAt: 120 };
    const transport = { protocol: "v2" as const, receiverOwnerID: ownerID,
      backgroundSession: async () => { backgrounds++; return false; },
      promptQueue: async (sid: string, id: string, text: string, delivery: "queue" | "steer") => {
        prompts.push(text); return { id: sends++ ? id : "lost-response", sessionID: sid, delivery };
      } };
    try {
      await inbox.pushItemsToSession(opts, sessionID, [addressed], transport);
      await inbox.pushItemsToSession(opts, sessionID, [addressed, ordinary], transport);
      await inbox.pushItemsToSession(opts, sessionID, [addressed, ordinary, newer], transport);
    } finally { globalThis.fetch = oldFetch; }
    expect(backgrounds).toBe(2);
    expect(prompts[1]).toContain("routine follow-up");
    expect(prompts[2]).toContain("@所有人 next");
    expect(prompts[2]).not.toContain("<at>@all</at> first");
  });
});

afterAll(() => {
  closeReceiverState();
  for (const key of keys) {
    const value = prior[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => { globalThis.fetch = initialFetch; });
