import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { adminTool } from "./admin-client";

if (!process.env.CHAT_ROOM_ADMIN_INTEGRATION_CHILD) {
  test("admin supervision works over an isolated real server", async () => {
    const child = Bun.spawn([process.execPath, "test", "src/admin-integration.test.ts"], {
      env: { ...process.env, CHAT_ROOM_ADMIN_INTEGRATION_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${stdout}${stderr}`);
  });
} else {
  test("operator binding and restart persistence", async () => {
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
      adminRoom = await makeRoom("admin"); const supervisorRoom = await makeRoom("supervisor");
      const join = async (room: string, sessionID: string, owner: string, name: string) => {
        const r = await api("POST", `/rooms/${room}/join`, { sessionID, participantId: name, participantName: name, protocol: "v2", receiverOwnerID: owner }); expect(r.status).toBe(201);
      };
      const supervisorOwner = randomUUID();
      await join(supervisorRoom, "__Test_supervisor-session", supervisorOwner, "__Test_supervisor");
      const registry = await (await api("GET", `/rooms/${supervisorRoom}/registry`)).json() as Record<string, { membershipID: string }>;
      const supervisorMember = registry["__Test_supervisor-session"]?.membershipID;
      expect(supervisorMember).toBeTruthy();
      const operatorHeaders = { ...auth, "x-chat-admin-token": adminToken };
      expect((await api("POST", "/admin/rooms", { roomId: adminRoom, targetRoomId: supervisorRoom, sessionID: "__Test_supervisor-session", receiverOwnerID: supervisorOwner, membershipID: supervisorMember }, { "x-chat-admin-token": serverToken })).status).toBe(401);
      expect((await api("POST", "/admin/rooms", { roomId: "forged-room", targetRoomId: supervisorRoom, sessionID: "__Test_supervisor-session", receiverOwnerID: supervisorOwner, membershipID: supervisorMember }, {})).status).toBe(401);
      const bound = await api("POST", "/admin/rooms", { roomId: adminRoom, targetRoomId: supervisorRoom, sessionID: "__Test_supervisor-session", receiverOwnerID: supervisorOwner, membershipID: supervisorMember }, operatorHeaders);
      expect(bound.status).toBe(201);
      const transport = { protocol: "v2" as const, receiverOwnerID: supervisorOwner };
      const overview = async () => JSON.parse(await adminTool({ action: "admin_overview", roomId: adminRoom }, { sessionID: "__Test_supervisor-session" }, opts, transport));
      // Designation is effective immediately; no claim step is required.
      expect(Array.isArray((await overview()).rooms)).toBe(true);
      await stop(); await start();
      expect(Array.isArray((await overview()).rooms)).toBe(true);
    } finally {
      if (adminRoom) await api("DELETE", `/admin/rooms/${adminRoom}`, undefined, { ...auth, "x-chat-admin-token": adminToken }).catch(() => {});
      await stop(); await rm(root, { recursive: true, force: true });
    }
  });
}
