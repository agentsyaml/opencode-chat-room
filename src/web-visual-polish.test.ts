/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-visual-polish-test-token";

test.skipIf(!browserModule)("chat visual geometry stays composed across locale, theme, and width", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-visual-polish-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR;
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const page = await context.newPage();
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_VisualOwner");
    await page.locator("#inRoomName").fill("__Test_VisualPolish");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#msgInput").fill("__Test_visual_note\nReadable conversation, thoughtfully spaced.");
    await page.locator("#btnSend").click(); await page.locator("#msgList").getByText("__Test_visual_note").waitFor();
    await page.reload(); await page.locator("#msgList .msg").waitFor();
    const baseline = await page.evaluate(() => ({ pageY: document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight, threadGap: document.querySelector<HTMLElement>("#thread")!.scrollHeight - document.querySelector<HTMLElement>("#thread")!.clientHeight - document.querySelector<HTMLElement>("#thread")!.scrollTop, composer: document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect().bottom }));
    expect(baseline.pageY).toBe(0);
    const input = page.locator("#msgInput"); await input.fill("First line\nSecond line\nThird line\nFourth line\nFifth line");
    const multiline = await page.evaluate(() => ({ height: document.querySelector<HTMLElement>("#msgInput")!.getBoundingClientRect().height, composer: document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect().bottom, viewport: innerHeight, pageY: document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight }));
    expect(multiline.height).toBeGreaterThan(70); expect(multiline.composer).toBeLessThanOrEqual(multiline.viewport); expect(multiline.pageY).toBe(0);
    await input.fill("");
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_visual_attachment.txt", mimeType: "text/plain", buffer: Buffer.from("A staged file preview.") });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    await input.evaluate((node: HTMLTextAreaElement) => node.blur());
    const samples: unknown[] = [], sizes: Array<[number, number]> = [[188, 406], [250, 541], [300, 650], [320, 720], [375, 812], [390, 844], [768, 900], [1440, 900]];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        for (const locale of ["en", "zh-CN"] as const) {
          await page.evaluate(async (args: { url: string; locale: string }) => (await import(args.url)).app.setLocale(args.locale), { url: "/assets/chat/state.js", locale });
          const metrics = await page.evaluate(() => {
            const rect = (selector: string) => { const { x, y, width, height, bottom } = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect(); return { x, y, width, height, bottom }; };
            const root = document.scrollingElement!;
            const thread = document.querySelector<HTMLElement>("#thread")!;
            const headerControls = ["#btnRoomsDrawer", "#btnQuestions", "#btnAnnouncements", "#btnMembers", "#btnRoomOptions"].map((selector) => {
              const button = document.querySelector<HTMLElement>(selector)!;
              const icon = button.querySelector<SVGElement>("svg.action-icon")!;
              const iconBox = icon.getBoundingClientRect();
              const buttonBox = button.getBoundingClientRect();
              return { display: getComputedStyle(button).display, iconDisplay: getComputedStyle(icon).display, x: buttonBox.x, right: buttonBox.right, width: buttonBox.width, height: buttonBox.height, iconWidth: iconBox.width, iconHeight: iconBox.height, icons: button.querySelectorAll("svg.action-icon").length, fill: getComputedStyle(icon).fill, stroke: getComputedStyle(icon).stroke };
            });
            return {
              viewport: [innerWidth, innerHeight], page: [root.scrollWidth - root.clientWidth, root.scrollHeight - root.clientHeight], chat: rect("#chatView"),
              header: rect(".chat-head"), headerParts: Array.from(document.querySelectorAll(".chat-head-main, .chat-head-actions")).map((node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }),
              headerControls, thread: rect("#thread"), threadBottomGap: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
              composer: rect(".composer"), attachmentTray: rect("#attachmentTray"), rail: getComputedStyle(document.querySelector(".room-rail")!).display,
              attachmentActions: Array.from(document.querySelectorAll("#attachmentList button")).map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height, label: button.textContent?.trim() })),
              attachmentState: document.querySelector("#attachmentList .attachment-detail")?.textContent?.trim(),
            };
          });
          expect(metrics.page[0]).toBe(0);
          expect(metrics.page[1]).toBe(0);
          expect(metrics.chat.width).toBeLessThanOrEqual(width);
          expect(metrics.headerParts[1].right).toBeLessThanOrEqual(metrics.header.x + metrics.header.width);
          expect(metrics.headerParts[0].left).toBeGreaterThanOrEqual(metrics.header.x);
          expect(metrics.headerParts[0].right).toBeLessThanOrEqual(metrics.headerParts[1].left);
          if (width <= 760) expect(metrics.headerControls[0].right).toBeLessThanOrEqual(metrics.headerParts[1].left);
          expect(metrics.headerControls.every((control: any) => control.icons === 1)).toBe(true);
          expect(metrics.headerControls.every((control: any) => control.fill === "none" && control.stroke !== "none")).toBe(true);
          expect(metrics.headerControls.every((control: any) => control.iconDisplay === (width <= 900 ? "block" : "none"))).toBe(true);
          const visibleIcons = metrics.headerControls.filter((control: any) => control.iconWidth > 0 && control.iconHeight > 0);
          expect(visibleIcons.length).toBe(width <= 760 ? 5 : width <= 900 ? 4 : 0);
          expect(visibleIcons.every((control: any) => control.fill === "none" && control.stroke !== "none")).toBe(true);
          const visibleControls = metrics.headerControls.filter((control: any) => control.display !== "none");
          if (width <= 900) expect(visibleControls.every((control: any) => control.iconDisplay === "block" && control.iconWidth > 0 && control.iconHeight > 0)).toBe(true);
          if (width <= 760) {
            const target = width <= 220 ? 28 : width <= 300 ? 36 : 44;
            expect(visibleControls.every((control: any) => control.width >= target && control.height >= target)).toBe(true);
          }
          else if (width <= 900) expect(visibleControls.every((control: any) => control.width >= 38 && control.height >= 38)).toBe(true);
          if (height > 450) expect(metrics.composer.bottom).toBeLessThanOrEqual(height);
          expect(metrics.attachmentTray.bottom).toBeLessThanOrEqual(metrics.composer.bottom);
          expect(metrics.attachmentActions.every((button: any) => button.width >= 44 && button.height >= 44)).toBe(true);
          expect(metrics.attachmentActions.some((button: any) => button.label === (locale === "en" ? "Remove" : "移除"))).toBe(true);
          expect(metrics.attachmentState?.endsWith(locale === "en" ? "Ready to send" : "可以发送")).toBe(true);
          if (width <= 760) expect(metrics.rail).toBe("none");
          samples.push({ width, theme, locale, ...metrics });
          if (screenshotDir && ((width === 320 && theme === "light" && locale === "en") || (width === 375 && theme === "light" && locale === "zh-CN") || (width === 390 && theme === "dark" && locale === "en") || (width === 768 && theme === "dark" && locale === "zh-CN") || (width === 1440 && theme === "light" && locale === "en") || (width === 1440 && theme === "dark" && locale === "zh-CN"))) {
            await page.waitForTimeout(60); await page.screenshot({ path: path.join(screenshotDir, `visual-polish-${width}-${theme}-${locale}.png`) });
          }
        }
      }
    }
    await page.setViewportSize({ width: 375, height: 812 }); await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    await page.locator("#btnRoomsDrawer").click(); await page.locator("#roomRail.drawer-open").waitFor();
    await page.locator("#btnSettings").click(); await page.locator("#localeSelectSettings").waitFor({ state: "visible" });
    const profile = await page.evaluate(() => { const rail = document.querySelector<HTMLElement>("#roomRail")!, foot = document.querySelector<HTMLElement>(".rail-foot")!, panel = document.querySelector<HTMLElement>("#chatSettings")!, root = document.scrollingElement!; return { railBottom: rail.getBoundingClientRect().bottom, footBottom: foot.getBoundingClientRect().bottom, viewport: innerHeight, panelX: panel.scrollWidth - panel.clientWidth, pageX: root.scrollWidth - root.clientWidth, pageY: root.scrollHeight - root.clientHeight }; });
    expect(profile.railBottom).toBe(profile.viewport); expect(profile.viewport - profile.footBottom).toBeLessThanOrEqual(20); expect(profile.panelX).toBe(0); expect(profile.pageX).toBe(0); expect(profile.pageY).toBe(0);
    await page.waitForTimeout(220);
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "visual-polish-mobile-profile.png") });
    if (screenshotDir) await writeFile(path.join(screenshotDir, "visual-polish-metrics.json"), JSON.stringify({ baseline, multiline, profile, samples }, null, 2));
    await context.close();
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

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
