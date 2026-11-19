/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-join-layout-token";

test.skipIf(!browserModule)("the join masthead stays above the balanced content on every width", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-join-layout-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#joinView").waitFor({ state: "visible" });
    for (const [width, height] of [[1280, 900], [1024, 768], [768, 900], [390, 844], [320, 640]] as Array<[number, number]>) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(160);
      const metrics = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        const head = box(".join-head"), entries = box(".join-entries"), icon = box("#btnJoinSettings svg");
        const cards = Array.from(document.querySelectorAll<HTMLElement>(".join-entries > .entry-card")).map((card) => Math.round(card.getBoundingClientRect().width));
        return {
          headerAbove: head.bottom <= entries.top,
          brand: Boolean(document.querySelector(".join-head .wordmark-row")),
          settingsEntry: Boolean(document.querySelector(".join-head #btnJoinSettings")),
          iconVisible: icon.width > 0 && icon.height > 0,
          cards: cards.length, widths: [...new Set(cards)],
          columns: getComputedStyle(document.querySelector(".join-entries")!).gridTemplateColumns.split(" ").length,
          rooms: document.querySelectorAll("#roomList li").length >= 0,
          overflow: document.documentElement.scrollWidth <= innerWidth && document.querySelector("#joinView")!.scrollWidth <= document.querySelector("#joinView")!.clientWidth,
        };
      });
      expect(metrics.headerAbove).toBe(true);
      expect(metrics.brand && metrics.settingsEntry && metrics.iconVisible).toBe(true);
      expect(metrics.cards).toBe(3);
      expect(metrics.rooms).toBe(true);
      expect(metrics.overflow).toBe(true);
      if (width > 860) expect(metrics.columns).toBe(2);
      else expect(metrics.columns).toBe(1);
    }
    // Resizing while the restore view is up (no active room) used to throw in captureReadingPosition.
    await page.evaluate(() => {
      document.documentElement.classList.add("session-restore");
      document.querySelector<HTMLElement>("#joinView")!.hidden = true;
      document.querySelector<HTMLElement>("#restoreView")!.hidden = false;
    });
    await page.setViewportSize({ width: 420, height: 700 });
    await page.setViewportSize({ width: 820, height: 700 });
    await page.waitForTimeout(180);
    expect(pageErrors).toEqual([]);
  } finally { await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true }); }
}, 60000);

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