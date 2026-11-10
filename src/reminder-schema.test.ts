import { expect, test } from "bun:test";
import { roomArgs } from "../plugin";
import { roomSchema } from "./v2-plugin";

test("v1 and v2 reminder schemas preserve naive, UTC, offset, and timezone schedules", () => {
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
