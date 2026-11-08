import { binding, exec, many, tx, validCurrent } from "./admin-state";
import { randomUUID } from "node:crypto";

type PlanRow = { id: string; admin_room_id: string; interval_seconds: number; next_run_at: number; text: string };
type OpenTask = { text: string; status: string; progress: string };
type Reminder = { id: string; acknowledged: number };

export async function tickAdminScheduler(now = Date.now()): Promise<void> {
  await tx((db) => {
    const due = many<PlanRow>(db, "SELECT * FROM admin_plans WHERE paused=0 AND next_run_at<=? ORDER BY next_run_at LIMIT 100", now);
    for (const plan of due) {
      const b = binding(db, plan.admin_room_id);
      if (!b || !validCurrent(db, b)) {
        exec(db, "UPDATE admin_plans SET next_run_at=? WHERE id=?", now + plan.interval_seconds * 1000, plan.id);
        continue;
      }
      const tasks = many<OpenTask>(db, "SELECT text,status,progress FROM admin_tasks WHERE admin_room_id=? AND status IN ('pending','working','blocked') ORDER BY created_at DESC LIMIT 20", b.room_id);
      const summary = tasks.length ? `\nOpen tasks:\n${tasks.map(t => `- ${t.status}: ${t.text}${t.progress ? ` (${t.progress})` : ""}`).join("\n")}` : "\nNo open tasks.";
      const text = `${plan.text}${summary}`.slice(0, 5000);
      const taskID = `plan:${plan.id}`;
      const existing = db.query("SELECT id,acknowledged FROM admin_deliveries WHERE admin_room_id=? AND kind='supervision' AND task_id=?").get(b.room_id, taskID) as Reminder | null;
      if (existing && !existing.acknowledged) {
        exec(db, "UPDATE admin_deliveries SET text=?,created_at=?,generation=?,recipient_room_id=?,session_id=?,owner_id=?,membership_id=? WHERE id=?", text, now, b.generation, b.target_room_id, b.session_id, b.receiver_owner_id, b.membership_id, existing.id);
      } else if (existing) {
        const id = randomUUID();
        exec(db, "UPDATE admin_deliveries SET id=?,admission_id=?,text=?,created_at=?,generation=?,recipient_room_id=?,session_id=?,owner_id=?,membership_id=?,acknowledged=0 WHERE id=?", id, `admin:${id}`, text, now, b.generation, b.target_room_id, b.session_id, b.receiver_owner_id, b.membership_id, existing.id);
      } else {
        const id = randomUUID();
        exec(db, "INSERT INTO admin_deliveries(id,admin_room_id,generation,recipient_room_id,session_id,owner_id,membership_id,kind,text,task_id,admission_id,created_at) VALUES(?,?,?,?,?,?,?,'supervision',?,?,?,?)", id,b.room_id,b.generation,b.target_room_id,b.session_id,b.receiver_owner_id,b.membership_id,text,taskID,`admin:${id}`,now);
      }
      exec(db, "UPDATE admin_plans SET next_run_at=? WHERE id=?", now + plan.interval_seconds * 1000, plan.id);
    }
  });
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startAdminScheduler(): void {
  if (timer || !process.env.CHAT_ROOM_ADMIN_TOKEN || !process.env.CHAT_ROOM_SERVER_TOKEN || process.env.CHAT_ROOM_ADMIN_TOKEN === process.env.CHAT_ROOM_SERVER_TOKEN) return;
  timer = setInterval(() => { void tickAdminScheduler().catch(() => {}); }, 5000);
  timer.unref?.();
}
export function stopAdminScheduler(): void { if (timer) clearInterval(timer); timer = undefined; }
