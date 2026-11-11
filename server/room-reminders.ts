import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { databasePath } from "../src/store";
import { initializeReminderSchema, withStateTransaction } from "../src/sqlite-state";
import type { Message } from "../src/room-service";

type Schedule = { type: "once"; at: string; timezone?: string } | { type: "cron"; expression: string; timezone: string };
type Row = { id: string; room_id: string; creator_session_id: string; initiator: string; text: string; schedule_type: string; at: string | null; expression: string | null; timezone: string | null; paused: number; next_run_at: number; created_at: number; last_error: string | null };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const dbFile = () => databasePath();

function zone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
function zonedParts(ms: number, timezone: string): number[] {
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(ms).map(part => [part.type, part.value]));
  return ["year", "month", "day", "hour", "minute", "second"].map(key => Number(fields[key]));
}
function normalizeOnce(input: string, timezone: string): string {
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/i);
  if (!match) throw new Error("once schedule at must be an ISO timestamp");
  const [, ys, mos, ds, hs, mins, secs = "00", fraction = "", offset] = match;
  const parts = [Number(ys), Number(mos), Number(ds), Number(hs), Number(mins), Number(secs)];
  const [y, mo, d, h, mi, s] = parts;
  const check = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo! - 1 || check.getUTCDate() !== d || h! > 23 || mi! > 59 || s! > 59) throw new Error("once schedule at is not a valid date/time");
  let ms: number;
  if (offset) {
    ms = Date.parse(input);
  } else {
    const local = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, Number((fraction.slice(1) + "000").slice(0, 3)));
    const offsets = new Set<number>();
    for (let delta = -36; delta <= 36; delta += 6) {
      const probe = local + delta * 3_600_000;
      const [py, pm, pd, ph, pmin, ps] = zonedParts(probe, timezone);
      offsets.add(Date.UTC(py!, pm! - 1, pd!, ph!, pmin!, ps!) - Math.floor(probe / 1000) * 1000);
    }
    const candidates = [...offsets].map(value => local - value).filter(candidate => {
      const target = zonedParts(candidate, timezone);
      return target.every((value, index) => value === parts[index]);
    });
    if (candidates.length !== 1) throw new Error("once schedule local time is ambiguous or does not exist in the server timezone; include an explicit offset");
    ms = candidates[0]!;
  }
  if (!Number.isFinite(ms)) throw new Error("once schedule at is not a valid ISO timestamp");
  return new Date(ms).toISOString();
}
function validTimezone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) throw new Error("timezone must be an IANA timezone string");
  new Intl.DateTimeFormat("en-US", { timeZone: value });
  return value;
}
function normalizeSchedule(value: unknown): Schedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule must be an object");
  const input = value as Record<string, unknown>;
  if (input.type === "once") {
    if (typeof input.at !== "string") throw new Error("once schedule at must be an ISO timestamp string");
    const explicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(input.at);
    if (input.timezone !== undefined && typeof input.timezone !== "string") throw new Error("timezone must be an IANA timezone string");
    if (explicitOffset) {
      const at = normalizeOnce(input.at, zone());
      if (input.timezone === undefined) return { type: "once", at };
      const timezone = validTimezone(input.timezone);
      // An explicit offset fixes the instant; timezone is only its display zone.
      return { type: "once", at, timezone };
    }
    const timezone = input.timezone === undefined ? zone() : validTimezone(input.timezone);
    return { type: "once", at: normalizeOnce(input.at, timezone), timezone };
  }
  if (input.type === "cron") {
    if (typeof input.expression !== "string" || !input.expression.trim() || input.expression.length > 128) throw new Error("cron expression must be a non-empty string");
    const timezone = input.timezone === undefined ? zone() : validTimezone(input.timezone);
    return { type: "cron", expression: input.expression, timezone };
  }
  throw new Error("schedule type must be once or cron");
}

function next(schedule: Schedule, from: number): number {
  if (schedule.type === "once") {
    const at = Date.parse(schedule.at);
    if (!Number.isFinite(at) || at <= from) throw new Error("once schedule at must be a future ISO timestamp");
    return at;
  }
  if (typeof schedule.expression !== "string" || schedule.expression.trim().split(/\s+/).length !== 5) throw new Error("cron schedule requires a 5-field expression");
  const timezone = validTimezone(schedule.timezone);
  const cron = new Cron(schedule.expression, { timezone, paused: true });
  let first: number | undefined, second: number | undefined;
  try {
    first = cron.nextRun(new Date(from))?.getTime();
    second = first === undefined ? undefined : cron.nextRun(new Date(first + 1000))?.getTime();
  } finally { cron.stop(); }
  if (!first || !second || second - first < 60_000) throw new Error("cron occurrences must be at least 60 seconds apart");
  return first;
}

