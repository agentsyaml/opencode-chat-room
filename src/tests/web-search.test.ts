/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-web-search-token";
const stateUrl = "/assets/chat/state.js";

test.skipIf(!browserModule)("web search loads old messages and jumps to a hit", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-search-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any, ownerContext: any, searchContext: any, jumpContext: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    ownerContext = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const page = await ownerContext.newPage();
    page.setDefaultTimeout(20000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_Searcher");
    await page.locator("#inRoomName").fill("__Test_SearchRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    expect(roomId).not.toBe("");

    const targetText = "unique-target-needle-alpha";
    const recalledText = "unique-recalled-needle-beta";
    const target = await page.evaluate(async ({ url, roomId, targetText, recalledText }: any) => {
      const { app } = await import(url);
      const posted: any[] = [];
      for (let index = 0; index < 350; index++) {
        const text = index === 20 ? `${targetText} index ${index}`
          : index === 340 ? `${recalledText} index ${index}`
            : `filler message ${index}`;
        const room = await app.api(`/rooms/${encodeURIComponent(roomId)}/messages`, {
          method: "POST", body: JSON.stringify({ sessionID: app.LS.sessionID, text }),
        });
        posted.push(room.messages.at(-1));
      }
      const recalled = posted[340];
      const recall = await app.api(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(recalled.id)}/recall`, {
        method: "POST", body: JSON.stringify({ sessionID: app.LS.sessionID }),
      });
      if (!recall.ok) throw new Error("recall failed");
      const hit = posted[20];
      return { id: hit.id, seq: hit.seq, createdAt: hit.createdAt, senderId: hit.senderId, recalledId: recalled.id };
    }, { url: stateUrl, roomId, targetText, recalledText });
    const identity = await page.evaluate(async (url: string) => {
      const { LS } = await import(url);
      return { sessionID: LS.sessionID, name: LS.name };
    }, stateUrl);

    // A fresh browser context has no message cache: only the newest 100 messages load.
    searchContext = await freshContext(browser, origin, { token, roomId, ...identity });
    const searchPage = searchContext.page;
    searchPage.on("pageerror", (error: Error) => errors.push(error.message));
    const initial = await searchPage.evaluate(async ({ url, targetId }: any) => {
      const { app } = await import(url);
      return {
        roomId: app.state.room?.id,
        count: app.state.room?.messages.length ?? 0,
        hasTarget: app.state.room?.messages.some((message: any) => message.id === targetId) ?? false,
        domTarget: Boolean(document.querySelector(`[data-msg-id="${CSS.escape(targetId)}"]`)),
      };
    }, { url: stateUrl, targetId: target.id });
    expect(initial.roomId).toBe(roomId);
    expect(initial.count).toBeLessThanOrEqual(100);
    expect(initial.hasTarget).toBe(false);
    expect(initial.domTarget).toBe(false);

    // Search pulls older pages from the local history API until the target shows up.
    const hits = await searchPage.evaluate(async ({ url, query, scope }: any) => {
      const { app } = await import(url);
      return app.searchMessages(query, scope);
    }, { url: stateUrl, query: targetText, scope: "room" });
    expect(hits).toHaveLength(1);
    expect(hits[0].roomId).toBe(roomId);
    expect(hits[0].roomName).toBe("__Test_SearchRoom");
    expect(hits[0].messageId).toBe(target.id);
    expect(hits[0].seq).toBe(target.seq);
    expect(hits[0].sender).toBe(target.senderId);
    expect(hits[0].text).toContain(targetText);
    expect(hits[0].snippet).toContain(targetText);
    const allHits = await searchPage.evaluate(async ({ url, query }: any) => {
      const { app } = await import(url);
      return app.searchMessages(query, "all");
    }, { url: stateUrl, query: targetText });
    expect(allHits.map((hit: any) => hit.messageId)).toContain(target.id);

    const recalled = await searchPage.evaluate(async ({ url, recalledId }: any) => {
      const { app } = await import(url);
      const message = app.state.room?.messages.find((item: any) => item.id === recalledId);
      return { recalledAt: message?.recalledAt ?? 0, text: message?.text ?? "" };
    }, { url: stateUrl, recalledId: target.recalledId });
    expect(recalled.recalledAt).toBeGreaterThan(0);
    expect(recalled.text).toBe("");
    const recalledHits = await searchPage.evaluate(async ({ url, query }: any) => {
      const { app } = await import(url);
      return app.searchMessages(query, "room");
    }, { url: stateUrl, query: recalledText });
    expect(recalledHits).toEqual([]);

    // A jump from another active room switches back, renders the old message,
    // and flashes it even though it is far above the newest DOM rows.
    jumpContext = await freshContext(browser, origin, { token, roomId, ...identity });
    const jumpPage = jumpContext.page;
    jumpPage.on("pageerror", (error: Error) => errors.push(error.message));
    await jumpPage.locator("#btnNewRoom").click();
    await jumpPage.locator("#inRoomNameChat").fill("__Test_SearchRoomB");
    await jumpPage.locator("#btnCreateChatRoom").click();
    await jumpPage.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_SearchRoomB");
    const opened = await jumpPage.evaluate(async ({ url, hit }: any) => {
      const { app } = await import(url);
      const ok = await app.openSearchHit(hit);
      const row = document.querySelector(`[data-msg-id="${CSS.escape(hit.messageId)}"]`);
      const thread = document.querySelector("#thread")!;
      const rect = row?.getBoundingClientRect(), edge = thread.getBoundingClientRect();
      return {
        ok,
        roomId: app.state.room?.id,
        loaded: app.state.room?.messages.some((message: any) => message.id === hit.messageId) ?? false,
        focus: app.state.focusMessageId,
        highlighted: row?.classList.contains("jump-flash") ?? false,
        inView: Boolean(rect && rect.bottom > edge.top && rect.top < edge.bottom),
        text: row?.textContent ?? "",
      };
    }, { url: stateUrl, hit: { roomId, messageId: target.id, seq: target.seq, createdAt: target.createdAt, senderId: target.senderId } });
    expect(opened.ok).toBe(true);
    expect(opened.roomId).toBe(roomId);
    expect(opened.loaded).toBe(true);
    expect(opened.focus).toBe(target.id);
    expect(opened.highlighted).toBe(true);
    expect(opened.inView).toBe(true);
    expect(opened.text).toContain(targetText);

    // Scrolling back to the live tail after a search jump must restore live rows.
    await jumpPage.waitForTimeout(1000);
    const returned = await jumpPage.evaluate(async (url: string) => {
      const { app } = await import(url);
      const thread = document.querySelector("#thread")!;
      thread.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true }));
      thread.scrollTop = thread.scrollHeight;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const latest = app.state.room?.messages.at(-1);
      return {
        focus: app.state.focusMessageId ?? null,
        latestText: latest?.text ?? "",
        latestRendered: Boolean(latest && document.querySelector(`[data-msg-id="${CSS.escape(latest.id)}"]`)),
      };
    }, stateUrl);
    expect(returned.focus).toBe(null);
    expect(returned.latestText).toBe("filler message 349");
    expect(returned.latestRendered).toBe(true);

    // Jumping back to latest clears the focused window and restores the tail.
    const cleared = await jumpPage.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.jumpToBottom();
      return {
        focus: app.state.focusMessageId ?? null,
        latest: app.state.room?.messages.at(-1)?.text ?? "",
        latestRendered: Boolean(document.querySelector(`[data-msg-id="${CSS.escape(app.state.room?.messages.at(-1)?.id ?? "")}"]`)),
      };
    }, stateUrl);
    expect(cleared.focus).toBe(null);
    expect(cleared.latest).toBe("filler message 349");
    expect(cleared.latestRendered).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await searchContext?.context.close(); await jumpContext?.context.close();
    await ownerContext?.close(); await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function freshContext(browser: any, origin: string, init: { token: string; sessionID: string; name: string; roomId: string }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.addInitScript((values: typeof init) => {
    localStorage.setItem("chat.token", values.token);
    localStorage.setItem("chat.browserIdentity", JSON.stringify({ sessionID: values.sessionID, name: values.name }));
    sessionStorage.setItem("chat.sessionID", values.sessionID);
    sessionStorage.setItem("chat.name", values.name);
    sessionStorage.setItem("chat.roomId", values.roomId);
  }, init);
  await page.goto(`${origin}/chat`);
  await page.locator("#chatView").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_SearchRoom");
  return { context, page };
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
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