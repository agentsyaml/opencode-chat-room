/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "web-lifecycle-local-token";

test.skipIf(!browserModule)("local browser protects room lifecycle state", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-lifecycle-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshotDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    await authorize(page);
    await page.goto(`${origin}/chat`);
    const roomA = await createRoom(page, "Room A");
    await send(page, "ONLY_ROOM_A");
    const roomB = await createRoom(page, "Room B");
    await send(page, "ONLY_ROOM_B");
    await switchTo(page, roomA);
    expect(await messageExists(page, "ONLY_ROOM_A")).toBe(true);
    expect(await messageExists(page, "ONLY_ROOM_B")).toBe(false);
    await switchTo(page, roomB);
    expect(await messageExists(page, "ONLY_ROOM_B")).toBe(true);
    expect(await messageExists(page, "ONLY_ROOM_A")).toBe(false);
    await switchTo(page, roomA);
    expect(await messageExists(page, "ONLY_ROOM_B")).toBe(false);
    await page.screenshot({ path: path.join(screenshotDir, "lifecycle-room-switch.png"), fullPage: true });

    await failedSendKeepsNewDraft(page, roomA, roomB, screenshotDir);
    await delayedJoinKeepsLatestIntent(page, origin);
    await delayedCreateKeepsLatestIntent(page, origin, roomB);
    await delayedDirectKeepsLatestIntent(browser, page, origin, roomA, roomB);
    await deleteOnlyRequestedRoom(page, roomA, roomB);
    await reconciliationWaitsForVisibleBottom(page, origin, screenshotDir);
    await stalePollCannotRemoveRejoinedRoom(browser, origin, screenshotDir);
    await inactivePreviewShowsNewestMessage(browser, origin, screenshotDir);
    await context.close();
    await sameNameGroupIdentity(browser, origin);
    await allJoinedRoomsReachable(browser, origin);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function authorize(page: any, sessionID?: string) {
  await page.addInitScript(({ token, sessionID }: { token: string; sessionID?: string }) => {
    localStorage.setItem("chat.token", token);
    if (sessionID) sessionStorage.setItem("chat.sessionID", sessionID);
  }, { token, sessionID });
}

async function createRoom(page: any, name: string, memberName = "Lifecycle tester") {
  if (await page.locator("#chatView").isVisible()) {
    await page.locator("#btnNewRoom").click();
    await page.locator("#inRoomNameChat").fill(name);
    await page.locator("#btnCreateChatRoom").click();
  } else {
    await page.locator("#inName").fill(memberName);
    await page.locator("#inRoomName").fill(name);
    await page.locator("#btnCreate").click();
  }
  await page.waitForFunction((value: string) => document.querySelector("#roomName")?.textContent === value, name);
  return roomId(page);
}

async function send(page: any, text: string) {
  await page.locator("#msgInput").fill(text);
  await page.locator("#btnSend").click();
  await page.locator("#msgList").getByText(text).waitFor();
}

async function switchTo(page: any, id: string) {
  await page.locator(`#roomListChat [data-room-id="${id}"]`).click();
  await page.waitForFunction((roomId: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(roomId), id);
}

async function messageExists(page: any, text: string) {
  return page.locator("#msgList").getByText(text).count().then((count: number) => count > 0);
}

async function roomId(page: any) {
  const title = await page.locator("#btnCopyId").getAttribute("title");
  return title.slice(title.lastIndexOf(": ") + 2);
}

async function failedSendKeepsNewDraft(page: any, roomA: string, roomB: string, screenshotDir: string) {
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { seen = resolve; });
  const pattern = `**/rooms/${roomA}/messages`;
  await page.route(pattern, async (route: any) => {
    seen(); await gate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) });
  });
  await switchTo(page, roomA);
  await page.locator("#msgInput").fill("Failed first send");
  await page.locator("#btnSend").click();
  await requested;
  await page.locator("#msgInput").fill("Newer draft survives");
  await switchTo(page, roomB);
  release();
  await page.waitForTimeout(100);
  await switchTo(page, roomA);
  expect(await page.locator("#msgInput").inputValue()).toBe("Newer draft survives");
  expect(await page.evaluate((id: string) => JSON.parse(sessionStorage.getItem("chat.drafts") || "{}")[id], roomA)).toBe("Newer draft survives");
  expect(await page.locator(".failed-message").getByText("Failed first send").count()).toBe(1);
  await page.unroute(pattern);
  await page.reload(); await switchTo(page, roomA);
  expect(await page.locator("#msgInput").inputValue()).toBe("Newer draft survives");
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(screenshotDir, "failed-message-retry.png"), fullPage: true });
  await page.locator(".failed-message").filter({ hasText: "Failed first send" }).getByRole("button", { name: "Retry" }).click();
  await page.locator("#msgList").getByText("Failed first send").waitFor();
  expect(await page.locator("#msgInput").inputValue()).toBe("Newer draft survives");
  expect((await api(new URL(page.url()).origin, `/rooms/${roomA}`)).messages.filter((item: any) => item.text === "Failed first send").length).toBe(1);
  await page.route(pattern, (route: any) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) }));
  await page.locator("#msgInput").fill("Discard this failed message");
  await page.locator("#btnSend").click();
  const failed = page.locator(".failed-message").filter({ hasText: "Discard this failed message" });
  await failed.getByRole("button", { name: "Discard" }).click();
  await failed.waitFor({ state: "detached" });
  expect(await page.evaluate((id: string) => JSON.parse(sessionStorage.getItem("chat.failedMessages") || "{}")[id] || [], roomA)).toHaveLength(0);
  await page.unroute(pattern);
}

