/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Dialog as BrowserDialog, Route as BrowserRoute } from "playwright";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const bearer = "ui-test-token";

test.skipIf(!browserModule)("owner edits room name and description from the options menu; non-owner cannot", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-room-edit-")), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript((token: string) => localStorage.setItem("chat.token", token), bearer);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_Owner");
    await page.locator("#inRoomName").fill("__Test_EditRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    // The operator-token administration UI is gone; the owner sees an edit entry.
    expect(await page.locator("#inAdminToken").count()).toBe(0);
    expect(await page.locator("#adminDialog").count()).toBe(0);
    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnEditRoom").waitFor({ state: "visible" });
    await page.locator("#btnEditRoom").click();
    await page.locator("#editRoomDialog[open]").waitFor();
    expect(await page.locator("#editRoomName").inputValue()).toBe("__Test_EditRoom");
    await page.locator("#editRoomName").fill("__Test_Renamed");
    await page.locator("#editRoomDescription").fill("A room for testing edits.");
    await page.locator("#editRoomForm button[type=submit]").click();
    await page.locator("#editRoomDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_Renamed");
    expect(await page.locator("#roomDescription").textContent()).toBe("A room for testing edits.");
    expect(await page.locator("#roomDescription").isVisible()).toBe(true);
    // The edit emitted a system notification into the room and updated the sidebar.
    await page.locator("#msgList").getByText(/renamed the room/).waitFor();
    await page.waitForFunction((id: string) => document.querySelector(`#roomListChat [data-room-id="${id}"] .r-name`)?.textContent === "__Test_Renamed", roomId);
    // Empty name is rejected client-side.
    await page.locator("#btnRoomOptions").click(); await page.locator("#btnEditRoom").click();
    await page.locator("#editRoomDialog[open]").waitFor();
    await page.locator("#editRoomName").fill("   ");
    await page.locator("#editRoomForm button[type=submit]").click();
    expect(await page.locator("#editRoomDialog").evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(true);
    await page.locator("#btnCloseEditRoom").click();
    // A non-owner member does not see the edit entry.
    const peerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const peerPage = await peerContext.newPage();
    await peerPage.addInitScript((token: string) => localStorage.setItem("chat.token", token), bearer);
    await peerPage.goto(`${origin}/chat`);
    await peerPage.evaluate(async ({ url, id }: any) => { const { app } = await import(url); app.setToken("ui-test-token"); await app.joinRoom(id, "__Test_Peer"); }, { url: "/assets/chat/state.js", id: roomId });
    await peerPage.locator("#chatView").waitFor({ state: "visible" });
    await peerPage.locator("#btnRoomOptions").click();
    expect(await peerPage.locator("#btnEditRoom").isHidden()).toBe(true);
    await peerContext.close(); await context.close();
  } finally { await browser?.close(); server.kill(); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

test.skipIf(!browserModule)("owner designates an administrator agent; access is scoped and revocable; deletion cascades", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-admin-live-")), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any, roomId = "", sessionID = "";
  const request = (url: string, method: string, body?: unknown) => fetch(`${origin}${url}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const overview = (agentSession: string, ownerID: string) => fetch(`${origin}/admin/rooms/${roomId}/overview`, { headers: { Authorization: `Bearer ${bearer}`, "x-chat-agent-session": agentSession, "x-chat-agent-owner": ownerID } });
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript((token: string) => localStorage.setItem("chat.token", token), bearer);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_Owner");
    await page.locator("#inRoomName").fill("__Test_AdminControl");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    sessionID = await page.evaluate(() => sessionStorage.getItem("chat.sessionID") || "");
    const agentSession = randomUUID(), ownerID = randomUUID(), membershipID = `__Test_${randomUUID()}`;
    expect((await request(`/rooms/${roomId}/join`, "POST", { sessionID: agentSession, participantId: "__Test_Agent", participantName: "__Test_Agent", protocol: "v2", receiverOwnerID: ownerID })).status).toBe(201);
    const db = new Database(path.join(stateDir, "chat-room.sqlite"));
    db.query("UPDATE registry SET membership_id=? WHERE room_id=? AND session_id=?").run(membershipID, roomId, agentSession); db.close();
    const designate = async (value: string) => {
      await page.locator("#btnRoomOptions").click(); await page.locator("#btnEditRoom").click();
      await page.locator("#editRoomDialog[open]").waitFor();
      await page.waitForFunction((id: string) => Array.from((document.querySelector("#editRoomAdmin") as HTMLSelectElement).options).some((option) => option.value === id), agentSession);
      await page.locator("#editRoomAdmin").selectOption(value);
      await page.locator("#editRoomForm button[type=submit]").click();
      await page.locator("#editRoomDialog").waitFor({ state: "hidden" });
    };
    await designate(agentSession);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden);
    expect(await page.locator("#roomListChat .room-admin-badge").count()).toBe(1);
    expect((await overview(agentSession, ownerID)).status).toBe(200);
    expect((await overview(randomUUID(), ownerID)).status).toBe(401);
    // Revoking removes the badge and the agent's access.
    await designate("");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden);
    expect((await overview(agentSession, ownerID)).status).toBe(404);
    // Re-designate, then delete the room as a member; the binding cascades away.
    await designate(agentSession);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden);
    // A failed agent list must not turn the "None" placeholder into a revocation.
    await page.route(`**/rooms/${roomId}/registry`, (route: BrowserRoute) => route.fulfill({ status: 503, body: "unavailable" }));
    await page.locator("#btnRoomOptions").click(); await page.locator("#btnEditRoom").click();
    await page.locator("#editRoomDialog[open]").waitFor();
    await page.locator("#editRoomDescription").fill("guard check");
    await page.locator("#editRoomForm button[type=submit]").click();
    await page.locator("#editRoomDialog").waitFor({ state: "hidden" });
    await page.unroute(`**/rooms/${roomId}/registry`);
    expect((await overview(agentSession, ownerID)).status).toBe(200);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#activeAdminBadge")?.hidden);
    page.once("dialog", (dialog: BrowserDialog) => void dialog.accept());
    await page.locator("#btnRoomOptions").click(); await page.locator("#btnDeleteRoom").click();
    await page.waitForFunction((id: string) => sessionStorage.getItem("chat.roomId") !== id, roomId);
    const db2 = new Database(path.join(stateDir, "chat-room.sqlite"));
    expect(db2.query("SELECT 1 FROM admin_rooms WHERE room_id=?").get(roomId)).toBeNull();
    expect(db2.query("SELECT 1 FROM rooms WHERE id=?").get(roomId)).toBeNull(); db2.close();
    await context.close();
  } finally { await browser?.close(); server.kill(); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

test.skipIf(!browserModule)("user navigation supersedes room restoration", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href), stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-room-intent-")), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any, releaseMembers = () => {}, releaseCreate = () => {}, releaseActiveMembers = () => {}, releaseJoin = () => {};
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage();
    await page.goto(`${origin}/chat`); await page.locator("#tokenBox").evaluate((details: HTMLDetailsElement) => { details.open = true; });
    // Drive setup through the app: form values typed on slow CI machines were gone by submit time.
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.setToken("ui-test-token");
      await app.createRoom({ name: "__Test_Operator", roomName: "__Test_OldRoom" });
    }, "/assets/chat/state.js");
    await page.locator("#chatView").waitFor({ state: "visible" });
    const oldRoom = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || ""), sessionID = await page.evaluate(() => sessionStorage.getItem("chat.sessionID") || "");
    let membersStarted!: () => void, createStarted!: () => void;
    const membersPending = new Promise<void>((resolve) => { membersStarted = resolve; }), createPending = new Promise<void>((resolve) => { createStarted = resolve; });
    let releaseMembersNow!: () => void, releaseCreateNow!: () => void;
    const membersGate = new Promise<void>((resolve) => { releaseMembersNow = resolve; }), createGate = new Promise<void>((resolve) => { releaseCreateNow = resolve; });
    releaseMembers = releaseMembersNow; releaseCreate = releaseCreateNow;
    await page.route(`${origin}/rooms/${oldRoom}/members`, async (route: BrowserRoute) => { const response = await route.fetch(); membersStarted(); await membersGate; await route.fulfill({ response }); });
    await page.route(`${origin}/rooms`, async (route: BrowserRoute) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); createStarted(); await createGate; await route.fulfill({ response });
    });
    await page.reload(); await membersPending;
    await page.evaluate(() => { (document.querySelector("#inName") as HTMLInputElement).value = "__Test_Operator"; (document.querySelector("#inRoomName") as HTMLInputElement).value = "__Test_NewRoom"; document.querySelector("#createForm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await createPending;
    releaseMembers(); await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(await page.locator("#chatView").isHidden()).toBe(true);
    releaseCreate(); await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await page.evaluate(() => sessionStorage.getItem("chat.roomId"))).not.toBe(oldRoom);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]").includes(sessionStorage.getItem("chat.roomId")))).toBe(true);
    let activeRoom = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    const targetResponse = await fetch(`${origin}/rooms`, { method: "POST", headers: { Authorization: "Bearer ui-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ name: "__Test_JoinTarget", ownerId: "__Test_JoinTarget" }) });
    expect(targetResponse.status).toBe(201); const targetRoom = (await targetResponse.json() as { id: string }).id;
    let activeMembersStarted!: () => void, joinStarted!: () => void, releaseActive!: () => void, releaseJoinNow!: () => void;
    const activeMembersPending = new Promise<void>((resolve) => { activeMembersStarted = resolve; }), joinPending = new Promise<void>((resolve) => { joinStarted = resolve; }), activeGate = new Promise<void>((resolve) => { releaseActive = resolve; }), joinGate = new Promise<void>((resolve) => { releaseJoinNow = resolve; });
    releaseActiveMembers = releaseActive; releaseJoin = releaseJoinNow;
    await page.route(`${origin}/rooms/${activeRoom}/members`, async (route: BrowserRoute) => { const response = await route.fetch(); activeMembersStarted(); await activeGate; await route.fulfill({ response }); });
    await page.reload(); await activeMembersPending;
    await page.route(`${origin}/rooms/${targetRoom}/join`, async (route: BrowserRoute) => { const response = await route.fetch(); joinStarted(); await joinGate; await route.fulfill({ response }); });
    await page.evaluate((id: string) => { (document.querySelector("#inRoomId") as HTMLInputElement).value = id; (document.querySelector("#inName") as HTMLInputElement).value = "__Test_Operator"; document.querySelector("#joinForm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }, targetRoom); await joinPending;
    releaseActiveMembers(); await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))); expect(await page.locator("#chatView").isHidden()).toBe(true);
    releaseJoin(); await page.locator("#chatView").waitFor({ state: "visible" }); activeRoom = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || ""); expect(activeRoom).toBe(targetRoom);
    const workerSession = randomUUID(), ownerID = randomUUID();
    const joined = await fetch(`${origin}/rooms/${activeRoom}/join`, { method: "POST", headers: { Authorization: "Bearer ui-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ sessionID: workerSession, participantId: "__Test_Worker", participantName: "__Test_Worker", protocol: "v2", receiverOwnerID: ownerID }) });
    expect(joined.status).toBe(201);
    const direct = await fetch(`${origin}/direct`, { method: "POST", headers: { Authorization: "Bearer ui-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ roomId: activeRoom, sessionID, targetSessionID: workerSession }) });
    expect(direct.status).toBe(201); const directRoom = (await direct.json() as { id: string }).id;
    let directFailed!: () => void, groupMembersStarted!: () => void, groupMembersDone!: () => void, releaseGroupMembers!: () => void;
    const directFailure = new Promise<void>((resolve) => { directFailed = resolve; }), groupMembers = new Promise<void>((resolve) => { groupMembersStarted = resolve; }), groupGate = new Promise<void>((resolve) => { releaseGroupMembers = resolve; }), groupDone = new Promise<void>((resolve) => { groupMembersDone = resolve; });
    await page.route(`${origin}/rooms/${directRoom}/members`, async (route: BrowserRoute) => { directFailed(); await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "retry discovery" }) }); });
    await page.locator("#btnRefreshRooms").click(); await directFailure;
    await page.route(`${origin}/rooms/${activeRoom}/members`, async (route: BrowserRoute) => { const response = await route.fetch(); groupMembersStarted(); await groupGate; await route.fulfill({ response }); groupMembersDone(); });
    await groupMembers;
    await page.locator("#btnRoomOptions").click(); await page.locator("#btnLeave").click(); await page.waitForFunction((id: string) => sessionStorage.getItem("chat.roomId") !== id, activeRoom);
    releaseGroupMembers(); await groupDone; await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(await page.evaluate(() => sessionStorage.getItem("chat.roomId"))).not.toBe(activeRoom);
    expect(await page.evaluate((id: string) => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]").includes(id), activeRoom)).toBe(false);
    await context.close();
  } finally { releaseMembers(); releaseCreate(); releaseActiveMembers(); releaseJoin(); await browser?.close(); server.kill(); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

test.skipIf(!browserModule)("automatic room-list retries reuse a slow in-flight request", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href), stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-room-retry-")), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any, releaseRequest = () => {}, heldCount = 0;
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await (await browser.newContext()).newPage(); let firstRetry!: () => void;
    const retryStarted = new Promise<void>((resolve) => { firstRetry = resolve; }), retryGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    await page.route("**/rooms*", async (route: BrowserRoute) => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== "GET" || url.pathname !== "/rooms" || !url.searchParams.has("sessionID") || request.headers().authorization !== "Bearer ui-test-token") return route.continue();
      if (++heldCount <= 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary list failure" }) });
      const response = await route.fetch(); if (heldCount === 3) firstRetry(); await retryGate; await route.fulfill({ response });
    });
    await page.goto(`${origin}/chat`); await page.locator("#inToken").fill("ui-test-token"); await page.locator('[data-token-save="inToken"]').click(); await retryStarted;
    await page.waitForTimeout(5500); expect(heldCount).toBe(3);
    releaseRequest(); await page.locator("#restoreView").waitFor({ state: "hidden" }); expect(heldCount).toBe(3);
    await page.context().close();
  } finally { releaseRequest(); await browser?.close(); server.kill(); await rm(stateDir, { recursive: true, force: true }); }
}, 90000);

async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port; await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
function isolatedEnv(stateDir: string, port: number) {
  return { ...process.env, CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: bearer, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state") };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local test server did not start");
}