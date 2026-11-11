/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Dialog as BrowserDialog, Request as BrowserRequest, Response as BrowserResponse, Route as BrowserRoute } from "playwright";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
test.skipIf(!browserModule)("admin panel uses scoped session token and mocked admin routes", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-admin-")), port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    binding = null;
    const page = await context.newPage(), adminHeaders: any[] = [], adminPaths: string[] = [], normalHeaders: any[] = [], roomJoins: string[] = [], registryRooms: string[] = [];
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await page.route("**/admin/**", async (route: BrowserRoute) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), body = request.postDataJSON() || {}; adminPaths.push(url.pathname);
      adminHeaders.push({ token: request.headers()["x-chat-admin-token"], bearer: request.headers().authorization });
      const response = await mockAdmin(url.pathname, method, body);
      await route.fulfill({ status: response.status || 200, contentType: "application/json", body: JSON.stringify(response.body) });
    });
    await page.route("**/registry", (route: BrowserRoute) => { registryRooms.push(new URL(route.request().url()).pathname.split("/")[2]!); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ "human-session": { name: "Human", membershipID: "human-member" }, "legacy-session": { name: "Legacy Agent", membershipID: "v1-member", protocol: "v1" }, "agent-session": { name: "Agent", membershipID: "membership", receiverOwnerID: "owner", protocol: "v2" } }) }); });
    page.on("request", (request: BrowserRequest) => { const url = new URL(request.url()); if (url.pathname.startsWith("/rooms/")) normalHeaders.push({ method: request.method(), headers: request.headers() }); if (request.method() === "POST" && url.pathname.endsWith("/join")) roomJoins.push(url.pathname); });
    await page.goto(`${origin}/chat`);
    await page.locator("#inToken").fill("ui-test-token"); await page.locator('[data-token-save="inToken"]').click();
    await page.locator("#inName").fill("__Test_Operator"); await page.locator("#inRoomName").fill("__Test_AdminControl"); await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const adminRoomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    binding = { roomId: adminRoomId, targetRoomId: adminRoomId, sessionID: "agent-session", receiverOwnerID: "owner", membershipID: "membership", enrolled: true };
    await page.locator("#btnSettings").click(); await page.locator("#adminAccessHeading").click(); await page.locator("#inAdminToken").fill("operator-secret"); await page.locator("#btnSaveAdminToken").click();
    await page.locator("#btnOpenAdmin").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden && Boolean(document.querySelector("#roomListChat .room-admin-badge")));
    expect(await page.locator("#roomListChat .room-admin-badge").count()).toBe(1);
    expect(await page.evaluate(() => document.body.textContent?.includes("operator-secret"))).toBe(false);
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden && Boolean(document.querySelector("#roomListChat .room-admin-badge")));
    expect(await page.evaluate(() => document.body.textContent?.includes("operator-secret"))).toBe(false);
    let releaseStale!: () => void, staleStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; }), staleRequest = new Promise<void>((resolve) => { staleStarted = resolve; });
    await page.route("**/admin/rooms", async (route: BrowserRoute) => {
      if (route.request().headers()["x-chat-admin-token"] === "stale-token") { staleStarted(); await staleGate; return route.fulfill({ json: { rooms: [] } }); }
      await route.fallback();
    });
    await page.locator("#btnSettings").click(); await page.locator("#adminAccessHeading").click();
    await page.locator("#inAdminToken").fill("stale-token"); await page.locator("#btnSaveAdminToken").click(); await staleRequest;
    await page.locator("#inAdminToken").fill("operator-secret"); await page.locator("#btnSaveAdminToken").click();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden);
    releaseStale(); await page.waitForTimeout(50);
    expect(await page.locator("#roomListChat .room-admin-badge").count()).toBe(1);
    expect(await page.evaluate(() => document.body.textContent?.includes("operator-secret"))).toBe(false);
    await page.locator("#btnOpenAdmin").click();
    await page.locator("#adminDialog[open]").waitFor();
    const adminLayout = await page.evaluate(() => {
      const refresh = document.querySelector("#btnRefreshAdmin")!.getBoundingClientRect();
      const close = document.querySelector("#btnCloseAdmin")!.getBoundingClientRect();
      const select = document.querySelector("#adminRoomSelect")!.getBoundingClientRect();
      const section = document.querySelector(".admin-guide")!.getBoundingClientRect();
      return { closeAfterRefresh: close.left > refresh.right, selectFitsSection: select.left >= section.left && select.right <= section.right };
    });
    expect(adminLayout).toEqual({ closeAfterRefresh: true, selectFitsSection: true });
    await page.locator("#adminRoomSelect:not(:disabled)").waitFor();
    expect(await page.locator("#adminTargetRoom").count()).toBe(0);
    const roomId = adminRoomId;
    await page.locator("#adminRoomSelect").selectOption(roomId);
    const deleteHeaders: any[] = [];
    await page.route(`${origin}/rooms/${roomId}`, async (route: BrowserRoute) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deleteHeaders.push(route.request().headers());
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "operator token required to delete a designated admin or target room" }) });
    });
    expect(await page.locator("#adminRoomSelect").inputValue()).toBe(roomId);
    await page.waitForFunction(() => (document.querySelector("#adminTargetAgent") as HTMLSelectElement).options.length > 1);
    expect(registryRooms).toContain(roomId);
    expect(await page.locator('#adminTargetAgent option[value="human-session"]').count()).toBe(0);
    expect(await page.locator('#adminTargetAgent option[value="legacy-session"]').count()).toBe(1);
    expect(await page.locator('#adminTargetAgent option[value="agent-session"]').textContent()).toBe("Agent");
    await page.locator("#adminTargetAgent").selectOption("agent-session");
    expect(await page.locator("#adminTargetAgent").inputValue()).toBe("agent-session");
    await page.locator("#btnDesignateAgent").click();
    await page.locator("#adminEnrollment button").waitFor({ timeout: 3000 }).catch(async () => { throw new Error(await page.locator("#adminStatus").textContent()); });
    expect(await page.locator("#activeAdminBadge").isVisible()).toBe(true);
    expect(await page.locator("#roomListChat .room-admin-badge").count()).toBe(1);
    expect(await page.locator("body").innerText()).not.toContain("operator-secret");
    expect(await page.locator("#adminEnrollment code").count()).toBe(0);
    expect(await page.locator("#adminEnrollment").innerText()).toMatch(/private|privately/i);
    expect(await page.locator("#adminEnrollment").innerText()).not.toContain("admin(action=");
    expect(await page.locator("#adminEnrollment textarea").count()).toBe(0);
    if (process.env.CHAT_UI_SCREENSHOT_DIR) { await mkdir(process.env.CHAT_UI_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "admin-panel-desktop.png"), fullPage: true }); }
    await page.locator("#adminEnrollment button").click();
    const manualInstruction = `admin(action='admin_claim',roomId='${roomId}',enrollmentKey='private-key')`;
    expect(await page.locator("#adminEnrollment textarea").inputValue()).toBe(manualInstruction);
    expect(await page.locator("#adminEnrollment textarea").evaluate((field: HTMLTextAreaElement) => ({ readOnly: field.readOnly, selected: field.selectionStart === 0 && field.selectionEnd === field.value.length }))).toEqual({ readOnly: true, selected: true });
    expect(adminPaths.some((pathname) => /\/(overview|tasks|plans)(\/|$)/.test(pathname))).toBe(false);
    page.once("dialog", (dialog: BrowserDialog) => void dialog.accept()); await page.locator("#btnRevokeAdmin").click();
    await page.locator("#btnRevokeAdmin").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden && !document.querySelector("#roomListChat .room-admin-badge"));
    await page.locator("#btnCloseAdmin").click(); await page.locator("#btnRoomOptions").click();
    await page.evaluate(() => sessionStorage.removeItem("chat.adminToken"));
    page.once("dialog", (dialog: BrowserDialog) => void dialog.accept()); await page.locator("#btnDeleteRoom").click();
    await page.locator("#sendError").waitFor({ state: "visible" });
    expect(await page.locator("#sendError").textContent()).toContain("Administration token in Settings");
    expect(await page.locator("#roomName").textContent()).toBe("__Test_AdminControl");
    await page.evaluate(() => sessionStorage.setItem("chat.adminToken", "operator-secret"));
    page.once("dialog", (dialog: BrowserDialog) => void dialog.accept()); await page.locator("#btnDeleteRoom").click();
    expect(deleteHeaders.map((headers) => headers["x-chat-admin-token"])).toEqual([undefined, "operator-secret"]);
    expect(adminHeaders.length).toBeGreaterThan(4);
    expect(adminHeaders.every((headers) => headers.token === "operator-secret" && headers.bearer === "Bearer ui-test-token")).toBe(true);
    expect(normalHeaders.filter((request) => request.method !== "DELETE").every((request) => !request.headers["x-chat-admin-token"])).toBe(true);
    expect(roomJoins).toEqual([]);
    expect(await page.evaluate(() => [sessionStorage.getItem("chat.adminToken"), localStorage.getItem("chat.adminToken")])).toEqual(["operator-secret", null]);
    await context.close();
  } finally { await browser?.close(); server.kill(); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

test.skipIf(!browserModule)("admin UI binds agents and privately claims designation against real routes", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-admin-live-")), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const adminToken = "operator-secret", bearer = "ui-test-token";
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port, adminToken), stdio: "ignore" });
  let browser: any, roomId = "", agentRoomId = "", sessionID = "";
  const request = async (url: string, method: string, body?: unknown, operator = false) => fetch(`${origin}${url}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(operator ? { "X-Chat-Admin-Token": adminToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage(), adminPaths: string[] = []; page.on("request", (request: BrowserRequest) => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith("/admin/")) adminPaths.push(pathname); }); await page.goto(`${origin}/chat`); await page.locator("#joinView").waitFor({ state: "visible" });
    await page.locator("#inToken").fill(bearer); await page.locator('[data-token-save="inToken"]').click();
    await page.locator("#inName").fill("__Test_Operator"); await page.locator("#inRoomName").fill("__Test_AdminControl"); await page.locator("#btnCreate").click(); await page.locator("#chatView").waitFor({ state: "visible" });
    roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || ""); sessionID = await page.evaluate(() => sessionStorage.getItem("chat.sessionID") || "");
    const agentSession = randomUUID(), ownerID = randomUUID(), membershipID = `__Test_${randomUUID()}`;
    const targetResponse = await request("/rooms", "POST", { name: "__Test_V2Agent", ownerId: "__Test_V2Agent", sessionID: agentSession, protocol: "v2", receiverOwnerID: ownerID });
    expect(targetResponse.status).toBe(201); agentRoomId = (await targetResponse.json() as { id: string }).id;
    expect((await request(`/rooms/${agentRoomId}/join`, "POST", { sessionID: agentSession, participantId: "__Test_V2Agent", participantName: "__Test_V2Agent", protocol: "v2", receiverOwnerID: ownerID })).status).toBe(201);
    const db = new Database(path.join(stateDir, "chat-room.sqlite"));
    db.query("UPDATE registry SET membership_id=? WHERE room_id=? AND session_id=?").run(membershipID, agentRoomId, agentSession); db.close();
    expect((await (await request(`/rooms/${agentRoomId}/registry`, "GET")).json())[agentSession]).toMatchObject({ membershipID, receiverOwnerID: ownerID, protocol: "v2" });
    expect((await request(`/rooms/${roomId}/join`, "POST", { sessionID: agentSession, participantId: "__Test_V2Agent", participantName: "__Test_V2Agent", protocol: "v2", receiverOwnerID: ownerID })).status).toBe(201);
    const adminDB = new Database(path.join(stateDir, "chat-room.sqlite")); adminDB.query("UPDATE registry SET membership_id=? WHERE room_id=? AND session_id=?").run(membershipID, roomId, agentSession); adminDB.close();
    await page.locator("#btnSettings").click(); await page.locator("#adminAccessHeading").click();
    await page.locator("#inAdminToken").fill(adminToken); await page.locator("#btnSaveAdminToken").click();
    await page.locator("#btnOpenAdmin").waitFor({ state: "visible" }); await page.locator("#btnOpenAdmin").click();
    await page.locator("#adminRoomSelect:not(:disabled)").waitFor();
    expect(await page.locator("#adminTargetRoom").count()).toBe(0);
    await page.locator("#adminRoomSelect").selectOption(roomId);
    await page.waitForFunction((id: string) => Array.from((document.querySelector("#adminTargetAgent") as HTMLSelectElement).options).some((option) => option.value === id), agentSession);
    expect(await page.locator(`#adminTargetAgent option[value="${agentSession}"]`).textContent()).toBe("__Test_V2Agent");
    await page.locator("#adminTargetAgent").selectOption(agentSession);
    let issued!: (value: any) => void; const issuedResult = new Promise<any>((resolve) => { issued = resolve; });
    page.on("response", async (response: BrowserResponse) => { if (response.request().method() === "POST" && new URL(response.url()).pathname === "/admin/rooms") issued(await response.json()); });
    await page.locator("#btnDesignateAgent").click();
    const enrollment = await issuedResult;
    expect(enrollment.adminRoom).toMatchObject({ roomId, targetRoomId: roomId, sessionID: agentSession, receiverOwnerID: ownerID, membershipID, enrolled: false });
    await page.locator("#adminEnrollment button").waitFor();
    expect(await page.locator("#adminEnrollment code").count()).toBe(0);
    expect(await page.locator("#adminEnrollment").innerText()).toMatch(/private|privately/i);
    await page.locator("#adminEnrollment button").click();
    const instruction = await page.evaluate(() => navigator.clipboard.readText());
    expect(instruction).toBe(`admin(action='admin_claim',roomId='${roomId}',enrollmentKey='${enrollment.enrollmentKey}')`);
    expect(instruction).not.toContain(adminToken);
    const claim = await page.evaluate(async (input: { roomId: string; sessionID: string; receiverOwnerID: string; enrollmentKey: string }) => {
      const response = await fetch(`/admin/rooms/${input.roomId}/claim`, { method: "POST", headers: { Authorization: "Bearer ui-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ sessionID: input.sessionID, receiverOwnerID: input.receiverOwnerID, enrollmentKey: input.enrollmentKey }) });
      return { status: response.status, body: await response.json() };
    }, { roomId, sessionID: agentSession, receiverOwnerID: ownerID, enrollmentKey: enrollment.enrollmentKey });
    expect(claim.status).toBe(200); expect(claim.body.adminRoom.enrolled).toBe(true); expect(claim.body.capability).toBeTruthy();
    expect(adminPaths.some((pathname) => /\/(overview|tasks|plans)(\/|$)/.test(pathname))).toBe(false);
    expect(await page.locator("#adminRoomSelect").inputValue()).toBe(roomId);
    page.once("dialog", (dialog: BrowserDialog) => void dialog.accept()); await page.locator("#btnRevokeAdmin").click();
    await page.locator("#btnRevokeAdmin").waitFor({ state: "hidden" });
    expect((await request(`/rooms/${roomId}`, "DELETE", { sessionID }, true)).status).toBe(200);
    expect((await request(`/rooms/${agentRoomId}`, "DELETE", { sessionID: agentSession }, true)).status).toBe(200);
    await context.close();
  } finally { await browser?.close(); server.kill(); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

let binding: any;
async function mockAdmin(pathname: string, method: string, body: any) {
  if (pathname === "/admin/rooms" && method === "GET") return { body: { rooms: binding ? [binding] : [] } };
  if (pathname === "/admin/rooms" && method === "POST" || /^\/admin\/rooms\/[^/]+$/.test(pathname) && method === "PUT") {
    binding = { roomId: body.roomId || pathname.split("/").at(-1), targetRoomId: body.targetRoomId, sessionID: body.sessionID, receiverOwnerID: body.receiverOwnerID, membershipID: body.membershipID, enrolled: false };
    return { status: 201, body: { adminRoom: binding, enrollmentKey: "private-key", expiresAt: Date.now() + 60000 } };
  }
  const id = pathname.split("/")[3];
  if (pathname === `/admin/rooms/${id}` && method === "DELETE") { binding = null; return { body: { ok: true } }; }
  return { status: 404, body: { error: "mock route not found" } };
}

async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port; await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
function isolatedEnv(stateDir: string, port: number, adminToken = "backend-only-token") {
  return { ...process.env, CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: "ui-test-token", CHAT_ROOM_ADMIN_TOKEN: adminToken, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state") };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local test server did not start");
}
