/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-doc-preview-token";

const REPORT = [
  "# Quarterly Report",
  "",
  "Opening paragraph with a [portal link](https://example.invalid/portal).",
  "",
  "<script>window.__docXss = 1</script>",
  "",
  '<custom:widget data-id="7">kept text</custom:widget>',
  "",
  '<img src="missing-image.png" alt="diagram" onerror="window.__docXss = 2">',
  "",
  "## Numbers",
  "",
  "| Metric | Value |",
  "| --- | --- |",
  "| Revenue | 42 |",
  "",
  "```js",
  "const total = 42;",
  "```",
  "",
  "- First item",
  "- Second item",
].join("\n");

test.skipIf(!browserModule)("markdown resources preview in a right pane and a mobile overlay", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-doc-preview-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || dir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(dir, port), stdio: "ignore" });
  let browser: any, roomID = "", sessionID = "";
  const pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: "light", acceptDownloads: true });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_DocOwner");
    await page.locator("#inRoomName").fill("__Test_DocPreview");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { roomID: app.state.room.id as string, sessionID: app.LS.sessionID as string };
    }, "/assets/chat/state.js");
    roomID = identity.roomID; sessionID = identity.sessionID;
    const resource = await uploadMarkdown(origin, roomID, sessionID, "REPORT.md", REPORT);
    await page.evaluate(async ({ url, id, sessionID, text }: any) => {
      const { app } = await import(url);
      await app.api(`/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ sessionID, text }) });
    }, { url: "/assets/chat/state.js", id: roomID, sessionID, text: `[[resource:${resource.id}]]` });

    const dialog = page.locator("#docPreview");
    const card = page.locator(`.chat-resource[data-resource-id="${resource.id}"]`);
    await card.getByText("REPORT.md").waitFor();
    const previewButton = card.getByRole("button", { name: "Preview: REPORT.md" });
    await previewButton.waitFor();
    expect(await card.getByRole("button", { name: /Download/ }).count()).toBe(1);
    // Markdown never previews inline the way media does.
    expect(await card.locator("img, audio, video").count()).toBe(0);

    const closedWidth = await page.locator("#msgScroll").evaluate((node: HTMLElement) => node.getBoundingClientRect().width);
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    await page.locator("#docPreviewBody h1").getByText("Quarterly Report").waitFor();
    expect(await page.locator("#docPreviewTitle").textContent()).toBe("REPORT.md");
    expect(await page.locator("#docPreviewSize").textContent()).toMatch(/\d/);
    const openWidth = await page.locator("#msgScroll").evaluate((node: HTMLElement) => node.getBoundingClientRect().width);
    expect(openWidth).toBeLessThan(closedWidth - 300);
    const wide = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("#chatView")!;
      const pane = document.querySelector<HTMLElement>("#docPreview")!;
      const viewBox = view.getBoundingClientRect(), paneBox = pane.getBoundingClientRect();
      return {
        hasDoc: view.classList.contains("has-doc"),
        columns: getComputedStyle(view).gridTemplateColumns.split(" ").length,
        position: getComputedStyle(pane).position,
        paneLeft: paneBox.left, paneRight: paneBox.right, paneWidth: paneBox.width,
        viewRight: viewBox.right,
      };
    });
    expect(wide.hasDoc).toBe(true);
    expect(wide.columns).toBe(4);
    expect(wide.position).toBe("relative");
    expect(wide.paneWidth).toBeGreaterThanOrEqual(379);
    expect(wide.paneWidth).toBeLessThanOrEqual(461);
    expect(Math.abs(wide.paneRight - wide.viewRight)).toBeLessThanOrEqual(2);
    expect(wide.paneLeft).toBeGreaterThan(openWidth);

    // The preview header copies the raw Markdown, not the rendered document.
    await page.evaluate(() => {
      (window as any).__copies = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).__copies.push(value); } } });
    });
    const docCopy = page.locator("#btnDocPreviewCopy");
    await docCopy.waitFor({ state: "visible" });
    await docCopy.click();
    await page.waitForFunction((source: string) => (window as any).__copies[0] === source, REPORT);
    expect(await docCopy.getAttribute("aria-label")).toBe("Copied");
    // The message card copies the same raw source.
    await card.locator(".resource-copy").click();
    await page.waitForFunction((source: string) => (window as any).__copies[1] === source, REPORT);

    // At the narrowest pane breakpoint the chat still has a usable column.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(100);
    const minimum = await page.evaluate(() => ({
      pageOverflow: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
      position: getComputedStyle(document.querySelector("#docPreview")!).position,
      paneWidth: document.querySelector("#docPreview")!.getBoundingClientRect().width,
      chatWidth: document.querySelector("#msgScroll")!.getBoundingClientRect().width,
    }));
    expect(minimum.pageOverflow).toBe(0);
    expect(minimum.position).toBe("relative");
    expect(minimum.paneWidth).toBeGreaterThanOrEqual(379);
    expect(minimum.chatWidth).toBeGreaterThanOrEqual(380);
    await page.setViewportSize({ width: 1280, height: 850 });

    // Rendered Markdown is sanitized: no scripts, event handlers, or unsafe link targets.
    const safe = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>("#docPreviewBody")!;
      const link = body.querySelector("a");
      return {
        scripts: body.querySelectorAll("script").length,
        handlers: body.querySelectorAll("[onclick], [onerror], [onload]").length,
        xss: (window as any).__docXss,
        target: link?.getAttribute("target"),
        rel: link?.getAttribute("rel"),
        tables: body.querySelectorAll("table").length,
        codeBlocks: body.querySelectorAll(".code-block pre code").length,
        images: body.querySelectorAll("img").length,
        customTag: body.textContent?.includes('<custom:widget data-id="7">kept text</custom:widget>') || false,
      };
    });
    expect(safe.scripts).toBe(0);
    expect(safe.handlers).toBe(0);
    expect(safe.xss).toBeUndefined();
    expect(safe.target).toBe("_blank");
    expect(safe.rel).toContain("noopener");
    expect(safe.tables).toBe(1);
    expect(safe.codeBlocks).toBe(1);
    expect(safe.images).toBe(1);
    expect(safe.customTag).toBe(true);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "web-doc-preview-wide-1280.png") });

    // Download stays available from the pane.
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#btnDocPreviewDownload").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("REPORT.md");
    expect(await page.locator("#btnDocPreviewDownload").isEnabled()).toBe(true);

    // Esc closes the pane and returns focus to the button that opened it.
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview: REPORT.md");
    await page.waitForFunction(() => !document.querySelector("#chatView")!.classList.contains("has-doc"));

    // The Files browser opens the same pane from a Markdown row.
    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnFiles").click();
    await page.locator("#filesDialog[open]").waitFor();
    const row = page.locator("#fileList .file-row").filter({ hasText: "REPORT.md" });
    await row.waitFor();
    expect(await row.locator('[data-file-action="preview"]').count()).toBe(1);
    expect(await row.locator('[data-file-action="download"]').count()).toBe(1);
    expect(await row.locator('[data-file-action="copy"]').count()).toBe(1);
    await row.locator('[data-file-action="copy"]').click();
    await page.waitForFunction((source: string) => (window as any).__copies[2] === source, REPORT);
    await row.locator('[data-file-action="preview"]').click();
    await dialog.waitFor({ state: "visible" });
    await page.locator("#docPreviewBody h1").getByText("Quarterly Report").waitFor();
    await page.locator("#filesDialog").waitFor({ state: "hidden" });
    expect(await page.locator("#docPreviewTitle").textContent()).toBe("REPORT.md");
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "web-doc-preview-files-1280.png") });
    await page.locator("#btnCloseDocPreview").click();
    await dialog.waitFor({ state: "hidden" });
    // The row button is gone with the file list, so focus lands in the composer.
    await page.waitForFunction(() => document.activeElement?.id === "msgInput");

    // A narrow window swaps the pane for a modal with a backdrop.
    await page.setViewportSize({ width: 390, height: 740 });
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    await page.locator("#docPreviewBody h1").getByText("Quarterly Report").waitFor();
    const narrow = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>("#docPreview")!;
      const scroll = pane.querySelector<HTMLElement>(".doc-preview-scroll")!;
      const box = pane.getBoundingClientRect();
      return {
        position: getComputedStyle(pane).position,
        hasDoc: document.querySelector("#chatView")!.classList.contains("has-doc"),
        pageOverflow: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        paneOverflow: pane.scrollWidth - pane.clientWidth,
        scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
        left: box.left, right: box.right,
        width: innerWidth,
      };
    });
    expect(narrow.position).toBe("fixed");
    expect(narrow.hasDoc).toBe(false);
    expect(narrow.pageOverflow).toBe(0);
    expect(narrow.paneOverflow).toBe(0);
    expect(narrow.scrollOverflow).toBe(0);
    expect(narrow.left).toBeGreaterThanOrEqual(0);
    expect(narrow.right).toBeLessThanOrEqual(narrow.width);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "web-doc-preview-narrow-390.png") });

    // Clicking the backdrop dismisses the overlay.
    await page.mouse.click(4, 4);
    await dialog.waitFor({ state: "hidden" });

    // Esc closes the overlay too, with the same focus return.
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview: REPORT.md");

    // 320px keeps the overlay inside the viewport with no horizontal scrolling.
    await page.setViewportSize({ width: 320, height: 700 });
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    await page.locator("#docPreviewBody h1").getByText("Quarterly Report").waitFor();
    const phone = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>("#docPreview")!, box = pane.getBoundingClientRect();
      const scroll = pane.querySelector<HTMLElement>(".doc-preview-scroll")!;
      return {
        pageOverflow: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        paneOverflow: pane.scrollWidth - pane.clientWidth,
        scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
        left: box.left, right: box.right, width: innerWidth,
      };
    });
    expect(phone.pageOverflow).toBe(0);
    expect(phone.paneOverflow).toBe(0);
    expect(phone.scrollOverflow).toBe(0);
    expect(phone.left).toBeGreaterThanOrEqual(0);
    expect(phone.right).toBeLessThanOrEqual(phone.width);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "web-doc-preview-phone-320.png") });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // A wide but short window also keeps the overlay: no squeezed chat column.
    await page.setViewportSize({ width: 1280, height: 520 });
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#docPreview")!).position)).toBe("fixed");
    expect(await page.evaluate(() => document.querySelector("#chatView")!.classList.contains("has-doc"))).toBe(false);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "web-doc-preview-short-1280x520.png") });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // The pane splitter shares one width between both panes and never touches the rail.
    await page.setViewportSize({ width: 1440, height: 900 });
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    const handle = page.locator("#sidePaneHandle");
    await handle.waitFor({ state: "visible" });
    expect(await handle.getAttribute("role")).toBe("separator");
    expect(await handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(await handle.getAttribute("tabindex")).toBe("0");
    const initial = await paneMetrics(page);
    expect(initial.rail).toBe(252);
    expect(initial.pane).toBeGreaterThanOrEqual(430);
    expect(initial.pane).toBeLessThanOrEqual(434);
    expect(initial.chat).toBeGreaterThanOrEqual(420);
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBe(Math.round(initial.pane));

    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction((expected: number) => Math.abs(document.querySelector("#docPreview")!.getBoundingClientRect().width - expected) <= 2, initial.pane + 120);
    const dragged = await paneMetrics(page);
    expect(dragged.rail).toBe(252);
    expect(dragged.pane).toBeGreaterThan(initial.pane + 100);
    expect(dragged.chat).toBeLessThan(initial.chat - 100);
    expect(Math.abs((initial.chat - dragged.chat) - (dragged.pane - initial.pane))).toBeLessThanOrEqual(2);
    expect(Number(await page.evaluate(() => localStorage.getItem("chat.sidePaneWidth")))).toBe(Math.round(dragged.pane));

    await handle.focus();
    const max = Number(await handle.getAttribute("aria-valuemax"));
    await page.keyboard.press("End");
    await page.waitForFunction((width: number) => Math.abs(document.querySelector("#docPreview")!.getBoundingClientRect().width - width) <= 1, max);
    const widest = await paneMetrics(page);
    expect(widest.pane).toBeGreaterThanOrEqual(700);
    expect(widest.chat).toBeGreaterThanOrEqual(419);
    expect(widest.rail).toBe(252);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((width: number) => Math.abs(document.querySelector("#docPreview")!.getBoundingClientRect().width - width) <= 1, max - 16);
    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForFunction((width: number) => Math.abs(document.querySelector("#docPreview")!.getBoundingClientRect().width - width) <= 1, max - 80);
    await page.keyboard.press("Home");
    await page.waitForFunction(() => Math.abs(document.querySelector("#docPreview")!.getBoundingClientRect().width - 360) <= 1);
    expect((await paneMetrics(page)).chat).toBeGreaterThan(widest.chat);

    await handle.dblclick();
    await page.waitForFunction(() => Math.abs(document.querySelector("#docPreview")!.getBoundingClientRect().width - 432) <= 2);
    expect(await page.evaluate(() => localStorage.getItem("chat.sidePaneWidth"))).toBeNull();
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("#chatView")!.style.getPropertyValue("--side-pane-width"))).toBe("");

    // A stored width comes back after a reload and re-clamps to the current window.
    await handle.focus();
    await page.keyboard.press("End");
    const stored = Number(await page.evaluate(() => localStorage.getItem("chat.sidePaneWidth")));
    expect(stored).toBe(max);
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await card.getByText("REPORT.md").waitFor();
    await page.waitForFunction((width: number) => document.querySelector<HTMLElement>("#chatView")!.style.getPropertyValue("--side-pane-width") === `${width}px`, stored);
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    await handle.waitFor({ state: "visible" });
    await page.waitForFunction((width: number) => Math.abs(document.querySelector("#docPreview")!.getBoundingClientRect().width - width) <= 2, stored);
    const restored = await paneMetrics(page);
    expect(restored.rail).toBe(252);
    expect(restored.chat).toBeGreaterThanOrEqual(419);

    // Narrowing the window re-clamps the stored width instead of squeezing the chat.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForFunction(() => document.querySelector("#docPreview")!.getBoundingClientRect().width < 400);
    const clamped = await paneMetrics(page);
    expect(clamped.rail).toBe(252);
    expect(clamped.pane).toBeGreaterThanOrEqual(379);
    expect(clamped.pane).toBeLessThanOrEqual(384);
    expect(clamped.chat).toBeGreaterThanOrEqual(419);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // 900x700 is modal: the stored width is ignored and the separator is gone.
    await page.setViewportSize({ width: 900, height: 700 });
    await previewButton.click();
    await dialog.waitFor({ state: "visible" });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#docPreview")!).position)).toBe("fixed");
    expect(await page.evaluate(() => document.querySelector("#chatView")!.classList.contains("has-doc"))).toBe(false);
    expect(await handle.isVisible()).toBe(false);
    expect(await paneMetrics(page).then((metrics) => metrics.rail)).toBe(252);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    expect(pageErrors).toEqual([]);
  } finally {
    if (roomID && sessionID) await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionID }) }).catch(() => {});
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
}, 90000);

async function paneMetrics(page: any) {
  return page.evaluate(() => {
    const width = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().width;
    return { rail: width("#roomRail"), pane: width("#docPreview"), chat: width("#msgScroll") };
  });
}

async function uploadMarkdown(origin: string, roomID: string, sessionID: string, name: string, content: string) {
  const response = await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}/resources`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Session-ID": sessionID,
      "X-File-Name": encodeURIComponent(name),
      "Content-Type": "application/octet-stream",
    },
    body: content,
  });
  expect(response.status).toBe(201);
  return (await response.json()).resource as { id: string; name: string };
}

async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}

function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local isolated chat server did not start");
}