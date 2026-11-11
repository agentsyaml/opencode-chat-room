import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { centerAction } from "../src/center-client";
import { runReminderTool } from "../src/reminder-client";
import { withStateTransaction } from "../src/sqlite-state";

const token = "__Test_room_reminders_e2e_token";
const root = await mkdtemp(path.join(os.tmpdir(), "room-reminders-e2e-"));
const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
const wakePort = await unusedPort(), wakeRequests: string[] = [];
const wakeServer = createHttpServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  wakeRequests.push(JSON.parse(body).parts[0].text);
  res.writeHead(204).end();
});
await new Promise<void>(resolve => wakeServer.listen(wakePort, "127.0.0.1", resolve));
const env = { ...process.env, HOME: path.join(root, "home"), XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config"), CHAT_ROOM_STATE_DIR: root, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token, CHAT_ROOM_WAKE_SERVE_URL: `http://127.0.0.1:${wakePort}`, TZ: "UTC" };

test("room reminders cross the plugin, HTTP server, persisted database and restart tick", async () => {
  await start();
  const creator = "__Test_agent_creator", member = "__Test_room_member", outsider = "__Test_nonmember";
  const plugin = { center: origin, token };
  const created = await centerAction(plugin, { action: "create", name: "__Test_reminder_room", protocol: "v2" }, creator);
  const room = (await api(`/rooms?sessionID=${creator}`)).find((item: any) => item.name === "__Test_reminder_room");
  expect(created).toContain(room.id);
  expect(await centerAction(plugin, { action: "list" }, creator)).toContain(room.id);
  const creatorName = (await api(`/rooms/${room.id}/members`)).find((item: any) => item.sessionID === creator).name;
  await api(`/rooms/${room.id}/join`, "POST", { sessionID: member, participantId: "__Test_member", participantName: "__Test_member", host: os.hostname() });
  expect((await api(`/rooms/${room.id}/members`)).map((item: any) => item.sessionID)).toEqual(expect.arrayContaining([creator, member]));

  const once = toolJson(await runReminderTool(plugin, { action: "reminder_create", roomId: room.id, text: "__Test_once {{initiator}} {{room}}", schedule: { type: "once", at: new Date(Date.now() + 3600_000).toISOString() } }, creator));
  const cron = toolJson(await runReminderTool(plugin, { action: "reminder_create", roomId: room.id, text: "__Test_cron", schedule: { type: "cron", expression: "*/2 * * * *", timezone: "Pacific/Auckland" } }, creator));
  const defaultZone = toolJson(await runReminderTool(plugin, { action: "reminder_create", roomId: room.id, text: "__Test_default_zone", schedule: { type: "cron", expression: "*/2 * * * *" } }, member));
  const unaddressed = toolJson(await runReminderTool(plugin, { action: "reminder_create", roomId: room.id, text: "__Test_unaddressed", schedule: { type: "once", at: new Date(Date.now() + 3600_000).toISOString() } }, creator));
  const addressed = toolJson(await runReminderTool(plugin, { action: "reminder_create", roomId: room.id, text: "@__Test_member __Test_addressed", schedule: { type: "once", at: new Date(Date.now() + 3600_000).toISOString() } }, creator));
  expect(cron.reminder.schedule.timezone).toBe("Pacific/Auckland");
  expect(defaultZone.reminder.schedule.timezone).toBe("UTC");
  expect(JSON.parse(await runReminderTool(plugin, { action: "reminder_list", roomId: room.id }, creator)).reminders).toHaveLength(5);
  expect(await runReminderTool(plugin, { action: "reminder_list", roomId: room.id }, outsider)).toContain("not a current member");

  await api(`/rooms/${room.id}/kick`, "POST", { sessionID: creator, targetSessionID: member });
  expect((await api(`/rooms/${room.id}/members`)).some((item: any) => item.sessionID === member)).toBe(false);
  await api(`/rooms/${room.id}/join`, "POST", { sessionID: member, participantId: "__Test_member", participantName: "__Test_member", host: os.hostname() });
  await api(`/rooms/${room.id}/leave`, "POST", { sessionID: member });
  await api(`/rooms/${room.id}/join`, "POST", { sessionID: member, participantId: "__Test_member", participantName: "__Test_member", host: os.hostname() });
  await api(`/rooms/${room.id}/leave`, "POST", { sessionID: creator });

  const db = path.join(root, "chat-room.sqlite");
  await withStateTransaction(db, d => {
    d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(Date.now() - 60_000, once.reminder.id);
    d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(Date.now() - 30 * 24 * 3600_000, cron.reminder.id);
    d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(Date.now() - 60_000, unaddressed.reminder.id);
    d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(Date.now() + 60_000, addressed.reminder.id);
  });
  await stop();
  await start();
  await until(async () => (await api(`/inbox?sessionID=${member}&roomId=${room.id}`)).items.filter((item: any) => item.senderId === "system").length >= 3);
  await new Promise(resolve => setTimeout(resolve, 1300));
  expect(wakeRequests).toHaveLength(0);
  await withStateTransaction(db, d => d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(Date.now() - 1, addressed.reminder.id));
  await until(async () => (await api(`/inbox?sessionID=${member}&roomId=${room.id}`)).items.filter((item: any) => item.senderId === "system").length >= 4);
  await until(async () => wakeRequests.length === 1);
  expect(wakeRequests[0]).toContain("__Test_addressed");
  await new Promise(resolve => setTimeout(resolve, 1300));
  const inbox = await api(`/inbox?sessionID=${member}&roomId=${room.id}`);
  expect(inbox.items.some((item: any) => item.senderId === "system" && item.text.includes(`__Test_once ${creatorName} __Test_reminder_room`))).toBe(true);
  const rows = await withStateTransaction(db, d => ({
    messages: d.query("SELECT sender_id,text FROM messages WHERE room_id=? ORDER BY seq").all(room.id) as Array<{ sender_id: string; text: string }>,
    cron: d.query("SELECT next_run_at FROM room_reminders WHERE id=?").get(cron.reminder.id) as { next_run_at: number },
    once: d.query("SELECT 1 FROM room_reminders WHERE id=?").get(once.reminder.id),
  }));
  expect(rows.messages.filter(m => [`__Test_once ${creatorName} __Test_reminder_room`, "__Test_cron"].some(text => m.text.startsWith(text))).map(m => m.sender_id)).toEqual(["system", "system"]);
  expect(rows.messages.some(m => m.text.includes(`__Test_once ${creatorName} __Test_reminder_room`))).toBe(true);
  expect(rows.cron.next_run_at).toBeGreaterThan(Date.now());
  expect(rows.once).toBeNull();
}, 15_000);

afterAll(async () => { await stop(); await new Promise<void>(resolve => wakeServer.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

async function start() {
  server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env, stdio: "ignore" });
  await until(async () => (await fetch(`${origin}/chat`)).ok);
}
async function stop() {
  if (!server) return;
  const child = server; server = undefined;
  child.kill("SIGTERM");
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}
async function api(route: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
function toolJson(value: string): any {
  try { return JSON.parse(value); }
  catch { throw new Error(`Plugin reminder tool failed: ${value}`); }
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { try { if (await check()) return; } catch { /* Server or scheduled delivery is not ready yet. */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("Timed out waiting for the server or reminder delivery");
}
async function unusedPort() {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}
