import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-join-approval-token";

// A protected room must hold a browser join outside membership until a human
// administrator approves it, and a denied applicant must be able to retry.
test.skipIf(!browserModule)("a browser joins a protected room only after approval", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-join-approval-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const owner = await openPage(browser, origin, "Owner");
    await owner.locator("#inRoomName").fill("Protected room");
    await owner.locator("#inApprovalRequired").check();
    await owner.locator("#btnCreate").click();
    await owner.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await owner.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");

    const applicant = await openPage(browser, origin, "Applicant");
    await applicant.locator("#inRoomId").fill(roomId);
    await applicant.locator("#btnJoin").click();
    await applicant.locator("#joinPending").waitFor({ state: "visible" });
    expect((await applicant.locator("#joinPendingBody").textContent())?.trim()).toContain("Protected room");
    expect(await applicant.evaluate(async (url: string) => (await import(url)).app.state.rooms.size, "/assets/chat/state.js")).toBe(0);

    await owner.locator("#btnMembers").click();
    await owner.locator("#joinRequests").waitFor({ state: "visible" });
    const request = owner.locator("#joinRequestList li").filter({ hasText: "Applicant" });
    await request.waitFor();
    expect((await request.textContent())?.trim()).toContain("Human");
    const badge = owner.locator("#joinRequestBadge");
    expect((await badge.textContent())?.trim()).toBe("1");
    expect(await badge.getAttribute("title")).toContain("1 join request");
    expect(await owner.locator("#joinRequestBadgeWord").count()).toBe(0);
    await request.locator('[data-request-action="approve"]').click();
    await owner.locator("#joinRequestList li").waitFor({ state: "detached" });

    await applicant.locator("#chatView").waitFor({ state: "visible", timeout: 10000 });
    expect(await applicant.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js")).toBe(roomId);

    const denied = await openPage(browser, origin, "Denied");
    await denied.locator("#inRoomId").fill(roomId);
    await denied.locator("#btnJoin").click();
    await denied.locator("#joinPending").waitFor({ state: "visible" });
    await showRequests(owner);
    const deniedRow = owner.locator("#joinRequestList li").filter({ hasText: "Denied" });
    await deniedRow.waitFor();
    await deniedRow.locator('[data-request-action="deny"]').click();
    await owner.locator("#joinRequestList li").waitFor({ state: "detached" });

    await denied.locator("#btnJoinPendingAgain").waitFor({ state: "visible", timeout: 10000 });
    await denied.locator("#btnJoinPendingAgain").click();
    await denied.locator("#joinPending").waitFor({ state: "visible" });
    await showRequests(owner);
    const retryRow = owner.locator("#joinRequestList li").filter({ hasText: "Denied" });
    await retryRow.waitFor();
    await retryRow.locator('[data-request-action="approve"]').click();
    await owner.locator("#joinRequestList li").waitFor({ state: "detached" });
    await denied.locator("#chatView").waitFor({ state: "visible", timeout: 10000 });

    // Joining a second protected room from the chat rail must show pending
    // feedback without leaving the room the browser is already in.
    await owner.locator("#btnNewRoom").click();
    await owner.locator("#inRoomNameChat").fill("Second protected");
    await owner.locator("#inApprovalRequiredChat").check();
    await owner.locator("#btnCreateChatRoom").click();
    await owner.waitForFunction(async (url: string) => (await import(url)).app.state.room?.name === "Second protected", "/assets/chat/state.js");
    const secondRoomId = await owner.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    await applicant.evaluate(async (url: string) => { await (await import(url)).app.refreshRoomList(); }, "/assets/chat/state.js");
    const secondRow = applicant.locator("#roomListChat button").filter({ hasText: "Second protected" });
    await secondRow.click();
    await applicant.locator("#joinNotice").waitFor({ state: "visible" });
    expect(await applicant.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js")).toBe(roomId);
    const cancelled = applicant.waitForResponse((response: any) => response.request().method() === "DELETE" && response.url().includes("/join-requests?") && response.status() === 200);
    await applicant.locator("#btnJoinNoticeStop").click();
    await cancelled;
    await applicant.locator("#joinNotice").waitFor({ state: "hidden" });
    const applicantSession = await applicant.evaluate(() => sessionStorage.getItem("chat.sessionID"));
    const statusResponse = await fetch(`${origin}/rooms/${secondRoomId}/join-requests/status?sessionID=${encodeURIComponent(applicantSession!)}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await statusResponse.json()).toEqual({ status: "none" });
    expect(secondRoomId).not.toBe(roomId);
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function openPage(browser: any, origin: string, name: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
  await page.goto(`${origin}/chat`);
  await page.locator("#inName").fill(name);
  return page;
}

// Reopen the member panel so a request that arrived while it was open is fetched.
async function showRequests(page: any) {
  if (await page.locator("#memberPanel").isVisible()) {
    await page.locator("#btnMembers").click();
    await page.locator("#memberPanel").waitFor({ state: "hidden" });
  }
  await page.locator("#btnMembers").click();
  await page.locator("#joinRequests").waitFor({ state: "visible" });
}

async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env }; for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local isolated chat server did not start");
}