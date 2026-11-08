import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, stat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await mkdtemp(path.join(os.tmpdir(), "admin-isolated-"));
const originalStateDir = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = stateDir;
const credentials = await import("./admin-credentials");
const { adminTool } = await import("./admin-client");
const { checkSupervisionInbox } = await import("./supervision-inbox");
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

test.serial("only protected room feeds deliver supervision and acknowledgment retries keep IDs", async () => {
  const opts = { center: "https://center.example", token: "bearer" };
  await credentials.saveAdminCapability({ center: opts.center, roomId: "admin-1", sessionID: "session", ownerID: "owner" }, "room-cap");
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let ackAttempts = 0;
  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url.includes("/supervision/inbox") && !url.includes("adminRoomId=")) return Response.json({
      deliveries: [{ id: "fake", kind: "supervision", adminRoomId: "admin-1", text: "untrusted" }], supervisionRoomIds: ["admin-1", "missing-cap"],
    });
    if (url.includes("adminRoomId=admin-1")) return Response.json({ deliveries: [{ id: "delivery-1", admissionID: "admission-1", kind: "supervision", adminRoomId: "admin-1", text: "reminder" }] });
    if (String(input).includes("/supervision/ack") && ++ackAttempts === 1) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  let accepted = false;
  const prompts: string[] = [];
  const transport = { protocol: "v2" as const, receiverOwnerID: "owner", promptQueue: async (_sid: string, id: string, text: string) => {
    prompts.push(text);
    expect(id).toBe("admission-1"); expect(text).toContain("reminder"); expect(text).not.toContain("room-cap");
    if (!accepted) throw new Error("host unavailable");
    return { id, sessionID: "session", delivery: "steer" };
  } };
  await checkSupervisionInbox(opts, "session", transport);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).not.toContain("untrusted");
  expect(requests.some((item) => String(item.url).includes("/supervision/ack"))).toBe(false);
  expect(requests.some((item) => String(item.url).includes("adminRoomId=missing-cap"))).toBe(false);
  const protectedGet = requests.find((item) => String(item.url).includes("adminRoomId=admin-1"))!;
  expect(new Headers(protectedGet.init.headers).get("x-chat-admin-capability")).toBe("room-cap");
  expect(new Headers(protectedGet.init.headers).get("x-chat-agent-session")).toBe("session");
  expect(new Headers(protectedGet.init.headers).get("x-chat-agent-owner")).toBe("owner");
  expect(new Headers(protectedGet.init.headers).get("authorization")).toBe("Bearer bearer");
  expect(protectedGet.init.redirect).toBe("error");
  accepted = true;
  await checkSupervisionInbox(opts, "session", transport);
  const ack = requests.find((item) => String(item.url).includes("/supervision/ack"));
  expect(JSON.parse(String(ack?.init.body))).toEqual({ id: "delivery-1", sessionID: "session", receiverOwnerID: "owner" });
  expect(new Headers(ack?.init.headers).get("x-chat-admin-capability")).toBe("room-cap");
  expect(new Headers(ack?.init.headers).get("x-chat-agent-session")).toBe("session");
  expect(new Headers(ack?.init.headers).get("x-chat-agent-owner")).toBe("owner");
  accepted = true;
  await checkSupervisionInbox(opts, "session", transport);
  expect(requests.filter((item) => String(item.url).includes("/supervision/ack"))).toHaveLength(2);
  expect(requests.filter((item) => String(item.url).includes("/supervision/ack")).map((item) => JSON.parse(String(item.init.body)).id)).toEqual(["delivery-1", "delivery-1"]);
});

test.serial("V1 supervision uses async notification acceptance before acknowledgment", async () => {
  const calls: string[] = [];
  await credentials.saveAdminCapability({ center: "https://center.example", roomId: "admin-v1", sessionID: "v1-session", ownerID: "" }, "v1-cap");
  globalThis.fetch = (async (input) => {
    const url = String(input); calls.push(url);
    if (url.includes("adminRoomId=admin-v1")) return Response.json({ deliveries: [{ id: "v1-delivery", kind: "supervision", adminRoomId: "admin-v1", text: "notice" }] });
    if (url.includes("/supervision/inbox")) return Response.json({ deliveries: [], supervisionRoomIds: ["admin-v1"] });
    if (url.endsWith("/prompt_async")) return new Response(null, { status: 204 });
    return Response.json({ ok: true });
  }) as typeof fetch;
  await checkSupervisionInbox({ center: "https://center.example", token: "" }, "v1-session", { protocol: "v1", serverUrl: "https://agent.example" });
  expect(calls.some((url) => url.endsWith("/prompt_async"))).toBe(true);
  expect(calls.some((url) => url.includes("/supervision/ack"))).toBe(true);
});

