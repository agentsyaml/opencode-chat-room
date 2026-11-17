import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-follow-guards-local-token";

test.skipIf(!browserModule)("held pointer and live selection suppress follow-bottom layout writes", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-follow-guards-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Guard tester");
    await page.locator("#inRoomName").fill("__Test_FollowGuards");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    await api(origin, `/rooms/${room.id}/join`, "POST", { sessionID: "guard-peer", participantId: "Guard peer", participantName: "Guard peer" });
    for (let index = 0; index < 24; index++) {
      await api(origin, `/rooms/${room.id}/messages`, "POST", { sessionID: room.sessionID, text: `Guard line ${index} ${"selectable words remain in place ".repeat(4)}` });
    }
    await page.locator("#msgList").getByText("Guard line 23").waitFor({ timeout: 15000 });
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.stopPolling(); clearTimeout(app.state.memberRefreshTimer);
    }, "/assets/chat/state.js");

    const thread = page.locator("#thread");
    const metrics = () => page.evaluate(async (url: string) => {
      const { app } = await import(url), node = document.querySelector<HTMLElement>("#thread")!;
      return {
        top: node.scrollTop, gap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
        follow: app.state.followBottom, pointer: app.state.threadPointerDown, selection: getSelection()?.toString() || "",
      };
    }, "/assets/chat/state.js");
    const nearBottom = async () => {
      const box = (await thread.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 10000); await page.waitForTimeout(800);
      await page.mouse.wheel(0, -70); await page.waitForTimeout(800);
      const state = await metrics();
      expect(state.follow).toBe(true);
      expect(state.pointer).toBe(false);
      expect(state.gap).toBeGreaterThan(2);
    };

    // A held pointer must survive a layout change from staging an attachment.
    await nearBottom();
    const box = (await thread.boundingBox())!;
    await page.mouse.move(box.x + 24, box.y + 24); await page.mouse.down();
    const heldTop = (await metrics()).top;
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_guard_attachment.txt", mimeType: "text/plain", buffer: Buffer.from("guard") });
    await page.locator("#attachmentTray").waitFor({ state: "visible" });
    await page.waitForTimeout(200);
    const held = await metrics();
    expect(held.pointer).toBe(true);
    expect(held.top).toBe(heldTop);
    expect(held.gap).toBeGreaterThan(2);
    await page.mouse.up();
    await page.locator('[data-upload-action="remove"]').click();
    await page.locator("#attachmentTray").waitFor({ state: "hidden" });

    // A live selection must survive an attachment layout change.
    await nearBottom();
    const selectedTarget = await page.evaluate(() => {
      const edge = document.querySelector<HTMLElement>("#thread")!.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>("#msgList [data-msg-id]"))
        .find((row) => row.getBoundingClientRect().bottom > edge.top && row.querySelector(".msg-text")?.textContent?.includes("Guard line"))?.dataset.msgId || "";
    });
    const selectPoints = await page.evaluate((id: string) => {
      const element = document.querySelector<HTMLElement>(`#msgList [data-msg-id="${id}"] .msg-text`)!;
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() as Text, range = document.createRange();
      range.setStart(text, 1); range.setEnd(text, Math.min(24, text.length));
      const rect = range.getBoundingClientRect();
      return { x1: rect.left + 1, y1: rect.top + rect.height / 2, x2: rect.right - 1, y2: rect.bottom - rect.height / 2 };
    }, selectedTarget);
    await page.mouse.move(selectPoints.x1, selectPoints.y1); await page.mouse.down();
    await page.mouse.move(selectPoints.x2, selectPoints.y2, { steps: 12 }); await page.mouse.up();
    const selectionBefore = await metrics();
    expect(selectionBefore.selection.length).toBeGreaterThan(8);
    expect(selectionBefore.gap).toBeGreaterThan(2);
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_guard_selection.txt", mimeType: "text/plain", buffer: Buffer.from("guard") });
    await page.locator("#attachmentTray").waitFor({ state: "visible" });
    await page.waitForTimeout(200);
    const selectionHeld = await metrics();
    expect(selectionHeld.selection).toBe(selectionBefore.selection);
    expect(selectionHeld.top).toBe(selectionBefore.top);
    expect(selectionHeld.gap).toBeGreaterThan(2);
    await page.locator('[data-upload-action="remove"]').click();
    await page.locator("#attachmentTray").waitFor({ state: "hidden" });

    // A live selection must survive a receipt refresh.
    await nearBottom();
    const target = await page.evaluate(() => {
      const edge = document.querySelector<HTMLElement>("#thread")!.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>("#msgList [data-msg-id]"))
        .find((row) => row.getBoundingClientRect().bottom > edge.top && row.querySelector(".msg-text")?.textContent?.includes("Guard line"))?.dataset.msgId || "";
    });
    await page.evaluate((id: string) => {
      const element = document.querySelector<HTMLElement>(`#msgList [data-msg-id="${id}"] .msg-text`)!;
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    }, target);
    const before = await metrics();
    expect(before.selection.length).toBeGreaterThan(8);
    expect(before.follow).toBe(true);
    expect(before.pointer).toBe(false);
    expect(before.gap).toBeGreaterThan(2);

    const membership = (await api(origin, `/rooms/${room.id}/members`)).find((member: any) => member.sessionID === "guard-peer");
    await api(origin, `/rooms/${room.id}/receipts`, "POST", { sessionID: "guard-peer", membershipID: membership.membershipID, messageIDs: [target], evidence: "displayed" });
    await page.evaluate(async ({ url, id }: any) => (await import(url)).app.loadVisibleReceipts(id), { url: "/assets/chat/state.js", id: room.id });
    await page.waitForTimeout(200);
    const after = await metrics();
    expect(after.selection).toBe(before.selection);
    expect(after.gap).toBeGreaterThan(2);
    expect(Math.abs(after.top - before.top)).toBeLessThan(3);
  } finally {
    await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}
async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("No local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}
function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env }; for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local isolated chat server did not start");
}