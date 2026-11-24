/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-media-token";
const sessionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// 1x1 transparent PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.skipIf(!browserModule)("recently viewed images survive offline within an identity-partitioned cache", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-media-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    const room = await createRoom(origin);
    const roomID = room.id;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });

    // No identity message means network-only: a worker must never cache under an unknown identity.
    const bareContext = await browser.newContext();
    const barePage = await bareContext.newPage();
    await barePage.goto(`${origin}/manifest.webmanifest`);
    await barePage.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
    await barePage.reload();
    await barePage.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 20000 });
    const bareResource = await upload(origin, roomID, "bare.png");
    const bareURL = contentURL(origin, roomID, bareResource.id);
    const bare = await fetchImage(barePage, bareURL);
    expect(bare.status).toBe(200);
    expect(bare.cache).toBe("bypass");
    expect(await storedFor(barePage, bareURL)).toBe(false);
    await bareContext.close();

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    // The app keeps its worker out of automated browsers; this test wants the real one.
    await page.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));
    await page.goto(`${origin}/chat`);
    await page.evaluate(() => navigator.serviceWorker.ready.then((ready) => Boolean(ready.active)));
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 20000 });
    await postIdentity(page);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const resource = await upload(origin, roomID, "pixel.png");
    const imageURL = contentURL(origin, roomID, resource.id);

    const first = await fetchImage(page, imageURL);
    expect(first.status).toBe(200);
    expect(first.cache).toBe("miss");
    const second = await fetchImage(page, imageURL);
    expect(second.cache).toBe("hit");
    // A hit must keep the network path's safety headers and the same bytes.
    expect(second.contentType).toBe("image/png");
    expect(second.nosniff).toBe("nosniff");
    expect(second.csp).toBe("sandbox");
    expect(second.bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // The cached bytes still decode as the 1x1 image that was uploaded.
    expect(await page.evaluate(async (bytes: number[]) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      try {
        return await new Promise<boolean>((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image.naturalWidth === 1 && image.naturalHeight === 1);
          image.onerror = () => resolve(false);
          image.src = url;
        });
      } finally { URL.revokeObjectURL(url); }
    }, second.bytes)).toBe(true);

    // Chat data is never cached and never carries the media header.
    for (const route of ["/rooms", "/rooms/summary"]) {
      const reply = await page.evaluate(async ({ route, token }: any) => {
        const response = await fetch(route, { headers: { Authorization: `Bearer ${token}` } });
        return { cache: response.headers.get("x-media-cache"), status: response.status };
      }, { route, token });
      expect(reply.status).toBe(200);
      expect(reply.cache).toBeNull();
    }
    const index = await readIndex(page);
    expect(index.length).toBe(1);
    expect(index[0].url).toBe(imageURL);
    expect(index[0].identity).toMatch(/^[0-9a-f]{16}$/);
    // Neither the raw token nor the page's raw session ID may reach Cache Storage.
    const pageSessionID = await page.evaluate(() => JSON.parse(localStorage.getItem("chat.browserIdentity") || "{}").sessionID);
    expect(await page.evaluate(async ({ token, sessionID }: any) => {
      const cache = await caches.open("oc-chat-media");
      const keys = (await cache.keys()).map((request) => request.url).join("\n");
      const stored = await cache.match(new URL("/__media-index__", location.origin).href);
      const text = stored ? await stored.text() : "";
      return (keys + text).includes(token) || (keys + text).includes(sessionID);
    }, { token, sessionID: pageSessionID })).toBe(false);

    // The cached body renders without a network.
    await context.setOffline(true);
    const offline = await fetchImage(page, imageURL);
    await context.setOffline(false);
    expect(offline.cache).toBe("hit");
    expect(offline.bytes.length).toBe(png.length);

    // A 403 during background revalidation deletes the entry; the response itself stays a hit.
    await page.evaluate(async () => {
      const cache = await caches.open("oc-chat-media"), key = new URL("/__media-index__", location.origin).href;
      const stored = await cache.match(key);
      const items = stored ? JSON.parse(await stored.text()) : [];
      for (const item of items) item.revalidatedAt = Date.now() - 11 * 60 * 1000;
      await cache.put(key, new Response(JSON.stringify(items)));
    });
    const routePattern = "**/resources/*/content*";
    await context.route(routePattern, (route: any) => route.fulfill({ status: 403, contentType: "application/json", body: "{}" }));
    const stale = await fetchImage(page, imageURL);
    expect(stale.cache).toBe("hit");
    await page.waitForFunction(async (url: string) => {
      const cache = await caches.open("oc-chat-media");
      const response = await cache.match(new URL("/__media-index__", location.origin).href);
      const items = response ? await response.json() : [];
      return !items.some((item: any) => item.url === url);
    }, imageURL, { timeout: 10000 });
    await context.unroute(routePattern);
    expect((await fetchImage(page, imageURL)).cache).toBe("miss");
    expect((await fetchImage(page, imageURL)).cache).toBe("hit");

    // Switching the browser identity clears A's bytes before B can use the same URL.
    const secondID = crypto.randomUUID();
    await page.evaluate((id: string) => localStorage.setItem("chat.browserIdentity", JSON.stringify({ sessionID: id, name: "Second" })), secondID);
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 20000 });
    const secondIdentity = await page.evaluate(async ({ token, sessionID }: any) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}\n${sessionID}`));
      return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }, { token, sessionID: secondID });
    await page.waitForFunction(async (identity: string) => {
      const cache = await caches.open("oc-chat-media");
      const response = await cache.match(new URL("/__media-identity__", location.origin).href);
      return response ? (await response.json()).identity === identity : false;
    }, secondIdentity, { timeout: 10000 });
    expect(await storedFor(page, imageURL)).toBe(false);
    expect((await fetchImage(page, imageURL)).cache).toBe("miss");
    expect((await fetchImage(page, imageURL)).cache).toBe("hit");

    // Signing out clears every body but keeps a valid identity record for the worker.
    await page.evaluate(async () => { const url = "/assets/chat/state.js"; (await import(url)).app.setToken(""); });
    await page.waitForFunction(async () => {
      const keys = await (await caches.open("oc-chat-media")).keys();
      return keys.every((request) => !request.url.includes("/resources/"));
    }, undefined, { timeout: 10000 });
    await page.evaluate(async (value: string) => {
      const url = "/assets/chat/state.js";
      const { app } = await import(url);
      app.setToken(value);
      await app.postMediaIdentity();
    }, token);

    // LRU caps are enforced on put; expose the limits so the test can shrink them.
    await worker.evaluate(() => { (self as any).__MEDIA_LIMITS__.entries = 2; });
    for (const name of ["cap-1.png", "cap-2.png", "cap-3.png"]) {
      const capped = await upload(origin, roomID, name);
      await fetchImage(page, contentURL(origin, roomID, capped.id));
    }
    const cappedIndex = await readIndex(page);
    expect(Array.isArray(cappedIndex)).toBe(true);
    expect(cappedIndex.length).toBeLessThanOrEqual(2);
    expect(await bodyKeys(page)).toBeLessThanOrEqual(2);
    await worker.evaluate(() => { (self as any).__MEDIA_LIMITS__.entries = 80; });

    // The age prune drops a 31-day-old entry and leaves a parseable index.
    const staleURL = contentURL(origin, roomID, crypto.randomUUID());
    await page.evaluate(async ({ staleURL }: any) => {
      const cache = await caches.open("oc-chat-media"), key = new URL("/__media-index__", location.origin).href;
      const response = await cache.match(key);
      const items = response ? await response.json() : [];
      const identity = "deadbeefdeadbeef", old = Date.now() - 31 * 24 * 60 * 60 * 1000;
      items.push({ key: `${staleURL}#${identity}`, url: staleURL, identity, size: 1, usedAt: old, revalidatedAt: old });
      await cache.put(key, new Response(JSON.stringify(items)));
      await cache.put(`${staleURL}?__media_identity__=${identity}`, new Response("stale"));
    }, { staleURL });
    await worker.evaluate(() => (self as any).pruneMedia());
    const pruned = await readIndex(page);
    expect(Array.isArray(pruned)).toBe(true);
    expect(pruned.some((item: any) => item.url === staleURL)).toBe(false);
    expect(pruned.every((item: any) => Date.now() - item.usedAt < 30 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(await storedFor(page, staleURL)).toBe(false);
    await context.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 150000);

async function createRoom(origin: string) {
  const response = await request(origin, "/rooms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Media cache room", ownerId: "Owner", sessionID }),
  });
  return response.json();
}

