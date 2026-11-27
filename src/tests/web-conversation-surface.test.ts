/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-conversation-surface-token";

test.skipIf(!browserModule)("the conversation plane keeps balanced gutters and width-aware avatars", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-conversation-surface-"));
  const artifactDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifactDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Surface tester");
    await page.locator("#inRoomName").fill("__Test_ConversationSurface");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.state.room.id, "/assets/chat/state.js");
    const sessionID = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.LS.sessionID, "/assets/chat/state.js");
    await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.stopPolling(), "/assets/chat/state.js");
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: "surface-peer", participantId: "Peer", participantName: "Peer" });
    // Alternate senders and make the thread scrollable, so the scrollbar cannot skew one gutter.
    for (let index = 0; index < 9; index++) {
      await api(origin, `/rooms/${roomId}/messages`, "POST", {
        sessionID: index % 2 ? sessionID : "surface-peer",
        text: `Message ${index} keeps a realistic height by wrapping onto a second line inside the conversation column.`,
      });
    }
    await page.reload();
    await page.locator("#msgList .msg").first().waitFor();
    await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.stopPolling(), "/assets/chat/state.js");
    await page.waitForTimeout(400);

    const desktop = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      const list = document.querySelector<HTMLElement>("#msgList")!;
      const chat = document.querySelector<HTMLElement>("#chatView")!;
      const threadBox = thread.getBoundingClientRect(), listBox = list.getBoundingClientRect();
      const first = list.querySelector<HTMLElement>(".msg:not(.repeat)")!;
      const own = list.querySelector<HTMLElement>(".msg.own:not(.repeat)")!;
      const ownBubble = own.querySelector<HTMLElement>(".msg-text")!;
      const ownReceipt = own.querySelector<HTMLElement>(".message-readers");
      const pseudo = (node: HTMLElement) => {
        const style = getComputedStyle(node, "::before");
        return { display: style.display, content: style.content, width: style.width, height: style.height };
      };
      // The avatar's center is its box top plus half its height, both measured from the row.
      const avatarLine = (node: HTMLElement) => {
        const metaBox = node.querySelector<HTMLElement>(".msg-meta")!.getBoundingClientRect();
        const style = getComputedStyle(node, "::before");
        return {
          avatar: node.getBoundingClientRect().top + parseFloat(style.top) + parseFloat(style.height) / 2,
          meta: metaBox.top + metaBox.height / 2,
        };
      };
      return {
        pageBackground: getComputedStyle(document.body).backgroundColor,
        chatBackground: getComputedStyle(chat).backgroundColor,
        threadBackground: getComputedStyle(thread).backgroundColor,
        leftInset: listBox.left - threadBox.left,
        rightInset: threadBox.right - listBox.right,
        listWidth: listBox.width,
        threadWidth: threadBox.width,
        incomingAvatar: pseudo(first),
        ownAvatar: pseudo(own),
        incomingAvatarLine: avatarLine(first),
        ownAvatarLine: avatarLine(own),
        ownBubbleLeft: ownBubble.getBoundingClientRect().left,
        ownBubbleBottom: ownBubble.getBoundingClientRect().bottom,
        receiptRight: ownReceipt?.getBoundingClientRect().right ?? 0,
        receiptBottom: ownReceipt?.getBoundingClientRect().bottom ?? 0,
        pageOverflowX: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
      };
    });

    expect(desktop.pageOverflowX).toBe(0);
    expect(desktop.threadWidth).toBeGreaterThan(desktop.listWidth);
    // The message plane is its own surface, not the page or the chrome around it.
    expect(channels(desktop.threadBackground)).not.toEqual(channels(desktop.pageBackground));
    expect(colorDistance(desktop.threadBackground, desktop.pageBackground)).toBeGreaterThan(4);
    expect(colorDistance(desktop.threadBackground, desktop.chatBackground)).toBeGreaterThan(4);
    // Equal gutter space, even while the thread scrolls.
    expect(Math.abs(desktop.leftInset - desktop.rightInset)).toBeLessThanOrEqual(12);
    expect(desktop.leftInset).toBeGreaterThan(44);
    // Avatars sit in the gutters; the read receipt stays on the bubble's inner side.
    expect(desktop.incomingAvatar.display).toBe("grid");
    expect(desktop.ownAvatar.display).toBe("grid");
    expect(desktop.incomingAvatar.content).toMatch(/^".+"$/);
    expect(desktop.incomingAvatar.width).toBe(desktop.ownAvatar.width);
    // Avatar center sits on the meta text centerline, not a line below it.
    expect(Math.abs(desktop.incomingAvatarLine.avatar - desktop.incomingAvatarLine.meta)).toBeLessThanOrEqual(1);
    expect(Math.abs(desktop.ownAvatarLine.avatar - desktop.ownAvatarLine.meta)).toBeLessThanOrEqual(1);
    expect(desktop.ownBubbleLeft - desktop.receiptRight).toBeGreaterThanOrEqual(4);
    expect(Math.abs(desktop.receiptBottom - desktop.ownBubbleBottom)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: path.join(artifactDir, "conversation-surface-1920.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(150);
    const dark = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      return {
        pageBackground: getComputedStyle(document.body).backgroundColor,
        chatBackground: getComputedStyle(document.querySelector<HTMLElement>("#chatView")!).backgroundColor,
        threadBackground: getComputedStyle(thread).backgroundColor,
        avatar: getComputedStyle(document.querySelector<HTMLElement>("#msgList .msg:not(.repeat)")!, "::before").display,
      };
    });
    expect(colorDistance(dark.threadBackground, dark.pageBackground)).toBeGreaterThan(4);
    expect(colorDistance(dark.threadBackground, dark.chatBackground)).toBeGreaterThan(4);
    expect(dark.avatar).toBe("grid");
    await page.screenshot({ path: path.join(artifactDir, "conversation-surface-1920-dark.png") });

    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
    const phone = await page.evaluate(() => {
      const first = document.querySelector<HTMLElement>("#msgList .msg:not(.repeat)")!;
      return {
        avatar: getComputedStyle(first, "::before").display,
        pageOverflowX: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        viewportOverflow: document.documentElement.scrollWidth - innerWidth,
        listRight: document.querySelector<HTMLElement>("#msgList")!.getBoundingClientRect().right,
      };
    });
    expect(phone.avatar).toBe("none");
    expect(phone.pageOverflowX).toBe(0);
    expect(phone.viewportOverflow).toBeLessThanOrEqual(0);
    expect(phone.listRight).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(artifactDir, "conversation-surface-390.png") });

    await context.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

// Computed colors serialize as rgb(...) or color(srgb ...); compare channels, not strings.
function channels(value: string): number[] {
  const numbers = value.match(/[\d.]+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  if (value.startsWith("color(srgb")) return numbers.slice(0, 3).map((part) => Math.round(part * 255));
  return numbers.slice(0, 3);
}

function colorDistance(left: string, right: string): number {
  const a = channels(left), b = channels(right);
  return a.reduce((total, channel, index) => total + Math.abs(channel - (b[index] ?? 0)), 0);
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
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