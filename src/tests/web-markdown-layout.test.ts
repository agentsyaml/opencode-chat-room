/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-markdown-layout-token";
const longToken = "averylongunbrokenwordthatmustwrapinsidethebubblewithoutwideningthepage";
const longLine = `const veryLongLine = "${"segment-".repeat(16)}end";`;
const reminderText = "Standup reminder: review the renderer rhythm, the table scroll frame, and the event-row hierarchy before the release window closes.";
const CONTENT = [
  "# Release review",
  "",
  `A long [reference page](https://example.invalid/docs/reference/components/markdown/rendering/very-long-path) and a long token ${longToken}.`,
  "",
  "> Quoted guidance with **emphasis** and `inline code`.",
  "",
  "## Checklist",
  "",
  "- [x] headings",
  "- [ ] tables",
  "  - nested list item",
  "",
  "### Table",
  "",
  "| MarkdownRenderingComponent | RequestedVisualBehavior | VerificationSurface | DesktopReadingWidth | MobileReadingWidth | NotesForReviewers |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Headings | Clear hierarchy | Browser test | 1440 | 390 | Checked |",
  "| Tables | Scroll inside frame | Browser test | 1440 | 390 | Checked |",
  "",
  "```ts",
  longLine,
  "export function render(value: string) { return value; }",
  "```",
].join("\n");

