import { afterAll, expect, test } from "bun:test";
import { runReminderTool } from "./reminder-client";

const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });

test("reminder actions use the authenticated room API and preserve provided fields", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown; auth?: string }> = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get("Authorization") ?? undefined });
    return Response.json({ reminders: [{ id: "r1" }] });
  }, { preconnect: originalFetch.preconnect });
  const opts = { center: "http://center", token: "secret" };
  const schedule = { type: "once" as const, at: "2030-01-01T00:00:00.000Z", timezone: "America/New_York" };
  await runReminderTool(opts, { action: "reminder_list", roomId: "a/b" }, "s 1");
  await runReminderTool(opts, { action: "reminder_create", roomId: "a/b", schedule, text: "hello" }, "s 1");
  const serverTimezoneSchedule = { type: "cron" as const, expression: "5 * * * *" };
  await runReminderTool(opts, { action: "reminder_update", roomId: "a/b", reminderId: "r/1", schedule: serverTimezoneSchedule, paused: false }, "s 1");
  await runReminderTool(opts, { action: "reminder_delete", roomId: "a/b", reminderId: "r/1" }, "s 1");
  expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "PATCH", "DELETE"]);
  expect(requests[0]?.url).toContain("/rooms/a%2Fb/reminders?sessionID=s%201");
  expect(requests[1]?.body).toEqual({ sessionID: "s 1", schedule, text: "hello" });
  expect(requests[2]?.body).toEqual({ sessionID: "s 1", schedule: serverTimezoneSchedule, paused: false });
  expect(requests[3]?.body).toEqual({ sessionID: "s 1" });
  expect(requests.every(({ auth }) => auth === "Bearer secret")).toBe(true);
});

test("reminders fail explicitly outside central mode and validate required identifiers", async () => {
  expect(await runReminderTool({ center: "", token: "" }, { action: "reminder_list", roomId: "r" }, "s")).toContain("central server mode");
  expect(await runReminderTool({ center: "http://center", token: "" }, { action: "reminder_create", roomId: "r" }, "s")).toBe("error: schedule is required");
  expect(await runReminderTool({ center: "http://center", token: "" }, { action: "reminder_delete", roomId: "r" }, "s")).toBe("error: reminderId is required");
});