async function upload(origin: string, roomID: string, name: string) {
  const response = await request(origin, `/rooms/${encodeURIComponent(roomID)}/resources`, {
    method: "POST",
    headers: { "X-Session-ID": sessionID, "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" },
    body: png,
  });
  return (await response.json()).resource;
}

const contentURL = (origin: string, roomID: string, resourceID: string) =>
  `${origin}/rooms/${encodeURIComponent(roomID)}/resources/${encodeURIComponent(resourceID)}/content`;

async function request(origin: string, route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${origin}${route}`, { ...init, headers });
}

async function postIdentity(page: any) {
  await page.evaluate(async () => {
    const url = "/assets/chat/state.js";
    const { app } = await import(url);
    await app.postMediaIdentity();
  });
  await page.waitForFunction(async () => {
    const cache = await caches.open("oc-chat-media");
    return Boolean(await cache.match(new URL("/__media-identity__", location.origin).href));
  }, undefined, { timeout: 10000 });
}

async function fetchImage(page: any, url: string) {
  return page.evaluate(async ({ url, token }: any) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const bytes = [...new Uint8Array(await response.arrayBuffer())];
    return {
      status: response.status,
      cache: response.headers.get("x-media-cache"),
      contentType: response.headers.get("content-type"),
      nosniff: response.headers.get("x-content-type-options"),
      csp: response.headers.get("content-security-policy"),
      bytes,
    };
  }, { url, token });
}

async function readIndex(page: any) {
  return page.evaluate(async () => {
    const cache = await caches.open("oc-chat-media");
    const response = await cache.match(new URL("/__media-index__", location.origin).href);
    return response ? response.json() : [];
  });
}

async function storedFor(page: any, url: string) {
  return page.evaluate(async (url: string) => {
    const keys = await (await caches.open("oc-chat-media")).keys();
    return keys.some((request) => request.url.startsWith(url));
  }, url);
}

async function bodyKeys(page: any) {
  return page.evaluate(async () => {
    const keys = await (await caches.open("oc-chat-media")).keys();
    return keys.filter((request) => !/\/(?:__media-index__|__media-identity__)$/.test(new URL(request.url).pathname)).length;
  });
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
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