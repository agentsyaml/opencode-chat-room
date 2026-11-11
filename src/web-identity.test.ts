import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { app, createAuth } from "../server/assets/chat/state.js";

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  } as unknown as Storage & { values: Map<string, string> };
}

const idA = "11111111-1111-4111-8111-111111111111";
const idB = "22222222-2222-4222-8222-222222222222";

test("canonical browser identity wins on reload and in another tab", () => {
  const local = storage({ "chat.browserIdentity": JSON.stringify({ sessionID: idA, name: "Preferred" }) });
  const first = createAuth(local, fetch, undefined, storage());
  const secondTab = createAuth(local, fetch, undefined, storage({ "chat.sessionID": idB, "chat.name": "Legacy tab" }));
  expect(first.LS.sessionID).toBe(idA);
  expect(secondTab.LS.sessionID).toBe(idA);
  expect(secondTab.LS.name).toBe("Preferred");
});

test("migration preserves this tab identity and ignores obsolete shared identity keys", () => {
  const local = storage({ "chat.sessionID": idB, "chat.name": "Old shared name", "chat.token": "secret", "chat.locale": "zh-CN" });
  const auth = createAuth(local, fetch, undefined, storage({ "chat.sessionID": idA, "chat.name": "Tab name" }));
  expect(auth.LS.sessionID).toBe(idA);
  expect(auth.LS.name).toBe("Tab name");
  expect(JSON.parse(local.getItem("chat.browserIdentity")!)).toEqual({ sessionID: idA, name: "Tab name" });
  expect(auth.LS.token).toBe("secret");
  expect(auth.LS.locale).toBe("zh-CN");
});

test("new identity ignores stale shared keys and persists its preferred name", () => {
  const local = storage({ "chat.sessionID": idB, "chat.name": "Do not adopt" });
  const auth = createAuth(local, fetch, undefined, storage());
  const id = auth.LS.sessionID;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(id).not.toBe(idB);
  expect(auth.LS.name).toBe("");
  auth.LS.name = "New name";
  expect(JSON.parse(local.getItem("chat.browserIdentity")!)).toEqual({ sessionID: id, name: "New name" });
  expect(createAuth(local, fetch, undefined, storage()).LS.name).toBe("New name");
});

test("canonical identity change fails before an API request and never retargets this page", async () => {
  const local = storage({ "chat.browserIdentity": JSON.stringify({ sessionID: idA, name: "A" }) });
  let requests = 0;
  const localizedApp = app as any, previousLocale = localizedApp.locale;
  localizedApp.locale = "zh-CN";
  const auth = createAuth(local, (async () => { requests++; return Response.json({ ok: true }); }) as unknown as typeof fetch, (key: string) => localizedApp.t(key));
  expect(auth.LS.sessionID).toBe(idA);
  local.setItem("chat.browserIdentity", JSON.stringify({ sessionID: idB, name: "B" }));
  try {
    await expect(auth.api("/mutate", { method: "POST", body: "{}" })).rejects.toMatchObject({
      identityConflict: true, message: "此浏览器身份已在另一个标签页中更改，请重新加载此标签页后继续。",
    });
    expect(auth.LS.sessionID).toBe(idA);
    expect(requests).toBe(0);
  } finally { localizedApp.locale = previousLocale; }
});

test("canonical change during a request prevents applying its response", async () => {
  const local = storage({ "chat.browserIdentity": JSON.stringify({ sessionID: idA, name: "A" }) });
  let finish!: (response: Response) => void;
  const auth = createAuth(local, (() => new Promise<Response>((resolve) => { finish = resolve; })) as unknown as typeof fetch);
  const request = auth.api("/mutate", { method: "POST", body: "{}" });
  local.setItem("chat.browserIdentity", JSON.stringify({ sessionID: idB, name: "B" }));
  finish(Response.json({ ok: true }));
  await expect(request).rejects.toMatchObject({ identityConflict: true });
  expect(auth.LS.sessionID).toBe(idA);
});

