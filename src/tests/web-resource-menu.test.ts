/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-resource-menu-token";

test.skipIf(!browserModule)("the split resource menu closes with Escape from its toggle", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-resource-menu-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    const pageErrors: string[] = [];
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_MenuOwner");
    await page.locator("#inRoomName").fill("__Test_MenuRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { roomId: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    const id = randomUUID(), resource = { id, roomID: identity.roomId, name: "notes.txt", mimeType: "text/plain", size: 42, createdAt: Date.now() };
    let deleted = false;
    await page.route(`**/resources/${id}`, (route: any) => {
      if (route.request().method() === "DELETE") { deleted = true; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ resource }) });
    });
    await page.route(`**/resources/${id}/content`, (route: any) => route.fulfill({ status: 200, contentType: "text/plain", body: "notes" }));
    await page.evaluate(async ({ url, roomId, sessionID, id }: any) => {
      const { app } = await import(url);
      await app.api(`/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify({ sessionID, text: `[[resource:${id}]]` }) });
    }, { url: "/assets/chat/state.js", ...identity, id });
    const card = page.locator(`.chat-resource[data-resource-id="${id}"]`);
    await card.getByRole("button", { name: /Download/ }).waitFor();
    const toggle = card.locator(".resource-split-toggle"), menu = card.getByRole("menu");
    await toggle.click();
    await menu.getByRole("menuitem", { name: "Delete file" }).waitFor();
    // Text actions carry a 16px Fluent icon while the labels and control heights stay put.
    const download = card.locator('button[data-i18n="resourceDownload"]');
    const preview = card.locator('button[data-i18n="resourcePreview"]');
    const deleteItem = menu.getByRole("menuitem", { name: "Delete file" });
    for (const control of [download, preview, toggle, deleteItem]) {
      const icon = control.locator("svg.fluent-icon");
      expect(await icon.count()).toBe(1);
      const iconBox = (await icon.boundingBox())!;
      expect(Math.abs(iconBox.width - 16)).toBeLessThanOrEqual(1);
      expect(Math.abs(iconBox.height - 16)).toBeLessThanOrEqual(1);
    }
    for (const control of [download, preview, toggle]) {
      expect(Math.abs((await control.boundingBox())!.height - 35)).toBeLessThanOrEqual(2);
    }
    expect((await deleteItem.boundingBox())!.height).toBeLessThan(46);
    expect(await download.getAttribute("aria-label")).toBe("Download: notes.txt");
    expect(await preview.getAttribute("aria-label")).toBe("Preview: notes.txt");
    expect(await toggle.getAttribute("aria-label")).toBe("More actions for notes.txt");
    expect(await download.textContent()).toContain("Download");
    expect(await preview.textContent()).toContain("Preview");
    expect(await deleteItem.textContent()).toContain("Delete file");
    await toggle.focus();
    expect(await menu.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await menu.isVisible()).toBe(false);
    expect(await toggle.evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
    await toggle.click(); await menu.waitFor({ state: "visible" });
    await page.mouse.click(4, 4);
    expect(await menu.isVisible()).toBe(false);
    await toggle.click();
    await menu.getByRole("menuitem", { name: "Delete file" }).click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    await page.locator("#btnAcceptConfirm").click();
    await card.getByText("File deleted.").waitFor();
    expect(deleted).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
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