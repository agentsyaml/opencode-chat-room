import { request, type CenterOpts } from "./center-client";

type Schedule =
  | { type: "once"; at: string; timezone?: string }
  | { type: "cron"; expression: string; timezone?: string };
type ReminderArgs = {
  action: string;
  roomId?: string;
  reminderId?: string;
  schedule?: Schedule;
  text?: string;
  paused?: boolean;
};

export async function runReminderTool(
  opts: CenterOpts,
  args: ReminderArgs,
  sessionID: string,
): Promise<string> {
  if (!opts.center) return "error: reminders require central server mode";
  if (!args.roomId) return "error: roomId is required";
  const root = `/rooms/${encodeURIComponent(args.roomId)}/reminders`;
  try {
    if (args.action === "reminder_list") {
      const result = await request(opts, `${root}?sessionID=${encodeURIComponent(sessionID)}`, "GET");
      return JSON.stringify(result, null, 2);
    }
    if (args.action === "reminder_create") {
      if (!args.schedule) return "error: schedule is required";
      if (!args.text?.trim()) return "error: text is required";
      const result = await request(opts, root, "POST", { sessionID, schedule: args.schedule, text: args.text });
      return JSON.stringify(result, null, 2);
    }
    if (!args.reminderId) return "error: reminderId is required";
    const child = `${root}/${encodeURIComponent(args.reminderId)}`;
    if (args.action === "reminder_update") {
      const fields = { ...(args.schedule ? { schedule: args.schedule } : {}), ...(args.text !== undefined ? { text: args.text } : {}), ...(args.paused !== undefined ? { paused: args.paused } : {}) };
      if (!Object.keys(fields).length) return "error: at least one of schedule, text, or paused is required";
      const result = await request(opts, child, "PATCH", { sessionID, ...fields });
      return JSON.stringify(result, null, 2);
    }
    if (args.action === "reminder_delete") {
      const result = await request(opts, child, "DELETE", { sessionID });
      return JSON.stringify(result, null, 2);
    }
    return "error: unsupported reminder action";
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
