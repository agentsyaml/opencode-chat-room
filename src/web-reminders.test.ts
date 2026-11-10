import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-reminders-local-token";

test.skipIf(!browserModule)("reminders use the room API and preserve drafts on errors", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-reminders-")), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(directory, port), stdio: "ignore" });
  let browser: any, failCreate = true;
  const reminders = new Map<string, any[]>(), calls: any[] = [];
  let nextGetGate: { started: () => void; startedPromise: Promise<void>; release: () => void; blocked: Promise<void> } | null = null;
  function holdNextGet() {
    let signal!: () => void, release!: () => void;
    const gate = { startedPromise: new Promise<void>((resolve) => { signal = resolve; }), blocked: new Promise<void>((resolve) => { release = resolve; }), started: () => signal(), release: () => release() };
    nextGetGate = gate; return gate;
  }
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage(); page.setDefaultTimeout(8000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.route("**/rooms/*/reminders**", async (route: any) => {
      const request = route.request(), method = request.method(), url = new URL(request.url());
      const match = url.pathname.match(/\/rooms\/([^/]+)\/reminders(?:\/([^/]+))?/), room = decodeURIComponent(match![1]!), id = match![2];
      calls.push({ method, url: request.url(), body: method === "GET" ? undefined : request.postDataJSON() });
      const entries = reminders.get(room) || [];
      if (method === "GET") {
        const gate = nextGetGate; nextGetGate = null;
        if (gate) { gate.started(); await gate.blocked; }
        return route.fulfill({ json: { reminders: entries } });
      }
      if (method === "POST") {
        if (failCreate) { failCreate = false; return route.fulfill({ status: 422, json: { error: "Timezone rejected by test" } }); }
        const body = request.postDataJSON();
        if (body.schedule.type === "once" && ["2027-03-14T02:30:00", "2027-10-03T02:15:00", "2027-11-07T01:30:00"].includes(body.schedule.at)) return route.fulfill({ status: 400, json: { error: "Server rejected ambiguous or nonexistent local time" } });
        const schedule = body.schedule.type === "once" ? { ...body.schedule, at: `${body.schedule.at}.000Z` } : body.schedule;
        const reminder = { id: `r${entries.length + 1}`, ...body, schedule, paused: false, createdBy: "tester", nextRunAt: "2027-12-01T00:00:00.000Z" };
        reminders.set(room, [...entries, reminder]); return route.fulfill({ json: { reminder } });
      }
      const updated = method === "DELETE" ? entries.filter((entry) => entry.id !== id) : entries.map((entry) => entry.id === id ? { ...entry, paused: request.postDataJSON().paused } : entry);
      reminders.set(room, updated); return route.fulfill({ json: { reminder: updated[0] } });
    });
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Reminder tester"); await page.locator("#inRoomName").fill("Reminder room"); await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#btnReminders").click();
    await page.locator("#reminderText").fill("Standup for {room} at {time}");
    await page.locator("#reminderType").selectOption("cron"); await page.locator("#reminderCron").fill("0 9 * * 1-5");
    await page.locator("#reminderForm button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#reminderStatus")?.textContent?.includes("Timezone rejected by test"));
    expect(calls.find((call) => call.method === "POST")?.body.schedule.timezone).toBeUndefined();
    const createRace = holdNextGet(), staleEmpty = page.waitForResponse((response: any) => response.request().method() === "GET" && response.url().includes("/reminders?"));
    await page.locator("#btnRefreshReminders").click();
    await createRace.startedPromise;
    expect(await page.locator("#reminderText").inputValue()).toBe("Standup for {room} at {time}");
    await page.locator("#reminderTimezone").fill("Asia/Tokyo");
    await page.locator("#reminderForm button[type=submit]").click();
    await page.locator(".reminder-list li").waitFor();
    createRace.release(); await staleEmpty;
    expect(await page.locator(".reminder-list li").count()).toBe(1);
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    expect(reminders.get(roomId)?.[0]).toMatchObject({ schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Tokyo" }, text: "Standup for {room} at {time}" });
    expect(calls.find((call) => call.method === "GET")?.url).toContain("sessionID=");
    await page.locator(".reminder-list li button").nth(0).click();
    await page.locator(".reminder-list li button").getByText("Resume").waitFor();
    expect(calls.findLast((call) => call.method === "PATCH")).toMatchObject({ body: { sessionID: expect.any(String), paused: true } });
    const deleteRace = holdNextGet(), staleReminder = page.waitForResponse((response: any) => response.request().method() === "GET" && response.url().includes("/reminders?"));
    await page.locator("#btnRefreshReminders").click(); await deleteRace.startedPromise;
    page.once("dialog", (dialog: any) => dialog.accept());
    await page.locator(".reminder-list li button").nth(1).click();
    await page.locator(".reminder-list li").waitFor({ state: "detached" });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", body: { sessionID: expect.any(String) } });
    deleteRace.release(); await staleReminder;
    expect(await page.locator(".reminder-list li").count()).toBe(0);
    await page.locator("#reminderType").selectOption("once");
    await page.locator("#reminderText").fill("Server default reminder");
    await page.locator("#reminderAt").fill("2027-12-15T09:20");
    await page.locator("#reminderTimezone").fill("");
    await page.locator("#reminderForm button[type=submit]").click();
    await page.locator(".reminder-list li").waitFor();
    expect(calls.findLast((call) => call.method === "POST")?.body.schedule).toEqual({ type: "once", at: "2027-12-15T09:20:00" });
    expect(await page.locator(".reminder-list li .hint").last().textContent()).toContain("UTC");
    await page.locator("#reminderText").fill("Explicit zone reminder");
    await page.locator("#reminderAt").fill("2027-12-20T09:20");
    await page.locator("#reminderTimezone").fill("Asia/Tokyo");
    await page.locator("#reminderForm button[type=submit]").click();
    await page.waitForFunction(() => document.querySelectorAll(".reminder-list li").length === 2);
    expect(calls.findLast((call) => call.method === "POST")?.body.schedule).toEqual({ type: "once", at: "2027-12-20T09:20:00", timezone: "Asia/Tokyo" });
    expect(await page.locator(".reminder-list li .hint").last().textContent()).toContain("Asia/Tokyo");
    await page.locator("#reminderTimezone").fill("America/New_York");
    const postCount = () => calls.filter((call) => call.method === "POST").length;
    const beforeGaps = postCount();
    await page.locator("#reminderAt").fill("2027-03-14T02:30"); await page.locator("#reminderForm button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#reminderStatus")?.textContent?.includes("Server rejected ambiguous or nonexistent local time"));
    expect(calls.at(-1)?.body.schedule).toEqual({ type: "once", at: "2027-03-14T02:30:00", timezone: "America/New_York" });
    expect(postCount()).toBe(beforeGaps + 1);
    await page.locator("#reminderTimezone").fill("Australia/Lord_Howe");
    await page.locator("#reminderAt").fill("2027-10-03T02:15"); await page.locator("#reminderForm button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#reminderStatus")?.textContent?.includes("Server rejected ambiguous or nonexistent local time"));
    expect(calls.at(-1)?.body.schedule).toEqual({ type: "once", at: "2027-10-03T02:15:00", timezone: "Australia/Lord_Howe" });
    await page.locator("#reminderTimezone").fill("America/New_York");
    await page.locator("#reminderAt").fill("2027-11-07T01:30"); await page.locator("#reminderForm button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#reminderStatus")?.textContent?.includes("Server rejected ambiguous or nonexistent local time"));
    expect(calls.at(-1)?.body.schedule).toEqual({ type: "once", at: "2027-11-07T01:30:00", timezone: "America/New_York" });
    expect(postCount()).toBe(beforeGaps + 3);
    expect(await page.locator("#reminderText").inputValue()).toBe("Explicit zone reminder");
    await page.evaluate(async (url: string) => { const { app } = await import(url); app.locale = "zh-CN"; app.applyLocale(); }, "/assets/chat/state.js");
    expect(await page.locator("#reminderHeading").textContent()).toBe("提醒");
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#reminderText").fill("Keep this draft when changing rooms");
    const sessionID = await page.evaluate(async (url: string) => (await import(url)).LS.sessionID, "/assets/chat/state.js");
    const other = await api(origin, "/rooms", "POST", { name: "Second reminder room", ownerId: "Reminder tester", sessionID });
    await api(origin, `/rooms/${other.id}/join`, "POST", { sessionID, participantId: "Reminder tester", participantName: "Reminder tester" });
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.joinRoom(id, "Reminder tester"), { url: "/assets/chat/state.js", id: other.id });
    await page.waitForFunction((id: string) => document.querySelector("#roomName")?.textContent === "Second reminder room", other.id);
    expect(await page.locator("#reminderText").inputValue()).toBe("");
    expect(reminders.get(other.id)).toBeUndefined();
    await page.locator("#reminderText").fill("Room B private draft"); await page.locator("#reminderType").selectOption("cron");
    await page.locator("#reminderCron").fill("30 8 * * *");
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.activateRoom(id), { url: "/assets/chat/state.js", id: roomId });
    await page.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, "Reminder room");
    expect(await page.locator("#reminderText").inputValue()).toBe("Keep this draft when changing rooms");
    expect(await page.locator("#reminderAt").inputValue()).toBe("2027-11-07T01:30");
    expect(await page.locator("#reminderTimezone").inputValue()).toBe("America/New_York");
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.activateRoom(id), { url: "/assets/chat/state.js", id: other.id });
    await page.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, "Second reminder room");
    expect(await page.locator("#reminderText").inputValue()).toBe("Room B private draft");
    expect(await page.locator("#reminderCron").inputValue()).toBe("30 8 * * *");
  } finally {
    await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);

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