async function delayedJoinKeepsLatestIntent(page: any, origin: string) {
  const first = await createUnjoinedRoom(origin, "Slow join", "slow-owner");
  const second = await createUnjoinedRoom(origin, "Fast join", "fast-owner");
  await page.locator("#btnRefreshRooms").click();
  await page.locator(`#roomListChat [data-room-id="${first}"]`).waitFor();
  let release!: () => void, seen!: () => void, finished!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { seen = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  const pattern = `**/rooms/${first}/join`;
  await page.route(pattern, async (route: any) => {
    const response = await route.fetch(); seen(); await gate;
    await route.fulfill({ response }); finished();
  });
  await page.locator(`#roomListChat [data-room-id="${first}"]`).click();
  await requested;
  await page.locator(`#roomListChat [data-room-id="${second}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), second);
  release(); await completed;
  await page.waitForTimeout(100);
  expect(await roomId(page)).toBe(second);
  await page.unroute(pattern);
}

async function delayedDirectKeepsLatestIntent(browser: any, page: any, origin: string, roomA: string, roomB: string) {
  const context = await browser.newContext(), peer = await context.newPage();
  await authorize(peer); await peer.goto(`${origin}/chat`);
  await peer.locator("#inName").fill("Direct peer");
  await peer.locator("#inRoomId").fill(roomA);
  await peer.locator("#btnJoin").click();
  await peer.locator("#chatView").waitFor({ state: "visible" });
  await switchTo(page, roomA);
  await page.locator("#btnMembers").click();
  await page.locator("#memberList").getByText("Direct peer").waitFor();
  const privateButton = page.getByRole("button", { name: "Message privately" }).first();
  let release!: () => void, seen!: () => void, finished!: () => void, directId = "";
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { seen = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  await page.route("**/direct", async (route: any) => {
    const response = await route.fetch(), data = await response.json();
    directId = data.id; seen(); await gate;
    await route.fulfill({ response }); finished();
  });
  await privateButton.click(); await requested;
  await switchTo(page, roomB);
  release(); await completed; await page.waitForTimeout(100);
  expect(await roomId(page)).toBe(roomB);
  await page.locator(`#roomListChat [data-room-id="${directId}"].joined`).waitFor();
  await context.close();
}

async function delayedCreateKeepsLatestIntent(page: any, origin: string, activeRoom: string) {
  let release!: () => void, seen!: () => void, finished!: () => void, createdId = "";
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { seen = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  await page.route("**/rooms", async (route: any) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(), data = await response.json();
    createdId = data.id; seen(); await gate;
    await route.fulfill({ response }); finished();
  });
  await page.locator("#btnNewRoom").click();
  await page.locator("#inRoomNameChat").fill("Late created room");
  await page.locator("#btnCreateChatRoom").click(); await requested;
  await switchTo(page, activeRoom);
  release(); await completed; await page.waitForTimeout(100);
  expect(await roomId(page)).toBe(activeRoom);
  await page.locator(`#roomListChat [data-room-id="${createdId}"].joined`).waitFor();
  await page.unroute("**/rooms");
}

async function deleteOnlyRequestedRoom(page: any, roomA: string, roomB: string) {
  let release!: () => void, seen!: () => void, finished!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { seen = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  const pattern = `**/rooms/${roomA}`;
  await page.route(pattern, async (route: any) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const response = await route.fetch(); seen(); await gate;
    await route.fulfill({ response }); finished();
  });
  await switchTo(page, roomA);
  page.once("dialog", (dialog: any) => void dialog.accept());
  await page.locator("#btnDeleteRoom").click(); await requested;
  await switchTo(page, roomB);
  release(); await completed;
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), roomB);
  expect(await page.evaluate((id: string) => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]").includes(id), roomB)).toBe(true);
  await page.unroute(pattern);
}

async function reconciliationWaitsForVisibleBottom(page: any, origin: string, artifactDir: string) {
  const id = await createRoom(page, "Reconcile room"), sid = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.LS.sessionID, "/assets/chat/state.js");
  for (let i = 0; i < 8; i++) await api(origin, `/rooms/${id}/messages`, "POST", { sessionID: sid, text: `History ${i} ${"word ".repeat(80)}` });
  await page.reload(); await switchTo(page, id);
  const thread = page.locator("#thread"); await thread.evaluate((node: HTMLElement) => { node.scrollTop = 0; });
  const reads: string[] = [];
  page.on("request", (request: any) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/read") reads.push(request.postDataJSON().roomId);
  });
  await page.waitForTimeout(100);
  reads.length = 0;
  await page.evaluate(async ({ roomId, modulePath }: { roomId: string; modulePath: string }) => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.hasFocus = () => false;
    const { app } = await import(modulePath);
    app.state.room.messages = [];
    app.state.rooms.get(roomId).readTs = 0;
    await app.reconcileRoom(roomId);
  }, { roomId: id, modulePath: "/assets/chat/state.js" });
  await page.waitForTimeout(100);
  expect(reads).toEqual([]);
  expect(await thread.evaluate((node: HTMLElement) => node.scrollTop)).toBeLessThan(2);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.hasFocus = () => true; });
  await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.markActiveRoomRead(), "/assets/chat/state.js");
  expect(reads).toEqual([]);
  await thread.evaluate((node: HTMLElement) => { node.scrollTop = node.scrollHeight; });
  await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.markActiveRoomRead(), "/assets/chat/state.js");
  expect(reads).toContain(id);
  await page.screenshot({ path: path.join(artifactDir, "reconcile-visible-bottom.png"), fullPage: true });
}

