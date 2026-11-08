import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { adminTool } from "./admin-client";
import { checkSupervisionInbox } from "./supervision-inbox";

if (!process.env.CHAT_ROOM_ADMIN_INTEGRATION_CHILD) {
  test("admin supervision works over an isolated real server", async () => {
    const child = Bun.spawn([process.execPath, "test", "src/admin-integration.test.ts"], {
      env: { ...process.env, CHAT_ROOM_ADMIN_INTEGRATION_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${stdout}${stderr}`);
  });
} else {
  test("operator binding, worker delivery, timer coalescing, and restart persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admin-integration-"));
    const state = path.join(root, "db"), serverToken = "server-secret", adminToken = "operator-secret";
    await import("node:fs/promises").then(({ mkdir }) => mkdir(state, { recursive: true }));
    process.env.CHAT_ROOM_STATE_DIR = state;
    process.env.XDG_STATE_HOME = path.join(root, "xdg");
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.HOME = path.join(root, "home");
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("no port")); const value = address.port; server.close(() => resolve(value)); });
    });
    const env = { ...process.env, HOME: path.join(root, "home"), XDG_STATE_HOME: path.join(root, "xdg"), XDG_CONFIG_HOME: path.join(root, "config"), CHAT_ROOM_STATE_DIR: state, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: serverToken, CHAT_ROOM_ADMIN_TOKEN: adminToken };
    const base = `http://127.0.0.1:${port}`, auth = { Authorization: `Bearer ${serverToken}` };
    let server: ReturnType<typeof Bun.spawn> | undefined;
    const start = async () => {
      server = Bun.spawn([process.execPath, "run", "server/chat-server.ts"], { cwd: process.cwd(), env, stdout: "ignore", stderr: "pipe" });
      for (let n = 0; n < 100; n++) { if (server.exitCode !== null) throw new Error("server exited during startup"); try { const r = await fetch(`${base}/rooms`, { headers: auth }); if (r.ok) return; } catch {} await Bun.sleep(25); }
      throw new Error("server did not start");
    };
    const stop = async () => { if (server && server.exitCode === null) { server.kill(); await server.exited; } server = undefined; };
    const api = async (method: string, route: string, body?: unknown, headers: Record<string, string> = auth) => fetch(`${base}${route}`, { method, headers: { ...headers, ...(body !== undefined || method === "DELETE" ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let adminRoom: string | undefined;
    try {
      const opts = { center: base, token: serverToken };
      await start();
      const makeRoom = async (name: string) => { const r = await api("POST", "/rooms", { name: `__Test_${name}`, ownerId: "__Test_owner" }); expect(r.status).toBe(201); return (await r.json() as { id: string }).id; };
      adminRoom = await makeRoom("admin"); const supervisorRoom = await makeRoom("supervisor"), workerRoom = await makeRoom("worker");
      const join = async (room: string, sessionID: string, owner: string, name: string) => {
        const r = await api("POST", `/rooms/${room}/join`, { sessionID, participantId: name, participantName: name, protocol: "v2", receiverOwnerID: owner }); expect(r.status).toBe(201);
      };
      const supervisorOwner = randomUUID(), workerOwner = randomUUID();
      await join(supervisorRoom, "__Test_supervisor-session", supervisorOwner, "__Test_supervisor");
      await join(workerRoom, "__Test_worker-session", workerOwner, "__Test_worker");
      const registry = await (await api("GET", `/rooms/${supervisorRoom}/registry`)).json() as Record<string, { membershipID: string }>;
      const supervisorMember = registry["__Test_supervisor-session"]?.membershipID;
      expect(supervisorMember).toBeTruthy();
      const operatorHeaders = { ...auth, "x-chat-admin-token": adminToken };
      expect((await api("POST", "/admin/rooms", { roomId: adminRoom, targetRoomId: supervisorRoom, sessionID: "__Test_supervisor-session", receiverOwnerID: supervisorOwner, membershipID: supervisorMember }, { "x-chat-admin-token": serverToken })).status).toBe(401);
      expect((await api("POST", "/admin/rooms", { roomId: "forged-room", targetRoomId: supervisorRoom, sessionID: "__Test_supervisor-session", receiverOwnerID: supervisorOwner, membershipID: supervisorMember }, {})).status).toBe(401);
      const bound = await api("POST", "/admin/rooms", { roomId: adminRoom, targetRoomId: supervisorRoom, sessionID: "__Test_supervisor-session", receiverOwnerID: supervisorOwner, membershipID: supervisorMember }, operatorHeaders);
      expect(bound.status).toBe(201);
      const enrollmentKey = (await bound.json() as { enrollmentKey: string }).enrollmentKey;
      const transport = { protocol: "v2" as const, receiverOwnerID: supervisorOwner };
      const claimed = await adminTool({ action: "admin_claim", roomId: adminRoom, enrollmentKey }, { sessionID: "__Test_supervisor-session" }, opts, transport);
      expect(claimed).toContain("enrolled"); expect(claimed).not.toContain(enrollmentKey);
      const overview = async () => JSON.parse(await adminTool({ action: "admin_overview", roomId: adminRoom }, { sessionID: "__Test_supervisor-session" }, opts, transport));
      const before = await api("GET", `/rooms/${workerRoom}/members`); const beforeMembers = await before.json();
      const sent: Array<{ id: string; text: string; delivery: string }> = [];
      const workerTransport = { protocol: "v2" as const, receiverOwnerID: workerOwner, promptQueue: async (_session: string, id: string, text: string, delivery: "queue" | "steer") => { sent.push({ id, text, delivery }); return { id, sessionID: "__Test_worker-session", delivery, prompt: { text } }; } };
      const dispatched = await adminTool({ action: "admin_dispatch", roomId: adminRoom, targetRoomId: workerRoom, targetSessionID: "__Test_worker-session", text: "__Test_secret task" }, { sessionID: "__Test_supervisor-session" }, opts, transport);
      expect(dispatched).toContain('"task"');
      const workerInbox = await api("GET", `/supervision/inbox?sessionID=__Test_worker-session&receiverOwnerID=${workerOwner}`);
      const taskDeliveries = (await workerInbox.json()) as { deliveries: Array<{ taskToken: string; targetRoomId: string }> };
      expect(taskDeliveries.deliveries).toHaveLength(1);
      expect(taskDeliveries.deliveries[0]!.targetRoomId).toBe(workerRoom);
      expect(taskDeliveries.deliveries[0]!.taskToken).toBeTruthy();
      expect(dispatched).not.toContain("taskToken");
      await checkSupervisionInbox(opts, "__Test_worker-session", workerTransport);
      expect(sent).toHaveLength(1); expect(sent[0]!.delivery).toBe("steer"); expect(sent[0]!.text).toContain("__Test_secret task");
      expect(sent[0]!.text).not.toContain("taskToken");
      const taskId = sent[0]!.text.match(/Task ID: ([^.]*)/)?.[1]; expect(taskId).toBeTruthy();
      const progress = await adminTool({ action: "task_progress", taskId, status: "working", progress: "__Test_progress" }, { sessionID: "__Test_worker-session" }, opts, workerTransport);
      expect(progress).toBe("task progress updated");
      expect(JSON.stringify(await overview())).toContain("__Test_progress");
      expect(await (await api("GET", `/rooms/${workerRoom}/members`)).json()).toEqual(beforeMembers);

      const planResult = await adminTool({ action: "admin_plan_create", roomId: adminRoom, name: "__Test_timer", intervalSeconds: 60, text: "__Test_reminder" }, { sessionID: "__Test_supervisor-session" }, opts, transport);
      const planId = (JSON.parse(planResult) as { plan: { id: string } }).plan.id;
      const database = (await import("./store")).databasePath();
      const db = await import("./sqlite-state"); await db.openStateDatabase(database);
      await (await import("../server/admin-state")).ensureAdminSchema();
      const { tickAdminScheduler } = await import("../server/admin-scheduler"); const now = Date.now();
      await db.withStateTransaction(database, d => d.query("UPDATE admin_plans SET next_run_at=? WHERE id=?").run(now - 1, planId));
      await tickAdminScheduler(now);
      const reminder = async () => db.withStateTransaction(database, d => d.query("SELECT id,admission_id FROM admin_deliveries WHERE admin_room_id=? AND kind='supervision'").get(adminRoom!) as { id: string; admission_id: string } | null);
      const first = await reminder(); expect(first, JSON.stringify({ planId, plans: await db.withStateTransaction(database, d => d.query("SELECT id,next_run_at FROM admin_plans").all()), bindings: await db.withStateTransaction(database, d => d.query("SELECT room_id,target_room_id FROM admin_rooms").all()) })).toBeTruthy();
      await db.withStateTransaction(database, d => d.query("UPDATE admin_plans SET next_run_at=? WHERE id=?").run(now + 1, planId));
      await tickAdminScheduler(now + 1);
      expect(await reminder()).toEqual(first);
      const supervisorTransport = { protocol: "v2" as const, receiverOwnerID: supervisorOwner, promptQueue: async (_s: string, id: string, text: string, delivery: "queue" | "steer") => { sent.push({ id, text, delivery }); return { id, sessionID: "__Test_supervisor-session", delivery, prompt: { text } }; } };
      await checkSupervisionInbox(opts, "__Test_supervisor-session", supervisorTransport);
      expect(sent.at(-1)!.text).toContain("__Test_reminder");
      expect((await reminder()) && (await db.withStateTransaction(database, d => d.query("SELECT acknowledged FROM admin_deliveries WHERE id=?").get(first!.id) as { acknowledged: number })).acknowledged).toBe(1);
      await stop(); await start();
      expect(JSON.stringify(await overview())).toContain("__Test_progress");
      await db.withStateTransaction(database, d => d.query("UPDATE admin_plans SET next_run_at=? WHERE id=?").run(now + 2, planId));
      await tickAdminScheduler(now + 2);
      const next = await reminder(); expect(next!.id).not.toBe(first!.id); expect(next!.admission_id).not.toBe(first!.admission_id);
      await checkSupervisionInbox(opts, "__Test_supervisor-session", supervisorTransport);
      expect(sent.at(-1)!.text).toContain("__Test_reminder");
      for (const args of [{ action: "admin_plan_update", roomId: adminRoom, planId, paused: true }, { action: "admin_plan_update", roomId: adminRoom, planId, paused: false }, { action: "admin_plan_delete", roomId: adminRoom, planId }] as const) {
        const result = await adminTool(args, { sessionID: "__Test_supervisor-session" }, opts, transport);
        expect(result.startsWith("error:"), result).toBe(false);
      }
    } finally {
      if (adminRoom) await api("DELETE", `/admin/rooms/${adminRoom}`, undefined, { ...auth, "x-chat-admin-token": adminToken }).catch(() => {});
      await stop(); await rm(root, { recursive: true, force: true });
    }
  });
}
