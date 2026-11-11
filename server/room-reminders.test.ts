import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const dir = mkdtempSync(path.join(os.tmpdir(), "room-reminders-"));
process.env.CHAT_ROOM_STATE_DIR = dir;
const { roomReminderRoutes, tickRoomReminders } = await import("./room-reminders");
const { writeState, readInboxMessages } = await import("../src/store");
const { withStateTransaction } = await import("../src/sqlite-state");
let roomId = "", directRoomId = "";
beforeAll(async () => {
  [roomId, directRoomId] = await writeState((svc, registry) => {
    const room = svc.createRoom("Test room", "owner");
    svc.joinRoom(room.id, { id: "Alice", name: "Alice" });
    svc.joinRoom(room.id, { id: "Bob", name: "Bob" });
    svc.joinRoom(room.id, { id: "Reminder", name: "Reminder" });
    registry[room.id] = {
      member: { serverUrl: "", apiPrefix: "/api", name: "Alice", membershipID: "m", lastReadTs: 0, lastQueuedTs: 0 },
      member2: { serverUrl: "", apiPrefix: "/api", name: "Bob", membershipID: "m2", lastReadTs: 0, lastQueuedTs: 0 },
      member3: { serverUrl: "", apiPrefix: "/api", name: "Reminder", membershipID: "m3", lastReadTs: 0, lastQueuedTs: 0 },
    };
    const direct = svc.createDirectRoom("Direct test", "owner", ["directA", "directB"]);
    svc.joinRoom(direct.id, { id: "directA", name: "Bob" });
    svc.joinRoom(direct.id, { id: "directB", name: "Reminder" });
    registry[direct.id] = {
      directA: { serverUrl: "", apiPrefix: "/api", name: "Bob", membershipID: "da", lastReadTs: 0, lastQueuedTs: 0 },
      directB: { serverUrl: "", apiPrefix: "/api", name: "Reminder", membershipID: "db", lastReadTs: 0, lastQueuedTs: 0 },
    };
    return [room.id, direct.id] as [string, string];
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const requestFor = (room: string, method: string, suffix = "", body?: unknown) => roomReminderRoutes(new Request(`http://test/rooms/${room}/reminders${suffix}`, {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), new URL(`http://test/rooms/${room}/reminders${suffix}`));
const request = (method: string, suffix = "", body?: unknown) => requestFor(roomId, method, suffix, body);

test("cron schedules validate timezone and minimum cadence", async () => {
  const invalid = await request("POST", "", { sessionID: "member", text: "bad", schedule: { type: "cron", expression: "5 * * * *", timezone: "Not/AZone" } });
  expect(invalid?.status).toBe(400);
  for (const bad of [
    { type: "cron", expression: 123, timezone: "UTC" },
    { type: "cron", expression: "5 * * * *", timezone: 123 },
    { type: "once", at: 123 },
    { type: "once", at: "2032-02-30T12:00:00Z" },
  ]) expect((await request("POST", "", { sessionID: "member", text: "bad", schedule: bad }))?.status).toBe(400);
  const valid = await request("POST", "", { sessionID: "member", text: "valid", schedule: { type: "cron", expression: "5 * * * *", timezone: "America/New_York" } });
  expect(valid?.status).toBe(201);
  const id = (await valid!.json() as { reminder: { id: string } }).reminder.id;
  await request("DELETE", `/${id}`, { sessionID: "member" });
  const defaultZone = await request("POST", "", { sessionID: "member", text: "default zone", schedule: { type: "cron", expression: "5 * * * *" } });
  expect(defaultZone?.status).toBe(201);
  const defaultReminder = (await defaultZone!.json() as { reminder: { id: string; schedule: { timezone: string } } }).reminder;
  expect(defaultReminder.schedule.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  await request("DELETE", `/${defaultReminder.id}`, { sessionID: "member2" });
  const localAt = "2032-01-15T12:30:00";
  const local = await request("POST", "", { sessionID: "member", text: "local time", schedule: { type: "once", at: localAt, timezone: "America/New_York" } });
  const localReminder = (await local!.json() as { reminder: { id: string; schedule: { at: string; timezone: string } } }).reminder;
  const localSchedule = localReminder.schedule;
  expect(localSchedule.timezone).toBe("America/New_York");
  const listed = await request("GET", "?sessionID=member");
  const listedSchedule = ((await listed!.json() as { reminders: Array<{ id: string; schedule: unknown }> }).reminders.find(item => item.id === localReminder.id))!.schedule;
  expect(listedSchedule).toEqual(localSchedule);
  const roundTrip = await request("PATCH", `/${localReminder.id}`, { sessionID: "member", schedule: localSchedule });
  expect(roundTrip?.status).toBe(200);
  expect(((await roundTrip!.json() as { reminder: { schedule: unknown } }).reminder).schedule).toEqual(localSchedule);
  const displayed = new Intl.DateTimeFormat("en-CA", { timeZone: localSchedule.timezone, dateStyle: "short", timeStyle: "medium", hourCycle: "h23" }).format(new Date(localSchedule.at));
  expect(displayed).toContain("12:30:00");
  await request("DELETE", `/${localReminder.id}`, { sessionID: "member" });
  const gap = await request("POST", "", { sessionID: "member", text: "gap", schedule: { type: "once", at: "2032-03-14T02:30:00", timezone: "America/New_York" } });
  const overlap = await request("POST", "", { sessionID: "member", text: "overlap", schedule: { type: "once", at: "2032-11-07T01:30:00", timezone: "America/New_York" } });
  expect(gap?.status).toBe(400); expect(overlap?.status).toBe(400);
  const explicit = await request("POST", "", { sessionID: "member", text: "offset", schedule: { type: "once", at: "2032-01-15T12:30:00-05:00", timezone: "America/New_York" } });
  expect(explicit?.status).toBe(201);
  const explicitId = (await explicit!.json() as { reminder: { id: string } }).reminder.id;
  await request("DELETE", `/${explicitId}`, { sessionID: "member" });
  const offsetDisplay = await request("POST", "", { sessionID: "member", text: "offset", schedule: { type: "once", at: "2032-01-15T12:30:00-05:00", timezone: "UTC" } });
  expect(offsetDisplay?.status).toBe(201);
  const offsetReminder = (await offsetDisplay!.json() as { reminder: { id: string; schedule: { type: string; at: string; timezone: string } } }).reminder;
  expect(offsetReminder.schedule).toEqual({ type: "once", at: "2032-01-15T17:30:00.000Z", timezone: "UTC" });
  await request("DELETE", `/${offsetReminder.id}`, { sessionID: "member" });
  const long = await request("POST", "", { sessionID: "member", text: `${"x".repeat(1992)}{{time}}`, schedule: { type: "once", at: new Date(Date.now() + 120_000).toISOString() } });
  expect(long?.status).toBe(400);
  const update = await request("POST", "", { sessionID: "member", text: "ok", schedule: { type: "once", at: new Date(Date.now() + 120_000).toISOString() } });
  const updateId = (await update!.json() as { reminder: { id: string } }).reminder.id;
  expect((await request("PATCH", `/${updateId}`, { sessionID: "member", text: `${"x".repeat(1992)}{{time}}` }))?.status).toBe(400);
  await request("DELETE", `/${updateId}`, { sessionID: "member" });
});

test("due reminders coalesce downtime and isolate corrupt schedules", async () => {
  const denied = await request("GET", "?sessionID=outsider");
  expect(denied?.status).toBe(404);
  const at = "2032-01-15T12:30:00", future = Date.parse("2032-01-15T12:35:00-05:00");
  const onceResp = await request("POST", "", { sessionID: "member", text: "Hi {{initiator}} in {{room}} at {{time}}", schedule: { type: "once", at, timezone: "America/New_York" } });
  const cronResp = await request("POST", "", { sessionID: "member", text: "recurring {initiator} {room}", schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } });
  expect(onceResp?.status).toBe(201); expect(cronResp?.status).toBe(201);
  const once = (await onceResp!.json() as { reminder: { id: string } }).reminder;
  const recurring = (await cronResp!.json() as { reminder: { id: string } }).reminder;
  await writeState((svc, registry) => { svc.leaveRoom(roomId, "Alice"); delete registry[roomId]!.member; });
  expect((await request("GET", "?sessionID=member2"))?.status).toBe(200);
  const patched = await request("PATCH", `/${once.id}`, { sessionID: "member2", text: "Updated {{initiator}} in {{room}} at {{time}}" });
  expect(patched?.status).toBe(200);
  const poison = randomUUID();
  await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => {
    d.query("UPDATE room_reminders SET next_run_at=? WHERE id IN (?,?)").run(future - 60_000, once.id, recurring.id);
    d.query("INSERT INTO room_reminders(id,room_id,creator_session_id,initiator,text,schedule_type,expression,timezone,paused,next_run_at,created_at) VALUES(?,?,?,?,?,'cron','5 * * * *','123',0,?,?)")
      .run(poison, roomId, "gone", "Broken", "must not send", future - 60_000, Date.now());
  });
  await Promise.all([tickRoomReminders(future), tickRoomReminders(future)]);
  const rows = await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => ({
    messages: d.query("SELECT sender_id,text FROM messages WHERE room_id=? ORDER BY seq").all(roomId) as { sender_id: string; text: string }[],
    recurring: d.query("SELECT next_run_at FROM room_reminders WHERE id=?").get(recurring.id) as { next_run_at: number },
    poison: d.query("SELECT paused,last_error FROM room_reminders WHERE id=?").get(poison) as { paused: number; last_error: string },
    once: d.query("SELECT 1 FROM room_reminders WHERE id=?").get(once.id),
  }));
  expect(rows.messages).toHaveLength(2);
  expect(rows.messages.every(m => m.sender_id === "system")).toBe(true);
  expect(rows.messages[0]!.text).toContain("Updated Alice in Test room at");
  expect(rows.messages[0]!.text).toContain("[America/New_York]");
  expect(rows.messages[0]!.text).not.toMatch(/[{}]/);
  expect(rows.messages[1]!.text).toBe("recurring Alice Test room");
  expect(rows.recurring.next_run_at).toBeGreaterThan(future);
  expect(rows.poison.paused).toBe(1); expect(rows.poison.last_error).toContain("time zone");
  expect(rows.once).toBeNull();
  const reminderInbox = await readInboxMessages("member3", roomId, true);
  expect(reminderInbox.items.map(item => item.text)).toContain(rows.messages[0]!.text);
  expect(reminderInbox.items.map(item => item.text)).toContain("recurring Alice Test room");
  expect(reminderInbox.items.map(item => item.text)).not.toContain("must not send");
  const repaired = await request("PATCH", `/${poison}`, { sessionID: "member2", paused: false, schedule: { type: "cron", expression: "5 * * * *", timezone: "UTC" } });
  expect(repaired?.status).toBe(200);
  const repairedReminder = (await repaired!.json() as { reminder: { paused: boolean; lastError?: string } }).reminder;
  expect(repairedReminder.paused).toBe(false);
  expect(repairedReminder.lastError).toBeUndefined();
  const racing = randomUUID();
  await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("INSERT INTO room_reminders(id,room_id,creator_session_id,initiator,text,schedule_type,expression,timezone,paused,next_run_at,created_at) VALUES(?,?,?,?,?,'cron','5 * * * *','123',0,?,?)")
    .run(racing, roomId, "gone", "Broken", "race", future - 1, Date.now()));
  const [, raceRepair] = await Promise.all([
    tickRoomReminders(future),
    request("PATCH", `/${racing}`, { sessionID: "member2", paused: false, schedule: { type: "once", at: new Date(future + 120_000).toISOString() } }),
  ]);
  expect(raceRepair?.status).toBe(200);
  const raceRow = await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("SELECT paused,last_error,next_run_at,schedule_type FROM room_reminders WHERE id=?").get(racing) as { paused: number; last_error: string | null; next_run_at: number; schedule_type: string });
  expect(raceRow).toMatchObject({ paused: 0, last_error: null, schedule_type: "once" });
  expect(raceRow.next_run_at).toBeGreaterThan(future);
});

test("pause and resume, direct rooms, and Reminder-named members", async () => {
  const future = Date.now() + 120_000;
  const once = await request("POST", "", { sessionID: "member2", text: "paused", schedule: { type: "once", at: new Date(future).toISOString() } });
  const id = (await once!.json() as { reminder: { id: string } }).reminder.id;
  await request("PATCH", `/${id}`, { sessionID: "member3", paused: true });
  await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(future - 1, id));
  await tickRoomReminders(future);
  expect(await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("SELECT 1 FROM room_reminders WHERE id=?").get(id))).not.toBeNull();
  await request("PATCH", `/${id}`, { sessionID: "member3", paused: false });
  await tickRoomReminders(future);
  const immediate = await request("POST", "", { sessionID: "member2", text: "@Reminder immediate", schedule: { type: "once", at: new Date(Date.now() + 120_000).toISOString() } });
  const immediateId = (await immediate!.json() as { reminder: { id: string } }).reminder.id;
  const now = Date.now();
  await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(now - 1, immediateId));
  let calls = 0;
  await tickRoomReminders(now, async (_roomId, _roomName, _text, message) => {
    calls++;
    expect(message.id).toMatch(/^reminder:/);
    expect(await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("SELECT 1 FROM messages WHERE id=?").get(message.id))).not.toBeNull();
    throw new Error("wake unavailable");
  });
  expect(calls).toBe(1);
  expect(await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => ({
    count: d.query("SELECT count(*) AS n FROM messages WHERE room_id=? AND text='@Reminder immediate'").get(roomId) as { n: number },
    reminder: d.query("SELECT 1 FROM room_reminders WHERE id=?").get(immediateId),
  }))).toMatchObject({ count: { n: 1 }, reminder: null });
  const direct = await requestFor(directRoomId, "POST", "", { sessionID: "directA", text: "direct reminder", schedule: { type: "once", at: new Date(Date.now() + 120_000).toISOString() } });
  const directID = (await direct!.json() as { reminder: { id: string } }).reminder.id;
  await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("UPDATE room_reminders SET next_run_at=? WHERE id=?").run(Date.now() - 1, directID));
  await tickRoomReminders();
  const inbox = await readInboxMessages("directB", directRoomId, true);
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]!.senderId).toBe("system");
  expect(inbox.items[0]!.roomKind).toBe("direct");
  expect(inbox.items[0]!.senderId).not.toBe("Reminder");
  await writeState((svc, registry) => { svc.deleteRoom(roomId); delete registry[roomId]; svc.deleteRoom(directRoomId); delete registry[directRoomId]; });
  expect(await withStateTransaction(path.join(dir, "chat-room.sqlite"), d => d.query("SELECT count(*) AS n FROM room_reminders WHERE room_id=?").get(roomId) as { n: number })).toEqual({ n: 0 });
});