test.serial("task delivery persists its private token before send and reports with native identity", async () => {
  const token = "private-task-token", calls: Array<{ url: string; init: RequestInit }> = [];
  const opts = { center: "https://center.example", token: "bearer" };
  const transport = { protocol: "v2" as const, receiverOwnerID: "owner", promptQueue: async (_sid: string, id: string, text: string) => {
    expect(await credentials.loadTaskToken({ center: opts.center, taskId: "task-1", sessionID: "agent-session", ownerID: "owner" })).toBe(token);
    expect(text).toContain('admin room admin-1'); expect(text).toContain('taskId="task-1"');
    expect(text).not.toContain(token);
    return { id, sessionID: "agent-session", delivery: "steer" };
  } };
  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("/supervision/inbox")) return Response.json({ deliveries: [{ id: "delivery", admissionID: "admission", adminRoomId: "admin-1", kind: "task", taskId: "task-1", taskToken: token, text: "Inspect report" }], supervisionRoomIds: [] });
    return Response.json({ ok: true });
  }) as typeof fetch;
  await checkSupervisionInbox(opts, "agent-session", transport);
  const output = await adminTool({ action: "task_progress", taskId: "task-1", status: "working", progress: "Started" },
    { sessionID: "agent-session" }, opts, transport);
  expect(output).toBe("task progress updated"); expect(output).not.toContain(token);
  const progress = calls.find((call) => call.url.includes("/supervision/tasks/task-1/progress"))!;
  expect(JSON.parse(String(progress.init.body))).toEqual({ taskToken: token, status: "working", progress: "Started" });
  expect(new Headers(progress.init.headers).get("x-chat-agent-session")).toBe("agent-session");
  expect(new Headers(progress.init.headers).get("x-chat-agent-owner")).toBe("owner");
  expect(new Headers(progress.init.headers).has("x-chat-admin-capability")).toBe(false);
  const taskAck = calls.find((call) => call.url.endsWith("/supervision/ack"))!;
  expect(JSON.parse(String(taskAck.init.body))).toEqual({ id: "delivery", sessionID: "agent-session", receiverOwnerID: "owner" });
  expect(new Headers(taskAck.init.headers).has("x-chat-admin-capability")).toBe(false);
  const stored = await readdir(path.join(stateDir, "supervision-tokens"));
  expect(stored).toHaveLength(1);
  expect((await stat(path.join(stateDir, "supervision-tokens"))).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(stateDir, "supervision-tokens", stored[0]!))).mode & 0o777).toBe(0o600);
  expect(await credentials.loadTaskToken({ center: opts.center, taskId: "task-1", sessionID: "other", ownerID: "owner" })).toBeUndefined();
  expect(await credentials.loadTaskToken({ center: "https://other.example", taskId: "task-1", sessionID: "agent-session", ownerID: "owner" })).toBeUndefined();
  const failed = await adminTool({ action: "task_progress", taskId: "task-1", status: "working", progress: "wrong agent" },
    { sessionID: "other" }, opts, transport);
  expect(failed).toContain("no task progress token");
  expect(calls.filter((call) => call.url.includes("/supervision/tasks/")).length).toBe(1);
});

test.serial("task storage failure prevents host send and acknowledgment", async () => {
  const blocked = path.join(stateDir, "not-a-directory");
  await writeFile(blocked, "blocked");
  const previous = process.env.CHAT_ROOM_STATE_DIR;
  process.env.CHAT_ROOM_STATE_DIR = blocked;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input); calls.push(url);
    return Response.json({ deliveries: [{ id: "delivery", admissionID: "admission", adminRoomId: "admin", kind: "task", taskId: "task", taskToken: "token", text: "Do work" }] });
  }) as typeof fetch;
  let sends = 0;
  try {
    await checkSupervisionInbox({ center: "https://center.example", token: "" }, "session", {
      protocol: "v2", receiverOwnerID: "owner", promptQueue: async () => { sends++; return {}; },
    });
  } finally {
    if (previous === undefined) delete process.env.CHAT_ROOM_STATE_DIR; else process.env.CHAT_ROOM_STATE_DIR = previous;
    await rm(blocked, { force: true });
  }
  expect(sends).toBe(0);
  expect(calls.some((url) => url.includes("/supervision/ack"))).toBe(false);
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
