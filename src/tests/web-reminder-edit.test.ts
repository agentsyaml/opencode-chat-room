/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-reminder-edit-token";

test.skipIf(!browserModule)("reminder edits reject bad zones, keep drafts, and never double submit", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-reminder-edit-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(directory, port), stdio: "ignore" });
  let browser: any;
  const seeded: any = { id: "r1", text: "Seeded reminder", schedule: { type: "once", at: "2027-12-20T00:20:00.000Z", timezone: "Asia/Tokyo" }, paused: false, nextRunAt: "2027-12-20T00:20:00.000Z" };
  let list = [seeded];
  const calls: any[] = [], pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.route("**/rooms/*/reminders**", async (route: any) => {
      const request = route.request(), method = request.method(), id = new URL(request.url()).pathname.split("/").pop();
      calls.push({ method, body: method === "GET" ? undefined : request.postDataJSON() });
      if (method === "GET") return route.fulfill({ json: { reminders: list } });
      if (method === "POST") {
        const body = request.postDataJSON(), reminder = { id: `r${list.length + 1}`, ...body, paused: false };
        list = [...list, reminder]; return route.fulfill({ json: { reminder } });
      }
      const body = request.postDataJSON();
      list = list.map((entry) => entry.id !== id ? entry : { ...entry, ...(body.text === undefined ? {} : { text: body.text }), ...(body.schedule === undefined ? {} : { schedule: body.schedule }), ...(body.paused === undefined ? {} : { paused: body.paused }) });
      return route.fulfill({ json: { reminder: list.find((entry) => entry.id === id) } });
    });
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Edit tester"); await page.locator("#inRoomName").fill("Edit room"); await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomA = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    await openReminders(page);
    await page.locator(".reminder-list li").getByText("Seeded reminder").waitFor();

    // A bad zone must be reported in the form, not thrown out of the submit handler.
    await page.locator(".reminder-list li button").filter({ hasText: "Edit" }).click();
    expect(await page.locator("#reminderDialogHeading").textContent()).toBe("Edit reminder");
    await page.locator("#reminderTimezone").fill("Not/AZone");
    const patches = () => calls.filter((call) => call.method === "PATCH").length;
    await page.locator("#btnSubmitReminder").click();
    await page.waitForFunction(() => document.querySelector("#reminderDialogStatus")?.textContent?.includes("IANA timezone"));
    expect(patches()).toBe(0);
    expect(pageErrors).toEqual([]);
    expect(await page.locator("#reminderDialog").evaluate((node: HTMLDialogElement) => node.open)).toBe(true);

    // Parking a fresh draft, then saving text only, must not turn New into another edit.
    await page.locator("#btnCancelReminder").click();
    await page.locator("#btnNewReminder").click();
    await page.locator("#reminderAt").fill("2027-12-21T09:00");
    await page.locator("#reminderText").fill("Parked draft");
    await page.locator("#btnCancelReminder").click();
    await page.locator(".reminder-list li button").filter({ hasText: "Edit" }).click();
    await page.locator("#reminderTimezone").fill("Asia/Tokyo");
    await page.locator("#reminderText").fill("Edited seeded reminder");
    await page.locator("#btnSubmitReminder").click();
    await page.locator(".reminder-list li").getByText("Edited seeded reminder").waitFor();
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(calls.at(-1)?.body.schedule).toBeUndefined();
    await page.locator("#btnNewReminder").click();
    expect(await page.locator("#reminderDialogHeading").textContent()).toBe("Create reminder");
    expect(await page.locator("#reminderText").inputValue()).toBe("Parked draft");

    // Changing the time must still send the new schedule.
    await page.locator("#btnCancelReminder").click();
    await page.locator(".reminder-list li button").filter({ hasText: "Edit" }).first().click();
    await page.locator("#reminderAt").fill("2027-12-25T08:30");
    await page.locator("#btnSubmitReminder").click();
    await page.waitForFunction(() => document.querySelector("#reminderStatus")?.textContent === "Reminder updated.");
    expect(calls.at(-1)?.body.schedule).toEqual({ type: "once", at: "2027-12-25T08:30:00", timezone: "Asia/Tokyo" });

    // Two submits in one task must produce one reminder.
    await page.locator("#btnNewReminder").click();
    await page.locator("#reminderAt").fill("2027-12-22T09:00");
    await page.locator("#reminderText").fill("Single send");
    await page.locator("#reminderForm").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await page.waitForFunction(() => document.querySelectorAll(".reminder-list li").length === 2);
    await page.waitForTimeout(200);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

    // Leaving the room while editing must keep the parked create draft for that room.
    await page.locator("#btnNewReminder").click();
    await page.locator("#reminderText").fill("Draft keeps its room");
    await page.locator("#btnCancelReminder").click();
    await page.locator(".reminder-list li button").filter({ hasText: "Edit" }).first().click();
    const sessionID = await page.evaluate(async (url: string) => (await import(url)).LS.sessionID, "/assets/chat/state.js");
    const other = await api(origin, "/rooms", "POST", { name: "Draft room", ownerId: "Edit tester", sessionID });
    await api(origin, `/rooms/${other.id}/join`, "POST", { sessionID, participantId: "Edit tester", participantName: "Edit tester" });
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.joinRoom(id, "Edit tester"), { url: "/assets/chat/state.js", id: other.id });
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Draft room");
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.activateRoom(id), { url: "/assets/chat/state.js", id: roomA });
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Edit room");
    await openReminders(page);
    await page.locator("#btnNewReminder").click();
    expect(await page.locator("#reminderText").inputValue()).toBe("Draft keeps its room");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);

async function openReminders(page: any) {
  if (await page.locator("#remindersDialog").evaluate((node: HTMLDialogElement) => node.open)) return;
  await page.locator("#btnRoomOptions").click();
  await page.locator("#btnReminders").click();
  await page.locator("#remindersDialog[open]").waitFor();
}

function isolatedEnv(directory: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(directory, "home"), XDG_STATE_HOME: path.join(directory, "state"), XDG_CONFIG_HOME: path.join(directory, "config"), CHAT_ROOM_STATE_DIR: directory, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function api(origin: string, route: string, method: string, body: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}
async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}
async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local chat server did not start");
}