test.skipIf(!browserModule)("markdown rhythm and room notices hold at desktop and phone widths", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-markdown-layout-"));
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(String(error)));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Markdown tester");
    await page.locator("#inRoomName").fill("__Test_MarkdownLayout");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.state.room.id, "/assets/chat/state.js");
    const sessionID = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.LS.sessionID, "/assets/chat/state.js");
    await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.stopPolling(), "/assets/chat/state.js");
    await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID, text: CONTENT });
    await api(origin, `/rooms/${roomId}/join`, "POST", {
      sessionID: "markdown-peer-session", participantId: "MarkdownPeer", participantName: "MarkdownPeer",
    });
    await page.evaluate(async ({ url, id, text }: { url: string; id: string; text: string }) => {
      const { app } = await import(url), updated = await app.api(`/rooms/${encodeURIComponent(id)}`);
      const createdAt = (updated.messages.at(-1)?.createdAt ?? Date.now()) + 1;
      updated.messages.push({ id: "reminder:layout-test", roomId: id, senderId: "system", text, createdAt });
      app.state.room = updated;
      app.rerenderMessages();
    }, { url: "/assets/chat/state.js", id: roomId, text: reminderText });

    const message = page.locator("#msgList .msg-text").last();
    await message.locator("h1").waitFor();
    await message.locator(".markdown-table").waitFor();
    await page.evaluate(async (modulePath: string) => (await import(modulePath)).whenShikiIdle(), "/assets/chat/shiki.js");

    const typography = await message.evaluate((root: HTMLElement) => {
      const size = (selector: string) => parseFloat(getComputedStyle(root.querySelector(selector)!).fontSize);
      const quote = root.querySelector("blockquote")!;
      const code = root.querySelector(":not(pre) > code")!;
      const list = root.querySelector("ul")!;
      return {
        h1: size("h1"), h2: size("h2"), paragraph: size("p"),
        h1Margin: parseFloat(getComputedStyle(root.querySelector("h1")!).marginTop),
        quoteBorder: getComputedStyle(quote).borderLeftWidth,
        quoteBackground: getComputedStyle(quote).backgroundColor,
        inlineCodeBackground: getComputedStyle(code).backgroundColor,
        inlineCodeFamily: getComputedStyle(code).fontFamily,
        listPadding: parseFloat(getComputedStyle(list).paddingLeft),
      };
    });
    expect(typography.h1).toBeGreaterThan(typography.h2);
    expect(typography.h2).toBeGreaterThan(typography.paragraph);
    expect(typography.h1Margin).toBe(0);
    expect(typography.quoteBorder).toBe("3px");
    expect(typography.quoteBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(typography.inlineCodeBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(typography.inlineCodeFamily.toLowerCase()).toContain("mono");
    expect(typography.listPadding).toBeGreaterThan(20);

    const table = message.locator(".markdown-table");
    const tableBox = await table.evaluate((node: HTMLElement) => ({
      overflowX: getComputedStyle(node).overflowX,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(tableBox.overflowX).toBe("auto");
    expect(tableBox.scrollWidth).toBeGreaterThan(tableBox.clientWidth + 10);

    const block = message.locator(".code-block").first();
    expect((await block.locator(".code-language").textContent())?.trim()).toBe("ts");
    expect(await block.locator(".code-toolbar").evaluate((node: Element) => getComputedStyle(node).opacity)).toBe("1");
    expect(await block.locator(".code-toolbar button").count()).toBe(2);
    const codeScroll = await block.locator("pre").evaluate((node: HTMLElement) => ({
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
    }));
    expect(codeScroll.scrollWidth).toBeGreaterThan(codeScroll.clientWidth + 10);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).__copiedMarkdownCode = value; } } });
    });
    await block.locator(".code-copy-button").click();
    await page.waitForFunction(() => typeof (window as any).__copiedMarkdownCode === "string");
    expect(await page.evaluate(() => (window as any).__copiedMarkdownCode)).toContain("veryLongLine");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    const join = page.locator('#msgList li.sys[data-kind="join"]').last();
    await join.waitFor();
    const joinEvent = await join.evaluate((row: HTMLElement) => {
      const event = row.querySelector<HTMLElement>(".sys-event")!;
      const time = row.querySelector<HTMLTimeElement>(".sys-time")!;
      return {
        role: event.getAttribute("role"),
        background: getComputedStyle(event).backgroundColor,
        border: getComputedStyle(event).borderTopColor,
        iconHidden: event.querySelector("svg")?.getAttribute("aria-hidden"),
        iconWidth: event.querySelector("svg")?.getBoundingClientRect().width || 0,
        text: event.querySelector(".sys-text")?.textContent,
        time: time.textContent,
        dateTime: time.dateTime,
        fits: event.getBoundingClientRect().right <= innerWidth + 1 && event.getBoundingClientRect().left >= -1,
      };
    });
    expect(joinEvent.role).toBe("note");
    expect(joinEvent.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(joinEvent.border).not.toBe("rgba(0, 0, 0, 0)");
    expect(joinEvent.iconHidden).toBe("true");
    expect(joinEvent.iconWidth).toBeGreaterThan(6);
    expect(joinEvent.text).toBe("MarkdownPeer joined the room");
    expect(joinEvent.time).toBeTruthy();
    expect(joinEvent.dateTime).toBeTruthy();
    expect(joinEvent.fits).toBe(true);

    const reminder = page.locator('#msgList li.sys[data-kind="reminder"]').last();
    await reminder.waitFor();
    const reminderEvent = await reminder.evaluate((row: HTMLElement) => {
      const event = row.querySelector<HTMLElement>(".sys-event")!;
      const box = event.getBoundingClientRect();
      return {
        text: event.querySelector(".sys-text")?.textContent,
        height: box.height,
        fits: box.right <= innerWidth + 1 && box.left >= -1,
        wraps: (event.querySelector(".sys-text") as HTMLElement).scrollWidth <= (event.querySelector(".sys-text") as HTMLElement).clientWidth + 1,
      };
    });
    expect(reminderEvent.text).toBe(reminderText);
    expect(reminderEvent.height).toBeGreaterThan(30);
    expect(reminderEvent.fits).toBe(true);
    expect(reminderEvent.wraps).toBe(true);
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.cancelThreadScrollAnimation?.();
      document.querySelector<HTMLElement>("#thread")!.scrollTop = 0;
    }, "/assets/chat/state.js");
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(artifactDir, "markdown-layout-desktop-1440.png") });
    await message.screenshot({ path: path.join(artifactDir, "markdown-message-desktop.png") });
    await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!; thread.scrollTop = thread.scrollHeight; });
    await page.screenshot({ path: path.join(artifactDir, "markdown-layout-desktop-events.png") });

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    const mobileErrors: string[] = [];
    mobile.on("pageerror", (error: Error) => mobileErrors.push(String(error)));
    await mobile.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await mobile.goto(`${origin}/chat`);
    await mobile.locator("#inName").fill("Phone reader");
    await mobile.locator("#inRoomId").fill(roomId);
    await mobile.locator("#btnJoin").click();
    await mobile.locator("#chatView").waitFor({ state: "visible" });
    const mobileMessage = mobile.locator("#msgList .msg-text").first();
    await mobileMessage.locator("h1").waitFor();
    await mobileMessage.locator(".markdown-table").waitFor();
    await mobileMessage.scrollIntoViewIfNeeded();
    const mobileLayout = await mobile.evaluate(() => {
      const table = document.querySelector<HTMLElement>("#msgList .markdown-table")!;
      const block = document.querySelector<HTMLElement>("#msgList .code-block")!;
      const event = document.querySelector<HTMLElement>("#msgList .sys-event")!;
      return {
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        tableScrolls: table.scrollWidth > table.clientWidth + 10,
        headerVisible: getComputedStyle(block.querySelector<HTMLElement>(".code-toolbar")!).opacity === "1",
        language: block.querySelector(".code-language")?.textContent,
        eventFits: event.getBoundingClientRect().right <= innerWidth + 1,
        eventText: event.querySelector(".sys-text")?.textContent,
      };
    });
    expect(mobileLayout.pageOverflow).toBe(false);
    expect(mobileLayout.tableScrolls).toBe(true);
    expect(mobileLayout.headerVisible).toBe(true);
    expect(mobileLayout.language).toBe("ts");
    expect(mobileLayout.eventFits).toBe(true);
    expect(mobileLayout.eventText).toBe("MarkdownPeer joined the room");
    await mobileMessage.screenshot({ path: path.join(artifactDir, "markdown-message-mobile.png") });
    await mobile.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!; thread.scrollTop = thread.scrollHeight; });
    await mobile.screenshot({ path: path.join(artifactDir, "markdown-layout-mobile-events.png") });
    expect(mobileErrors).toEqual([]);
    await mobileContext.close();

    expect(pageErrors).toEqual([]);
    await context.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

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
    ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"),
    XDG_CONFIG_HOME: path.join(stateDir, "config"), CHAT_ROOM_STATE_DIR: stateDir,
    CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token,
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