async function stalePollCannotRemoveRejoinedRoom(browser: any, origin: string, screenshotDir: string) {
  const sid = "66666666-6666-4666-8666-666666666666";
  const room = await api(origin, "/rooms", "POST", { name: "Poll race", ownerId: "Owner", sessionID: "poll-owner" });
  await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: sid, participantId: "Victim", participantName: "Victim" });
  const context = await browser.newContext(), page = await context.newPage();
  await page.addInitScript(({ sid, id, token }: { sid: string; id: string; token: string }) => {
    localStorage.setItem("chat.token", token); sessionStorage.setItem("chat.sessionID", sid);
    sessionStorage.setItem("chat.joinedRoomIds", JSON.stringify([id])); sessionStorage.setItem("chat.roomId", id); sessionStorage.setItem("chat.name", "Victim");
    const original = window.fetch.bind(window);
    let release!: () => void, used = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    (window as any).__releaseStalePoll = () => release();
    (window as any).__stalePollStarted = false;
    window.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!used && url.pathname === "/inbox" && url.searchParams.get("roomId") === id) {
        used = true; (window as any).__stalePollStarted = true; await held;
        return Response.json({ member: false, items: [], queuedTs: {}, hasMore: false });
      }
      return original(input, init);
    }) as typeof fetch;
  }, { sid, id: room.id, token });
  await page.goto(`${origin}/chat`); await switchTo(page, room.id);
  await page.waitForFunction(() => (window as any).__stalePollStarted === true);
  await api(origin, `/rooms/${room.id}/kick`, "POST", { sessionID: "poll-owner", targetSessionID: sid });
  await page.locator("#btnLeave").click(); await page.locator("#joinView").waitFor({ state: "visible" });
  await page.locator("#inName").fill("Victim"); await page.locator("#inRoomId").fill(room.id); await page.locator("#btnJoin").click();
  await switchTo(page, room.id);
  expect((await api(origin, `/rooms/${room.id}/members`)).some((member: any) => member.sessionID === sid)).toBe(true);
  await page.evaluate(() => (window as any).__releaseStalePoll()); await page.waitForTimeout(200);
  expect(await page.locator("#chatView").isVisible()).toBe(true);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("chat.joinedRoomIds") || "[]"))).toContain(room.id);
  await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: "poll-owner", text: "Fresh poll still works" });
  await page.locator("#msgList").getByText("Fresh poll still works").waitFor({ timeout: 10000 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(screenshotDir, "poll-rejoin-stays-active.png"), fullPage: true });
  await context.close();
}

