/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-shiki-token";
const TS_SOURCE = "export function answer(value: number): number {\n  return value + 42; // answer\n}\n";
const message = [
  "```ts",
  "const greeting: string = `hello ${name} & friends`;",
  "if (greeting) console.log(greeting, 42); // note",
  "```",
  "",
  "```notalang",
  'plain <tag> & "quoted"',
  "```",
].join("\n");

test.skipIf(!browserModule)("Shiki highlights messages and previews after the lazy bundle loads", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-shiki-"));
  const artifactDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(artifactDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any, roomId = "", sessionID = "";
  const idle = (page: any) => page.evaluate(async (modulePath: string) => (await import(modulePath)).whenShikiIdle(), "/assets/chat/shiki.js");
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(String(error)));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Shiki tester");
    await page.locator("#inRoomName").fill("__Test_Shiki");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      return { roomId: app.state.room.id as string, sessionID: app.LS.sessionID as string };
    }, "/assets/chat/state.js");
    roomId = identity.roomId;
    sessionID = identity.sessionID;
    await page.evaluate(async (modulePath: string) => (await import(modulePath)).app.stopPolling(), "/assets/chat/state.js");
    const resource = await uploadText(origin, roomId, sessionID, "sample.ts", TS_SOURCE);
    await api(origin, `/rooms/${roomId}/messages`, "POST", {
      sessionID, text: `${message}\n\n[[resource:${resource.id}]]`,
    });
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => {
      const { app } = await import(url), updated = await app.api(`/rooms/${encodeURIComponent(id)}`);
      app.state.room.messages = updated.messages;
      app.rerenderMessages();
    }, { url: "/assets/chat/state.js", id: roomId });

    // 1. A fenced TypeScript block keeps its escaped text first, then gains Shiki tokens.
    const blocks = page.locator(".msg-text .code-block");
    await blocks.first().waitFor();
    expect(await blocks.count()).toBe(2);
    const tsCode = blocks.nth(0).locator("pre > code"), unknownCode = blocks.nth(1).locator("pre > code");
    await idle(page);
    expect(await tsCode.evaluate((node: Element) => node.classList.contains("shiki"))).toBe(true);
    expect(await tsCode.locator("span[style*='--shiki-token']").count()).toBeGreaterThan(0);
    expect(await tsCode.evaluate((node: HTMLElement) => node.textContent)).toContain("const greeting: string");
    const toolbarButtons = await blocks.nth(0).locator(".code-toolbar button").count();
    expect(toolbarButtons).toBe(2);

    // 2. Unknown languages stay escaped plain text (no spans, no .shiki).
    expect(await unknownCode.evaluate((node: HTMLElement) => node.textContent)).toBe('plain <tag> & "quoted"\n');
    expect(await unknownCode.locator("span").count()).toBe(0);
    expect(await unknownCode.evaluate((node: Element) => node.classList.contains("shiki"))).toBe(false);

    // 3. Light and dark resolve the same Shiki variables to different computed colors.
    const themed = await page.evaluate(() => {
      const code = document.querySelector<HTMLElement>(".msg-text .code-block code.shiki")!;
      const span = code.querySelector<HTMLElement>('span[style*="--shiki-token"]')!;
      const root = document.documentElement, original = root.dataset.theme;
      const read = (theme: string) => {
        root.dataset.theme = theme;
        return { token: getComputedStyle(span).color, background: getComputedStyle(code.closest("pre")!).backgroundColor };
      };
      const light = read("light"), dark = read("dark");
      root.dataset.theme = original || "system";
      return { light, dark };
    });
    expect(themed.light.token).not.toBe(themed.dark.token);
    expect(themed.light.background).not.toBe(themed.dark.background);

    // 4. Copy still yields the original source after enhancement.
    await page.evaluate(() => {
      (window as any).__copiedCode = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value: string) => { (window as any).__copiedCode = value; } },
      });
    });
    await blocks.nth(0).hover();
    await blocks.nth(0).locator(".code-copy-button").click();
    await page.waitForFunction(() => typeof (window as any).__copiedCode === "string");
    expect(await page.evaluate(() => (window as any).__copiedCode)).toBe(await tsCode.evaluate((node: HTMLElement) => node.textContent));
    await page.screenshot({ path: path.join(artifactDir, "web-shiki-message.png") });

    // 5. Text preview uses the same enhancer and keeps the language label and copy.
    const card = page.locator(`.chat-resource[data-resource-id="${resource.id}"]`);
    const previewButton = card.getByRole("button", { name: "Preview: sample.ts" });
    await previewButton.waitFor();
    await previewButton.click();
    await page.locator("#docPreview").waitFor({ state: "visible" });
    const previewCode = page.locator("#docPreviewBody .doc-code code.language-typescript.shiki");
    await previewCode.waitFor();
    expect(await page.locator("#docPreviewLanguage").textContent()).toBe("TypeScript");
    expect(await previewCode.locator("span[style*='--shiki-token']").count()).toBeGreaterThan(0);
    expect(await previewCode.evaluate((node: HTMLElement) => node.textContent)).toBe(TS_SOURCE);
    expect(await previewCode.evaluate((node: Element) => getComputedStyle(node).userSelect)).not.toBe("none");
    const beforeCopy = await page.evaluate(() => (window as any).__copiedCode);
    await page.locator("#btnDocPreviewCopy").click();
    await page.waitForFunction((previous: string) => (window as any).__copiedCode !== previous, beforeCopy);
    expect(await page.evaluate(() => (window as any).__copiedCode)).toBe(TS_SOURCE);
    await page.screenshot({ path: path.join(artifactDir, "web-shiki-preview.png") });
    await page.locator("#btnCloseDocPreview").click();
    await page.locator("#docPreview").waitFor({ state: "hidden" });
    expect(pageErrors).toEqual([]);
    await context.close();

    // 6. A failed bundle request leaves the plain code readable, copyable, and error-free.
    const abortedContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const aborted = await abortedContext.newPage();
    aborted.setDefaultTimeout(15000);
    const abortedErrors: string[] = [];
    aborted.on("pageerror", (error: Error) => abortedErrors.push(String(error)));
    await aborted.route("**/assets/shiki.bundle.js", (route: any) => route.abort());
    await aborted.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await aborted.goto(`${origin}/chat`);
    await aborted.locator("#inName").fill("Shiki offline");
    await aborted.locator("#inRoomId").fill(roomId);
    await aborted.locator("#btnJoin").click();
    await aborted.locator("#chatView").waitFor({ state: "visible" });
    const abortedCode = aborted.locator(".msg-text .code-block").first().locator("pre > code");
    await abortedCode.waitFor();
    expect(await abortedCode.evaluate((node: HTMLElement) => node.textContent)).toContain("const greeting: string");
    await idle(aborted);
    expect(await aborted.locator(".msg-text code.shiki").count()).toBe(0);
    expect(await abortedCode.locator("span").count()).toBe(0);
    await aborted.evaluate(() => {
      (window as any).__copiedCode = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value: string) => { (window as any).__copiedCode = value; } },
      });
    });
    await aborted.locator(".msg-text .code-block").first().hover();
    await aborted.locator(".msg-text .code-block").first().locator(".code-copy-button").click();
    await aborted.waitForFunction(() => typeof (window as any).__copiedCode === "string");
    expect(await aborted.evaluate(() => (window as any).__copiedCode)).toContain("const greeting: string");
    expect(abortedErrors).toEqual([]);
    await abortedContext.close();
  } finally {
    if (roomId && sessionID) await fetch(`${origin}/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionID }),
    }).catch(() => {});
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function uploadText(origin: string, roomId: string, sessionID: string, name: string, content: string) {
  const response = await fetch(`${origin}/rooms/${encodeURIComponent(roomId)}/resources`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Session-ID": sessionID, "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" },
    body: content,
  });
  expect(response.status).toBe(201);
  return (await response.json()).resource as { id: string };
}

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