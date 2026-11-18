import { expect, test } from "bun:test";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const childMode = process.env.CHAT_ROOM_REMINDER_SCHEMA_CHILD === "1";
if (!childMode) {
  test("runs reminder schema fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reminder-schema-test-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CHAT_ROOM_REMINDER_SCHEMA_CHILD: "1", CHAT_ROOM_STATE_DIR: dir,
        HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_SERVER_URL: "", CHAT_ROOM_SERVER_TOKEN: "",
        CHAT_ROOM_WAKE_SERVE_URL: "" }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`${stdout}${stderr}`);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
} else {
  test("v1 and v2 reminder schemas preserve naive, UTC, offset, and timezone schedules", async () => {
    const { roomArgs } = await import("../../plugin");
    const { roomSchema } = await import("../runtime/v2-plugin.ts");
    const schemas = [roomArgs, roomSchema()];
    const schedules = [
      { type: "once", at: "2030-01-02T03:04:05" },
      { type: "once", at: "2030-01-02T03:04:05Z" },
      { type: "once", at: "2030-01-02T03:04:05+05:30" },
      { type: "once", at: "2030-01-02T03:04:05", timezone: "America/New_York" },
    ] as const;
    for (const schema of schemas) {
      for (const schedule of schedules) {
        const parsed = schema.parse({ action: "reminder_create", roomId: "room", schedule, text: "Reminder" });
        expect(parsed.schedule).toEqual(schedule);
      }
    }
  });
}