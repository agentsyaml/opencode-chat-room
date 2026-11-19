/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-code-block-token";
const longLine = `const url = "https://example.invalid/${"segment-".repeat(22)}end";`;
const message = [
  "Code sample:",
  "",
  "```js",
  "// greeting",
  'const greet = "<hello> & \'world\'";',
  "if (greet) { console.log(greet, 42); }",
  longLine,
  "```",
  "",
  "```notalang",
  'plain <tag> & "quoted"',
  "```",
].join("\n");
const expectedJS = ["// greeting", 'const greet = "<hello> & \'world\'";', "if (greet) { console.log(greet, 42); }", longLine].join("\n");
const expectedPlain = 'plain <tag> & "quoted"';

test.skipIf(!browserModule)("code blocks highlight, wrap, and copy without native controls", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-code-block-"));
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    const pageErrors: string[] = [], nativeDialogs: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(String(error)));
    page.on("dialog", (dialog: any) => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Code tester");
    await page.locator("#inRoomName").fill("__Test_CodeBlock");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.state.room.id, "/assets/chat/state.js");
    await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.stopPolling(), "/assets/chat/state.js");
    await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: await sessionID(page), text: message });
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => {
      const { app } = await import(url), updated = await app.api(`/rooms/${encodeURIComponent(id)}`);
      app.state.room.messages = updated.messages;
      app.rerenderMessages();
    }, { url: "/assets/chat/state.js", id: roomId });
    const blocks = page.locator(".msg-text .code-block");
    await blocks.first().waitFor();
    expect(await blocks.count()).toBe(2);

    const first = blocks.nth(0), second = blocks.nth(1);
    const firstCode = first.locator("pre > code"), secondCode = second.locator("pre > code");
    const firstText = await firstCode.evaluate((node: HTMLElement) => node.textContent!);
    const secondText = await secondCode.evaluate((node: HTMLElement) => node.textContent!);
    expect(firstText.replace(/\n$/, "")).toBe(expectedJS);
    expect(secondText.replace(/\n$/, "")).toBe(expectedPlain);
    expect(await firstCode.evaluate((node: Element) => node.classList.contains("hljs"))).toBe(true);
    expect(await firstCode.locator("span.hljs-keyword").count()).toBeGreaterThan(0);
    expect(await secondCode.locator("span").count()).toBe(0);

    const contrast = await first.evaluate((block: Element) => {
      const parse = (value: string) => {
        const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        return (value.startsWith("color(") ? numbers.slice(0, 3).map((channel) => channel * 255) : numbers.slice(0, 3));
      };
      const luminance = (color: number[]) => color.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
      const root = document.documentElement, pre = block.querySelector("pre")!, original = root.dataset.theme;
      const ratios: Record<string, number> = {};
      for (const theme of ["light", "dark", "forest", "sand"]) {
        root.dataset.theme = theme;
        const background = luminance(parse(getComputedStyle(pre).backgroundColor));
        for (const token of [".hljs-keyword", ".hljs-string", ".hljs-number", ".hljs-comment"]) {
          const node = block.querySelector(token);
          if (!node) continue;
          const foreground = luminance(parse(getComputedStyle(node).color));
          ratios[`${theme} ${token}`] = (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
        }
      }
      root.dataset.theme = original;
      return ratios;
    });
    expect(Object.keys(contrast)).toHaveLength(16);
    expect(Object.entries(contrast).filter(([, ratio]) => Number(ratio) < 4.5)).toEqual([]);

    const toolbar = first.locator(".code-toolbar");
    expect(await toolbar.locator("button").count()).toBe(2);
    const iconOnly = await toolbar.locator("button").evaluateAll((buttons: Element[]) => buttons.map((button) => ({
      text: button.textContent?.trim(), icon: Boolean(button.querySelector("svg")),
      label: button.getAttribute("aria-label"), title: button.getAttribute("title"),
    })));
    expect(iconOnly).toHaveLength(2);
    for (const button of iconOnly) {
      expect(button.text).toBe("");
      expect(button.icon).toBe(true);
      expect(button.label).toBeTruthy();
      expect(button.title).toBeTruthy();
    }
    expect(iconOnly[0].label).toBe("Wrap code");
    expect(iconOnly[0].title).toBe("Wrap code");
    expect(iconOnly[1].label).toBe("Copy");
    expect(await toolbar.evaluate((node: Element) => getComputedStyle(node).opacity)).toBe("0");
    await first.locator(".code-wrap-toggle").focus();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".code-toolbar")!).opacity === "1");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".code-toolbar")!).opacity === "0");
    await first.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".code-toolbar")!).opacity === "1");
    await page.screenshot({ path: path.join(artifactDir, "code-block-desktop.png") });

    const wrap = first.locator(".code-wrap-toggle");
    const whiteSpace = () => firstCode.evaluate((node: Element) => getComputedStyle(node).whiteSpace);
    const overflowWrap = () => firstCode.evaluate((node: Element) => getComputedStyle(node).overflowWrap);
    expect(await whiteSpace()).toBe("pre");
    const pre = first.locator("pre");
    await pre.evaluate((node: HTMLElement) => { node.scrollLeft = 40; });
    await wrap.click();
    expect(await wrap.getAttribute("aria-pressed")).toBe("true");
    expect(await whiteSpace()).toBe("pre-wrap");
    expect(await overflowWrap()).toBe("anywhere");
    await wrap.click();
    expect(await wrap.getAttribute("aria-pressed")).toBe("false");
    expect(await whiteSpace()).toBe("pre");
    expect(await pre.evaluate((node: HTMLElement) => node.scrollLeft)).toBe(40);

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).__copiedCode = value; } } });
    });
    const copy = first.locator(".code-copy-button");
    await copy.click();
    await page.waitForFunction(() => typeof (window as any).__copiedCode === "string");
    expect(await page.evaluate(() => (window as any).__copiedCode)).toBe(firstText);
    expect(await copy.getAttribute("aria-label")).toBe("Copied");
    expect(await copy.evaluate((node: Element) => node.classList.contains("is-copied"))).toBe(true);
    expect(await copy.locator(".code-check-icon").isVisible()).toBe(true);
    expect(nativeDialogs).toEqual([]);

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    const mobileErrors: string[] = [];
    mobile.on("pageerror", (error: Error) => mobileErrors.push(String(error)));
    await mobile.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await mobile.goto(`${origin}/chat`);
    await mobile.locator("#inName").fill("Mobile tester");
    await mobile.locator("#inRoomId").fill(roomId);
    await mobile.locator("#btnJoin").click();
    await mobile.locator("#chatView").waitFor({ state: "visible" });
    const mobileBlock = mobile.locator(".msg-text .code-block").first();
    await mobileBlock.waitFor();
    await mobileBlock.scrollIntoViewIfNeeded();
    await mobile.waitForTimeout(400);
    expect(await mobileBlock.locator(".code-toolbar").evaluate((node: Element) => getComputedStyle(node).opacity)).toBe("1");
    await mobile.screenshot({ path: path.join(artifactDir, "code-block-mobile.png") });
    await mobileContext.close();
    expect(mobileErrors).toEqual([]);

    expect(pageErrors).toEqual([]);
    await context.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function sessionID(page: any) {
  return page.evaluate(async (modulePath: string) => (await import(modulePath)).app.LS.sessionID, "/assets/chat/state.js");
}

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), XDG_CONFIG_HOME: path.join(stateDir, "config"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
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