function output(r: Row) {
  return { id: r.id, roomId: r.room_id, creatorSessionID: r.creator_session_id, text: r.text,
    schedule: r.schedule_type === "once" ? { type: "once", at: r.at, ...(r.timezone ? { timezone: r.timezone } : {}) } : { type: "cron", expression: r.expression, timezone: r.timezone },
    paused: Boolean(r.paused), nextRunAt: new Date(r.next_run_at).toISOString(), createdAt: new Date(r.created_at).toISOString(),
    ...(r.last_error ? { lastError: r.last_error } : {}) };
}
function member(db: any, room: string, session: string): { name: string } | null {
  return db.query(`SELECT g.name FROM registry g JOIN participants p ON p.room_id=g.room_id AND p.id=CASE WHEN (SELECT kind FROM rooms WHERE id=g.room_id)='direct' THEN g.session_id ELSE g.name END WHERE g.room_id=? AND g.session_id=?`).get(room, session) as { name: string } | null;
}
function template(text: string, at: number, initiator: string, room: string, timezone?: string) {
  const time = timezone ? (() => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName} [${timezone}]`;
  })() : new Date(at).toISOString();
  const result = text.replace(/\{\{(time|initiator|room)\}\}|\{(time|initiator|room)\}/g, (_m, doubleKey: string, singleKey: string) => {
    const key = doubleKey ?? singleKey;
    return key === "time" ? time : key === "initiator" ? initiator : room;
  });
  if (result.length > 2000) throw new Error("rendered reminder text exceeds 2000 characters");
  return result;
}

export async function roomReminderRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/reminders(?:\/([^/]+))?$/);
  if (!match) return undefined;
  await initializeReminderSchema(dbFile());
  const room = decodeURIComponent(match[1]!);
  const id = match[2];
  if (req.method === "GET" && !id) {
    const session = url.searchParams.get("sessionID") ?? "";
    const items = await withStateTransaction(dbFile(), db => {
      if (!member(db, room, session)) return null;
      return db.query("SELECT * FROM room_reminders WHERE room_id=? ORDER BY created_at,id").all(room) as Row[];
    });
    return items ? json({ reminders: items.map(output) }) : json({ error: "room not found or session is not a current member" }, 404);
  }
  if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") return json({ error: "method not allowed" }, 405);
  const body: unknown = await req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "JSON object body is required" }, 400);
  const input = body as Record<string, unknown>, session = input.sessionID;
  if (typeof session !== "string" || !session || session.length > 128) return json({ error: "sessionID is required" }, 400);
  const result = await withStateTransaction(dbFile(), db => {
    const who = member(db, room, session);
    if (!who) return { error: "room not found or session is not a current member", status: 404 };
    if (req.method === "POST") {
      const text = input.text;
      if (typeof text !== "string" || !text.trim() || text.length > 2000 || input.schedule === undefined) return { error: "text (max 2000) and valid schedule are required", status: 400 };
      try {
        const schedule = normalizeSchedule(input.schedule), at = next(schedule, Date.now()), created = Date.now(), rid = randomUUID();
        const roomName = (db.query("SELECT name FROM rooms WHERE id=?").get(room) as { name: string } | null)?.name;
        if (roomName === undefined) return { error: "room not found", status: 404 };
        template(text.trim(), at, who.name, roomName, schedule.timezone);
        db.query("INSERT INTO room_reminders(id,room_id,creator_session_id,initiator,text,schedule_type,at,expression,timezone,paused,next_run_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)")
          .run(rid, room, session, who.name, text.trim(), schedule.type, schedule.type === "once" ? schedule.at : null, schedule.type === "cron" ? schedule.expression : null, schedule.timezone ?? null, at, created);
        return { reminder: output(db.query("SELECT * FROM room_reminders WHERE id=?").get(rid) as Row), status: 201 };
      } catch (e) { return { error: e instanceof Error ? e.message : "invalid schedule", status: 400 }; }
    }
    if (!id) return { error: "reminder id is required", status: 400 };
    const row = db.query("SELECT * FROM room_reminders WHERE room_id=? AND id=?").get(room, id) as Row | null;
    if (!row) return { error: "reminder not found", status: 404 };
    if (req.method === "DELETE") { db.query("DELETE FROM room_reminders WHERE id=?").run(id); return { ok: true, status: 200 }; }
    const text = input.text;
    if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > 2000)) return { error: "text must be non-empty and at most 2000 characters", status: 400 };
    if (input.paused !== undefined && typeof input.paused !== "boolean") return { error: "paused must be a boolean", status: 400 };
    const schedule = input.schedule;
    if (row.last_error && input.paused === false && schedule === undefined) return { error: "replace the invalid schedule before resuming this reminder", status: 409 };
    try {
      const normalized = schedule !== undefined ? normalizeSchedule(schedule) : undefined;
      const n = normalized ? next(normalized, Date.now()) : row.next_run_at;
      const roomName = (db.query("SELECT name FROM rooms WHERE id=?").get(room) as { name: string } | null)?.name;
      if (roomName === undefined) return { error: "room not found", status: 404 };
      template(typeof text === "string" ? text.trim() : row.text, n, row.initiator, roomName, normalized ? normalized.timezone : row.timezone ?? undefined);
      db.query("UPDATE room_reminders SET text=?,paused=?,schedule_type=?,at=?,expression=?,timezone=?,next_run_at=?,last_error=? WHERE id=?")
        .run(typeof text === "string" ? text.trim() : row.text, input.paused === undefined ? row.paused : input.paused ? 1 : 0,
          normalized?.type ?? row.schedule_type, normalized?.type === "once" ? normalized.at : normalized ? null : row.at,
          normalized?.type === "cron" ? normalized.expression : normalized ? null : row.expression, normalized ? normalized.timezone ?? null : row.timezone, n, normalized ? null : row.last_error, id);
      return { reminder: output(db.query("SELECT * FROM room_reminders WHERE id=?").get(id) as Row), status: 200 };
    } catch (e) { return { error: e instanceof Error ? e.message : "invalid schedule", status: 400 }; }
  });
  const { status, ...bodyOut } = result;
  return json(bodyOut, status);
}

export type ReminderWake = (roomId: string, roomName: string, text: string, message: Message) => void | Promise<void>;

export async function tickRoomReminders(now = Date.now(), wake?: ReminderWake): Promise<void> {
  await initializeReminderSchema(dbFile());
  const ids = await withStateTransaction(dbFile(), db => (db.query("SELECT id FROM room_reminders WHERE paused=0 AND next_run_at<=? ORDER BY next_run_at LIMIT 100").all(now) as Array<{ id: string }>).map(row => row.id));
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    let delivered: { roomName: string; message: Message } | undefined;
    const failure = await withStateTransaction(dbFile(), db => {
      const r = db.query("SELECT * FROM room_reminders WHERE id=? AND paused=0 AND next_run_at<=?").get(id, now) as Row | null;
      if (!r) return null;
      try {
        db.transaction(() => {
        const room = db.query("SELECT name FROM rooms WHERE id=?").get(r.room_id) as { name: string } | null;
        if (!room) throw new Error("reminder room no longer exists");
        const upcoming = r.schedule_type === "once" ? undefined : r.schedule_type === "cron"
          ? next(normalizeSchedule({ type: "cron", expression: r.expression, timezone: r.timezone }), now)
          : (() => { throw new Error(`unsupported reminder schedule type: ${r.schedule_type}`); })();
        const tail = db.query("SELECT created_at FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(r.room_id) as { created_at: number } | null;
        const sentAt = Math.max(now, (tail?.created_at ?? 0) + 1), text = template(r.text, sentAt, r.initiator, room.name, r.timezone ?? undefined);
        const message: Message = { id: `reminder:${randomUUID()}`, roomId: r.room_id, senderId: "system", text, createdAt: sentAt };
        db.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question) VALUES(?,?, 'system',NULL,?,?,0)").run(message.id, r.room_id, text, sentAt);
        delivered = { roomName: room.name, message };
        if (upcoming === undefined) db.query("DELETE FROM room_reminders WHERE id=?").run(r.id);
        else db.query("UPDATE room_reminders SET next_run_at=?,last_error=NULL WHERE id=?").run(upcoming, r.id);
        })();
        return null;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        db.query("UPDATE room_reminders SET paused=1,last_error=? WHERE id=? AND paused=0 AND next_run_at<=?").run(message, id, now);
        return { id, error: message };
      }
    });
    if (failure) failures.push(failure);
    else if (delivered && wake) {
      try { await wake(delivered.message.roomId, delivered.roomName, delivered.message.text, delivered.message); } catch { /* Inbox polling remains the fallback. */ }
    }
  }
  for (const failure of failures) console.error(`room reminder ${failure.id} paused after delivery error: ${failure.error}`);
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startRoomReminderScheduler(wake?: ReminderWake): void {
  if (timer) return;
  timer = setInterval(() => { void tickRoomReminders(Date.now(), wake).catch(() => {}); }, 1000);
  timer.unref?.();
}