test("blocked storage keeps an in-memory identity without blocking requests", async () => {
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } } as unknown as Storage;
  let requests = 0;
  const auth = createAuth(blocked, (async () => { requests++; return Response.json({ ok: true }); }) as unknown as typeof fetch, undefined, blocked);
  const id = auth.LS.sessionID;
  await auth.api("/rooms");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(auth.LS.sessionID).toBe(id);
  expect(requests).toBe(1);
});

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
test.skipIf(!browserModule)("persistent browser restores rooms and tabs drain inbox pages independently", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const browserOptions = { headless: true, ...(process.env.CHAT_UI_BROWSER_EXECUTABLE ? { executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE } : {}) };
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-identity-"));
  const userDataDir = path.join(stateDir, "browser-profile"), port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`, token = "identity-test-token";
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port, token), stdio: "ignore" });
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    await waitForServer(origin);
    context = await chromium.launchPersistentContext(userDataDir, browserOptions);
    await context.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    const identity = await persistentBrowserFlow(context, origin, token);
    await context.close();
    context = await chromium.launchPersistentContext(userDataDir, browserOptions);
    await context.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    const relaunched = await context.newPage();
    const joins: string[] = [];
    let memberFailures = 0;
    await relaunched.route(`**/rooms/${identity.roomID}/members`, async (route: any) => {
      memberFailures++;
      if (memberFailures === 1) await route.abort("failed");
      else if (memberFailures === 2) await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "temporary authentication failure" }) });
      else if (memberFailures === 3) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary server failure" }) });
      else await route.continue();
    });
    relaunched.on("request", (request: any) => { if (request.method() === "POST" && /\/join(?:\?|$)/.test(request.url())) joins.push(request.url()); });
    await relaunched.goto(`${origin}/chat`);
    await relaunched.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, "Persistent identity room");
    expect(memberFailures).toBeGreaterThanOrEqual(4);
    await relaunched.evaluate(() => { (document.querySelector("#tokenBox") as HTMLDetailsElement).open = false; });
    expect(await relaunched.evaluate(() => JSON.parse(localStorage.getItem("chat.browserIdentity") || "{}").sessionID)).toBe(identity.sessionID);
    expect(await relaunched.evaluate(() => JSON.parse(localStorage.getItem("chat.browserIdentity") || "{}").name)).toBe("Preferred");
    await api(origin, `/rooms/${encodeURIComponent(identity.roomID)}`, token, { method: "DELETE", body: JSON.stringify({ sessionID: identity.sessionID }) });
    await relaunched.reload();
    await relaunched.locator("#joinView").waitFor({ state: "visible" });
    expect(joins).toEqual([]);
  } finally {
    await context?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120000);

async function persistentBrowserFlow(context: any, origin: string, token: string) {
  const legacyID = "33333333-3333-4333-8333-333333333333", pageA = await context.newPage();
  await pageA.addInitScript((id: string) => { sessionStorage.setItem("chat.sessionID", id); sessionStorage.setItem("chat.name", "Preferred"); localStorage.setItem("chat.sessionID", "44444444-4444-4444-8444-444444444444"); }, legacyID);
  await pageA.goto(`${origin}/chat`);
  await pageA.locator("#inName").fill("Preferred");
  await pageA.locator("#inRoomName").fill("Persistent identity room");
  await pageA.locator("#btnCreate").click();
  await pageA.locator("#chatView").waitFor({ state: "visible" });
  const identity = await pageA.evaluate(() => JSON.parse(localStorage.getItem("chat.browserIdentity") || "{}"));
  expect(identity.sessionID).toBe(legacyID);
  expect(identity.name).toBe("Preferred");
  const rooms = await api(origin, `/rooms?sessionID=${encodeURIComponent(identity.sessionID)}`, token);
  const room = rooms.find((item: any) => item.name === "Persistent identity room");
  expect(room).toBeTruthy();
  await pageA.locator("#msgInput").fill("Draft belongs to tab A");
  const pageB = await context.newPage(), joins: string[] = [];
  pageB.on("request", (request: any) => { if (request.method() === "POST" && /\/join(?:\?|$)/.test(request.url())) joins.push(request.url()); });
  await pageB.goto(`${origin}/chat`);
  await pageB.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Persistent identity room");
  expect(await pageB.locator("#msgInput").evaluate((node: any) => node.value)).toBe("");
  expect(await pageB.evaluate(() => JSON.parse(localStorage.getItem("chat.browserIdentity") || "{}").sessionID)).toBe(identity.sessionID);
  await pageA.evaluate(async (args: { id: string; url: string }) => (await import(args.url)).app.savePosition(args.id, 123), { id: room.id, url: "/assets/chat/state.js" });
  expect(await pageB.evaluate((id: string) => JSON.parse(sessionStorage.getItem("chat.positions") || "{}")[id], room.id)).toBeUndefined();
  expect(joins).toEqual([]);
  await pageA.reload();
  await pageA.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Persistent identity room");
  expect(await pageA.locator("#msgInput").evaluate((node: any) => node.value)).toBe("Draft belongs to tab A");
  await pageB.evaluate(async (url: string) => (await import(url)).app.stopPolling(), "/assets/chat/state.js");
  const cursor = await pageB.evaluate(async (args: { id: string; url: string }) => (await import(args.url)).app.state.rooms.get(args.id).receivedTs, { id: room.id, url: "/assets/chat/state.js" });
  await pageA.locator("#msgInput").fill("OWN-TAB-A");
  await pageA.locator("#btnSend").click();
  await pageA.locator("#msgList").getByText("OWN-TAB-A").waitFor();
  const peerID = "55555555-5555-4555-8555-555555555555";
  await api(origin, `/rooms/${encodeURIComponent(room.id)}/join`, token, { method: "POST", body: JSON.stringify({ sessionID: peerID, participantId: "Peer", participantName: "Peer" }) });
  for (let index = 0; index < 205; index++) {
    await api(origin, `/rooms/${encodeURIComponent(room.id)}/messages`, token, { method: "POST", body: JSON.stringify({ sessionID: peerID, text: `PEER-BURST-${index}` }) });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await pageA.waitForFunction(() => Array.from(document.querySelectorAll("#msgList .msg-text")).filter((node) => node.textContent?.startsWith("PEER-BURST-")).length === 205, undefined, { timeout: 30000 });
  await pageA.locator("#thread").evaluate((thread: HTMLElement) => { thread.scrollTop = 0; });
  await pageA.bringToFront();
  await pageA.waitForFunction(() => { const thread = document.querySelector<HTMLElement>("#thread")!; return thread.scrollHeight - thread.scrollTop - thread.clientHeight > 160; });
  await pageA.locator("#btnJump").waitFor({ state: "visible" });
  await pageA.locator("#btnJump").click();
  await pageA.waitForFunction(() => { const thread = document.querySelector<HTMLElement>("#thread")!; return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 2; });
  expect(await pageA.evaluate(async (url: string) => (await import(url)).app.state.readAnchorGuard, "/assets/chat/state.js")).toBeNull();
  await pageA.evaluate(async (url: string) => (await import(url)).app.markActiveRoomRead(), "/assets/chat/state.js");
  const latest = await api(origin, `/rooms/${encodeURIComponent(room.id)}` , token);
  const registry = await api(origin, `/rooms/${encodeURIComponent(room.id)}/registry`, token);
  expect(registry[identity.sessionID].lastReadTs).toBeGreaterThanOrEqual(Math.max(...latest.messages.map((message: any) => message.createdAt)));
  await pageB.evaluate(async (url: string) => (await import(url)).app.startPolling(), "/assets/chat/state.js");
  await pageB.waitForFunction(() => Array.from(document.querySelectorAll("#msgList .msg-text")).filter((node) => node.textContent?.startsWith("PEER-BURST-")).length === 205, undefined, { timeout: 30000 });
  const received = await pageB.locator("#msgList .msg-text").allTextContents();
  expect(received.filter((text: string) => text.startsWith("PEER-BURST-")).length).toBe(205);
  expect(received.some((text: string) => text.startsWith("OWN-TAB-A"))).toBe(true);
  expect(Number.isSafeInteger(cursor)).toBe(true);
  await blockedStorageFlow(context, origin, token);
  await retryActiveRestore(pageA, room.id);
  return { ...identity, roomID: room.id };
}

async function retryActiveRestore(page: any, roomID: string) {
  let attempts = 0;
  await page.route(`**/rooms/${roomID}/members`, async (route: any) => {
    attempts++;
    if (attempts === 1) await route.abort("failed");
    else if (attempts === 2) await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
    else if (attempts === 3) await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    else await route.continue();
  });
  await page.reload();
  await page.waitForFunction(async (args: { id: string; url: string }) => {
    const { app } = await import(args.url);
    return app.state.restorePending?.has(args.id) && app.LS.roomId === args.id;
  }, { id: roomID, url: "/assets/chat/state.js" }, { timeout: 10000 });
  expect(await page.evaluate(async (url: string) => (await import(url)).app.LS.name, "/assets/chat/state.js")).toBe("Preferred");
  await page.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, "Persistent identity room", { timeout: 30000 });
  expect(attempts).toBeGreaterThanOrEqual(4);
  await page.unroute(`**/rooms/${roomID}/members`);
}

async function blockedStorageFlow(context: any, origin: string, token: string) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const local = localStorage, session = sessionStorage, get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (key) { if (this === local || this === session) throw Error("blocked"); return get.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (this === local || this === session) throw Error("blocked"); return set.call(this, key, value); };
    Storage.prototype.removeItem = function (key) { if (this === local || this === session) throw Error("blocked"); return remove.call(this, key); };
  });
  await page.goto(`${origin}/chat`);
  const identity = await page.evaluate(async (args: { url: string; token: string }) => {
    const { app } = await import(args.url);
    app.setToken(args.token);
    return app.LS.sessionID;
  }, { url: "/assets/chat/state.js", token });
  await page.locator("#inName").fill("Memory only");
  await page.locator("#inRoomName").fill("Memory identity room");
  await page.locator("#btnCreate").click();
  await page.locator("#chatView").waitFor({ state: "visible" });
  expect(await page.evaluate(async (url: string) => (await import(url)).app.LS.sessionID, "/assets/chat/state.js")).toBe(identity);
  await page.close();
}

async function api(origin: string, route: string, token: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${origin}${route}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("No available port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Wait for startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("Isolated chat server did not start");
}

function isolatedEnv(stateDir: string, port: number, token: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CHAT_ROOM_SERVER_URL;
  delete env.CHAT_ROOM_WAKE_SERVE_URL;
  return { ...env, HOME: path.join(stateDir, "home"), XDG_CONFIG_HOME: path.join(stateDir, "config"), XDG_STATE_HOME: path.join(stateDir, "state"),
    CHAT_ROOM_STATE_DIR: path.join(stateDir, "chat-state"), CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