async function inactivePreviewShowsNewestMessage(browser: any, origin: string, screenshotDir: string) {
  const sid = "77777777-7777-4777-8777-777777777777", sender = "preview-sender";
  const unread = await api(origin, "/rooms", "POST", { name: "Unread burst", ownerId: "Sender", sessionID: sender });
  const active = await api(origin, "/rooms", "POST", { name: "Active room", ownerId: "Sender", sessionID: sender });
  for (const room of [unread, active]) await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: sid, participantId: "Watcher", participantName: "Watcher" });
  const context = await browser.newContext(), page = await context.newPage();
  await page.addInitScript(({ sid, active, unread, token }: { sid: string; active: string; unread: string; token: string }) => {
    localStorage.setItem("chat.token", token); sessionStorage.setItem("chat.sessionID", sid);
    sessionStorage.setItem("chat.joinedRoomIds", JSON.stringify([unread, active])); sessionStorage.setItem("chat.roomId", active); sessionStorage.setItem("chat.name", "Watcher");
  }, { sid, active: active.id, unread: unread.id, token });
  await page.goto(`${origin}/chat`); await switchTo(page, active.id);
  for (let index = 0; index < 105; index++) await api(origin, `/rooms/${unread.id}/messages`, "POST", { sessionID: sender, text: `Burst ${String(index).padStart(3, "0")}` });
  const card = page.locator(`#roomListChat [data-room-id="${unread.id}"]`);
  await card.locator(".r-badge").waitFor({ timeout: 20000 });
  const latest = (await api(origin, `/rooms/${unread.id}`)).messages.at(-1).text;
  expect(await card.locator(".r-preview").textContent()).toBe(latest);
  expect(await card.locator(".r-badge").textContent()).toBe("99+");
  const inbox = await api(origin, `/inbox?sessionID=${sid}&roomId=${unread.id}&excludeSelf=0&timeout=0`);
  expect(inbox.hasMore).toBe(true);
  expect(inbox.items.length).toBe(100);
  await page.screenshot({ path: path.join(screenshotDir, "unread-over-100-latest-preview.png"), fullPage: true });
  await context.close();
}

