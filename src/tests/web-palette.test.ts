/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-palette-token";

test.skipIf(!browserModule)("Alt+Space palette searches messages, switches scope, and runs commands", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-palette-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await import("node:fs/promises").then(({ mkdir }) => mkdir(screenshotDir, { recursive: true }));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: "light", reducedMotion: "no-preference" });
    page.setDefaultTimeout(15000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_PaletteOwner");
    await page.locator("#inRoomName").fill("__Test_PaletteRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const firstRoom = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");

    await page.locator("#msgInput").fill("The lantern code is violet-orchid-42.");
    await page.locator("#btnSend").click();
    await page.locator("#msgList .msg-text").filter({ hasText: "violet-orchid-42" }).waitFor();

    // Alt+Space opens one dialog from the composer and focuses the search field.
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("paletteInput");
    const commands = await page.locator("#paletteList .palette-command .palette-label").allTextContents();
    expect(commands).toEqual([
      "Refresh rooms", "Create room", "Settings", "Members", "Questions",
      "Announcements", "Reminders", "Leave room", "Jump to latest",
    ]);
    expect(await page.locator("#paletteScopeLabel").textContent()).toBe("This room");
    await page.screenshot({ path: path.join(screenshotDir, "web-palette-desktop-commands-1280.png") });

    // Escape closes and returns focus to the composer, not to the opener button.
    await page.keyboard.press("Escape");
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");
    await page.locator("#btnRefreshRooms").focus();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("btnRefreshRooms");

    // A pending search reports its state; the app.searchMessages hook is used when present.
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      (app as any).searchMessages = () => new Promise((resolve) => setTimeout(() => resolve([]), 450));
    }, "/assets/chat/state.js");
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.locator("#paletteInput").fill("violet");
    await page.locator("#paletteStatus").filter({ hasText: "Searching…" }).waitFor();
    await page.locator("#paletteStatus").filter({ hasText: "No messages found." }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });
    await page.evaluate(async (url: string) => { const { app } = await import(url); delete (app as any).searchMessages; }, "/assets/chat/state.js");

    // Message search shows room, sender, time, and the matching snippet.
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.locator("#paletteInput").fill("violet-orchid-42");
    const result = page.locator("#paletteList .palette-result").filter({ hasText: "violet-orchid-42" });
    await result.waitFor();
    expect(await result.count()).toBe(1);
    const meta = await result.evaluate((row: Element) => ({
      room: row.querySelector(".palette-room")?.textContent || "",
      sender: row.querySelector(".palette-sender")?.textContent || "",
      time: row.querySelector(".palette-time")?.textContent || "",
      snippet: row.querySelector(".palette-snippet")?.textContent || "",
    }));
    expect(meta.room).toBe("__Test_PaletteRoom");
    expect(meta.sender).toBe("__Test_PaletteOwner");
    expect(meta.time.length).toBeGreaterThan(0);
    expect(meta.snippet).toContain("violet-orchid-42");
    await page.screenshot({ path: path.join(screenshotDir, "web-palette-desktop-results-1280.png") });

    // Arrow selection and Enter open the hit and leave it highlighted.
    await page.keyboard.press("ArrowDown");
    expect(await result.getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#paletteInput").getAttribute("aria-activedescendant")).toBe(await result.getAttribute("id"));
    await page.keyboard.press("Enter");
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });
    await page.locator("#msgList [data-msg-id].palette-hit").waitFor();
    expect(await page.locator("#msgList [data-msg-id].palette-hit").textContent()).toContain("violet-orchid-42");

    // Tab switches to all joined rooms, finds the other room's message, and switches back.
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      await app.createRoom({ name: "__Test_PaletteOwner", roomName: "__Test_PaletteOther", joinPolicy: "open", fromChat: true });
    }, "/assets/chat/state.js");
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_PaletteOther");
    await page.locator("#msgInput").fill("A separate needle lives only in the other room 77.");
    await page.locator("#btnSend").click();
    await page.locator("#msgList .msg-text").filter({ hasText: "separate needle" }).waitFor();
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => { const { app } = await import(url); app.activateRoom(id); }, { url: "/assets/chat/state.js", id: firstRoom });
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_PaletteRoom");

    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.locator("#paletteInput").fill("separate needle");
    await page.locator("#paletteStatus").filter({ hasText: "No messages found." }).waitFor();
    expect(await page.locator("#paletteScopeLabel").textContent()).toBe("This room");
    await page.keyboard.press("Tab");
    expect(await page.locator("#paletteScopeLabel").textContent()).toBe("All rooms");
    const otherResult = page.locator("#paletteList .palette-result").filter({ hasText: "separate needle" });
    await otherResult.waitFor();
    expect(await otherResult.first().locator(".palette-room").textContent()).toBe("__Test_PaletteOther");
    await page.keyboard.press("Tab");
    expect(await page.locator("#paletteScopeLabel").textContent()).toBe("This room");
    await page.locator("#paletteStatus").filter({ hasText: "No messages found." }).waitFor();

    // A backdrop click closes and restores the composer too.
    await page.mouse.click(4, 4);
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");

    // Command mode filters commands instead of searching message text.
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.locator("#paletteInput").fill(">leave");
    const filtered = await page.locator("#paletteList .palette-command .palette-label").allTextContents();
    expect(filtered).toEqual(["Leave room"]);
    await page.keyboard.press("Escape");
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });

    // Mobile keeps the list inside the dialog with no horizontal overflow.
    await page.setViewportSize({ width: 390, height: 740 });
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    const mobile = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#paletteDialog")!;
      const list = dialog.querySelector<HTMLElement>("#paletteList")!;
      const box = dialog.getBoundingClientRect();
      const rows = Array.from(list.querySelectorAll<HTMLElement>(".palette-row")).map((row) => {
        const rect = row.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        pageOverflow: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
        listOverflow: list.scrollWidth - list.clientWidth,
        listOverflowY: getComputedStyle(list).overflowY,
        dialog: { left: box.left, right: box.right },
        rows,
      };
    });
    expect(mobile.pageOverflow).toBe(0);
    expect(mobile.dialogOverflow).toBe(0);
    expect(mobile.listOverflow).toBe(0);
    expect(mobile.listOverflowY).toBe("auto");
    for (const row of mobile.rows) {
      expect(row.left).toBeGreaterThanOrEqual(mobile.dialog.left - 0.5);
      expect(row.right).toBeLessThanOrEqual(mobile.dialog.right + 0.5);
    }
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "web-palette-mobile-390.png") });
    await page.keyboard.press("Escape");
    await page.locator("#paletteDialog").waitFor({ state: "hidden" });

    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120000);

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