async function sameNameGroupIdentity(browser: any, origin: string) {
  const aContext = await browser.newContext(), a = await aContext.newPage();
  await authorize(a); await a.goto(`${origin}/chat`);
  const id = await createRoom(a, "Same-name members", "Twin");
  const bContext = await browser.newContext(), b = await bContext.newPage();
  await authorize(b); await b.goto(`${origin}/chat`);
  await b.locator("#inName").fill("Twin"); await b.locator("#inRoomId").fill(id); await b.locator("#btnJoin").click();
  await b.locator("#chatView").waitFor({ state: "visible" });
  await b.locator("#btnMembers").click(); await b.locator("#memberList li").nth(1).waitFor();
  await send(a, "FROM_TWIN_A");
  const incoming = b.locator(".msg").filter({ hasText: "FROM_TWIN_A" }).last();
  await incoming.waitFor();
  expect(await incoming.evaluate((node: HTMLElement) => node.classList.contains("own"))).toBe(false);
  expect(await incoming.locator(".msg-name").textContent()).toBe("Twin");
  await send(b, "FROM_TWIN_B");
  const own = b.locator(".msg").filter({ hasText: "FROM_TWIN_B" }).last();
  expect(await own.evaluate((node: HTMLElement) => node.classList.contains("own"))).toBe(true);
  await b.locator("#msgInput").fill("@");
  await b.locator('#mentionPicker [data-name="Twin"]').waitFor();
  expect(await b.locator('#mentionPicker [data-name="Twin"]').count()).toBe(1);
  await a.locator("#btnMembers").click();
  await a.getByRole("button", { name: "Message privately" }).click();
  await a.waitForFunction((groupId: string) => !document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(groupId), id);
  const directId = await roomId(a);
  await b.locator("#btnRefreshRooms").click();
  await b.locator(`#roomListChat [data-room-id="${directId}"]`).waitFor();
  await switchTo(b, directId);
  await send(a, "DIRECT_FROM_TWIN_A");
  const directOwn = a.locator(".msg").filter({ hasText: "DIRECT_FROM_TWIN_A" }).last();
  const directIncoming = b.locator(".msg").filter({ hasText: "DIRECT_FROM_TWIN_A" }).last();
  await directIncoming.waitFor();
  expect(await directOwn.evaluate((node: HTMLElement) => node.classList.contains("own"))).toBe(true);
  expect(await directIncoming.evaluate((node: HTMLElement) => node.classList.contains("own"))).toBe(false);
  await aContext.close(); await bContext.close();
}

async function allJoinedRoomsReachable(browser: any, origin: string) {
  const sid = "88888888-8888-4888-8888-888888888888", ids: string[] = [];
  for (let index = 0; index < 41; index++) {
    const room = await api(origin, "/rooms", "POST", { name: `Room ${index}`, ownerId: `owner-${index}`, sessionID: `owner-session-${index}` });
    ids.push(room.id);
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: sid, participantId: "Many rooms", participantName: "Many rooms" });
  }
  const context = await browser.newContext(), page = await context.newPage();
  await page.addInitScript(({ ids, sid, token }: { ids: string[]; sid: string; token: string }) => {
    localStorage.setItem("chat.token", token);
    sessionStorage.setItem("chat.sessionID", sid);
    sessionStorage.setItem("chat.joinedRoomIds", JSON.stringify(ids));
    sessionStorage.setItem("chat.roomId", ids[0]!);
    sessionStorage.setItem("chat.name", "Many rooms");
  }, { ids, sid, token });
  await page.goto(`${origin}/chat`); await switchTo(page, ids[0]!);
  expect(await page.locator("#roomListChat .room-row.joined").count()).toBe(41);
  for (const id of ids) expect(await page.locator(`#roomListChat [data-room-id="${id}"]`).count()).toBe(1);
  await context.close();
}

async function createUnjoinedRoom(origin: string, name: string, sessionID: string) {
  return (await api(origin, "/rooms", "POST", { name, ownerId: name, sessionID })).id as string;
}

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return {
    ...env, CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1",
    CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token,
    HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"),
    XDG_CONFIG_HOME: path.join(stateDir, "config"),
  };
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}
