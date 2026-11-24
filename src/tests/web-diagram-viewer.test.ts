/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-diagram-viewer-token";
const DIAGRAM = ["```mermaid", "flowchart LR", "  A[Start] --> B{Review}", "  B -->|ship| C[Done]", "  B -->|fix| A", "```"].join("\n");
const DOCUMENT = ["# Diagram document", "", "```mermaid", "flowchart TD", "  X[Open] --> Y[Read]", "```", ""].join("\n");

test.skipIf(!browserModule)("diagrams re-theme, open in a zoomable viewer, and close back to the thread", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-diagram-viewer-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || dir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(dir, port), stdio: "ignore" });
  let browser: any, roomID = "", sessionID = "";
  const pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, colorScheme: "light" });
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_DiagramOwner");
    await page.locator("#inRoomName").fill("__Test_DiagramViewer");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { roomID: app.state.room.id as string, sessionID: app.LS.sessionID as string };
    }, "/assets/chat/state.js");
    roomID = identity.roomID; sessionID = identity.sessionID;

    await page.locator("#msgInput").fill(DIAGRAM);
    await page.locator("#btnSend").click();
    const diagram = page.locator("#msgList .mermaid-diagram").last();
    await diagram.locator("svg").waitFor();
    await page.locator("#msgList .mermaid-diagram").getByText("Review").waitFor();
    expect(await diagram.getAttribute("role")).toBe("button");
    expect(await diagram.getAttribute("tabindex")).toBe("0");
    expect(await diagram.getAttribute("aria-label")).toBe("Open diagram");

    // The intrinsic viewBox is kept, so the message column can scale the SVG down.
    const intrinsic = await diagram.evaluate((node: HTMLElement) => {
      const svg = node.querySelector("svg")!;
      return { width: Number(svg.getAttribute("width")), style: svg.getAttribute("style"), viewBox: svg.getAttribute("viewBox"), overflow: node.scrollWidth - node.clientWidth };
    });
    expect(intrinsic.width).toBeGreaterThan(100);
    expect(intrinsic.style).toBeNull();
    expect(intrinsic.viewBox).toMatch(/^0 0 \d/);
    expect(intrinsic.overflow).toBeLessThanOrEqual(0);

    // Use the same theme control the settings tests use.
    await setTheme(page, "light");
    const light = await diagramColors(page);
    expect(light.fill).toBe(light.tokens.accentSoft);
    expect(light.text).toBe(light.tokens.ink);
    expect(light.edge).toBe(light.tokens.ink2);
    expect(contrast(light.fill, light.text)).toBeGreaterThan(4.5);
    expect(contrast(light.edge, light.tokens.surface2)).toBeGreaterThan(3);

    await setTheme(page, "dark");
    await page.waitForFunction(() => {
      const shape = document.querySelector("#msgList .mermaid-diagram svg .node rect, #msgList .mermaid-diagram svg .node polygon, #msgList .mermaid-diagram svg .node path");
      const probe = document.createElement("span"); probe.style.cssText = "position:fixed;left:-9999px"; document.body.append(probe);
      probe.style.color = "var(--accent-soft)"; const expected = getComputedStyle(probe).color; probe.remove();
      return Boolean(shape) && getComputedStyle(shape!).fill === expected;
    });
    const dark = await diagramColors(page);
    expect(dark.fill).toBe(dark.tokens.accentSoft);
    expect(dark.text).toBe(dark.tokens.ink);
    expect(dark.edgeLabelBg).toBe(dark.tokens.surface);
    expect(dark.fill).not.toBe(light.fill);
    expect(dark.text).not.toBe(light.text);
    expect(contrast(dark.fill, dark.text)).toBeGreaterThan(4.5);
    expect(contrast(dark.edge, dark.tokens.surface2)).toBeGreaterThan(3);
    await page.screenshot({ path: path.join(artifacts, "web-diagram-theme-dark.png") });

    // The re-rendered diagram keeps its click-to-open wiring, including a direct SVG click.
    const viewer = page.locator("#diagramViewer");
    await diagram.locator("svg").click();
    await viewer.waitFor({ state: "visible" });
    await page.locator("#diagramViewerStage svg").waitFor();
    expect(await page.locator("#diagramViewerStage svg").count()).toBe(1);
    expect(await page.evaluate(() => document.body.classList.contains("diagram-viewer-open"))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
    const initial = await viewerState(page);
    expect(initial.level).toBeGreaterThanOrEqual(50);
    expect(initial.level).toBeLessThanOrEqual(400);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(artifacts, "web-diagram-viewer-dark.png") });

    await page.locator("#btnDiagramZoomIn").click();
    const zoomed = await viewerState(page);
    expect(zoomed.level).toBeGreaterThan(initial.level);
    expect(zoomed.transform).not.toBe(initial.transform);

    const body = await page.locator("#diagramViewerBody").boundingBox();
    await page.mouse.move(body!.x + body!.width / 2, body!.y + body!.height / 2);
    await page.mouse.wheel(0, -260);
    await page.waitForTimeout(80);
    expect((await viewerState(page)).level).toBeGreaterThan(zoomed.level);

    // Double-click resets to the initial contain fit.
    await page.locator("#diagramViewerStage").dblclick();
    const reset = await viewerState(page);
    expect(reset.level).toBe(initial.level);
    expect(reset.transform).toBe(initial.transform);

    // Dragging pans a zoomed diagram.
    await page.locator("#btnDiagramZoomIn").click();
    await page.locator("#btnDiagramZoomIn").click();
    const beforePan = await viewerState(page);
    const stageBox = await page.locator("#diagramViewerStage").boundingBox();
    await page.mouse.move(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(stageBox!.x + stageBox!.width / 2 - 120, stageBox!.y + stageBox!.height / 2, { steps: 5 });
    await page.mouse.up();
    expect((await viewerState(page)).transform).not.toBe(beforePan.transform);
    await page.locator("#btnDiagramFit").click();

    // Zoom buttons stop at the documented 50%–400% range.
    for (let index = 0; index < 12; index++) {
      if (await page.locator("#btnDiagramZoomIn").isDisabled()) break;
      await page.locator("#btnDiagramZoomIn").click();
    }
    expect((await viewerState(page)).level).toBe(400);
    expect(await page.locator("#btnDiagramZoomIn").isDisabled()).toBe(true);
    for (let index = 0; index < 20; index++) {
      if (await page.locator("#btnDiagramZoomOut").isDisabled()) break;
      await page.locator("#btnDiagramZoomOut").click();
    }
    expect((await viewerState(page)).level).toBe(50);
    expect(await page.locator("#btnDiagramZoomOut").isDisabled()).toBe(true);
    await page.locator("#btnDiagramFit").click();
    expect((await viewerState(page)).level).toBe(initial.level);

    // Esc closes and returns focus to the diagram that opened the viewer.
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("mermaid-diagram"));
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");

    // Enter and Space activate it too; the close button and backdrop both work.
    await page.keyboard.press("Enter");
    await viewer.waitFor({ state: "visible" });
    await page.locator("#btnCloseDiagram").click();
    await viewer.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("mermaid-diagram"));
    await page.keyboard.press(" ");
    await viewer.waitFor({ state: "visible" });
    await page.mouse.click(4, 4);
    await viewer.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("mermaid-diagram"));

    // A phone-width window keeps the diagram inside the column and the toolbar usable.
    await page.setViewportSize({ width: 320, height: 700 });
    const narrow = await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>("#msgList .mermaid-diagram")!;
      return { pageOverflow: document.documentElement.scrollWidth - innerWidth, diagramOverflow: node.scrollWidth - node.clientWidth };
    });
    expect(narrow.pageOverflow).toBe(0);
    expect(narrow.diagramOverflow).toBe(0);
    await diagram.click();
    await viewer.waitFor({ state: "visible" });
    const narrowToolbar = await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(".diagram-viewer-toolbar")!;
      return {
        fits: toolbar.scrollWidth <= toolbar.clientWidth,
        buttons: Array.from(toolbar.querySelectorAll("button")).every((button) => button.getBoundingClientRect().width > 0),
        box: toolbar.getBoundingClientRect().width,
      };
    });
    expect(narrowToolbar.fits).toBe(true);
    expect(narrowToolbar.buttons).toBe(true);
    expect(narrowToolbar.box).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1180, height: 820 });

    // The doc preview pane uses the same click-to-open path.
    const resource = await uploadMarkdown(origin, roomID, sessionID, "DIAGRAM.md", DOCUMENT);
    await page.locator("#msgInput").fill(`[[resource:${resource.id}]]`);
    await page.locator("#btnSend").click();
    const card = page.locator(`.chat-resource[data-resource-id="${resource.id}"]`);
    await card.getByText("DIAGRAM.md").waitFor();
    await card.getByRole("button", { name: "Preview: DIAGRAM.md" }).click();
    await page.locator("#docPreview[open]").waitFor();
    const docDiagram = page.locator("#docPreviewBody .mermaid-diagram").last();
    await docDiagram.locator("svg").waitFor();
    expect(await docDiagram.getAttribute("role")).toBe("button");
    await docDiagram.click();
    await viewer.waitFor({ state: "visible" });
    expect(await page.locator("#diagramViewerStage svg").count()).toBe(1);
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("mermaid-diagram"));
    expect(await page.locator("#docPreview").getAttribute("open")).not.toBeNull();
    await page.locator("#btnCloseDocPreview").click();
    await page.locator("#docPreview").waitFor({ state: "hidden" });

    expect(pageErrors).toEqual([]);
  } finally {
    if (roomID && sessionID) await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionID }) }).catch(() => {});
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);

async function setTheme(page: any, theme: string) {
  await page.locator("#btnSettings").click();
  await page.locator("#chatSettings").waitFor({ state: "visible" });
  await page.locator("#settingsTabAppearance").click();
  await page.locator(`[data-theme-choice="${theme}"]`).click();
  await page.keyboard.press("Escape");
  await page.locator("#chatSettings").waitFor({ state: "hidden" });
  await page.waitForFunction((value: string) => document.documentElement.dataset.theme === value, theme);
}

async function diagramColors(page: any) {
  return page.evaluate(() => {
    const svg = document.querySelector("#msgList .mermaid-diagram svg");
    const probe = document.createElement("span"); probe.style.cssText = "position:fixed;left:-9999px"; document.body.append(probe);
    const token = (name: string) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
    const tokens = { ink: token("--ink"), ink2: token("--ink-2"), accentSoft: token("--accent-soft"), surface: token("--surface"), surface2: token("--surface-2") };
    probe.remove();
    const style = (selectors: string[], property: string) => {
      for (const selector of selectors) {
        const node = svg?.querySelector(selector);
        if (node) return getComputedStyle(node).getPropertyValue(property);
      }
      return "";
    };
    return {
      fill: style([".node rect", ".node polygon", ".node path"], "fill"),
      text: style([".node text"], "fill"),
      edge: style([".edgePaths path"], "stroke"),
      edgeLabelBg: style([".edgeLabel"], "background-color"),
      tokens,
    };
  });
}

async function viewerState(page: any) {
  return page.evaluate(() => {
    const level = Number((document.querySelector("#diagramZoomLevel")?.textContent || "0").replace("%", ""));
    const stage = document.querySelector<HTMLElement>("#diagramViewerStage");
    return { level, transform: stage ? getComputedStyle(stage).transform : "" };
  });
}

function contrast(a: string, b: string) {
  const luminance = (value: string) => {
    const channels = (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
    const linear = channels.map((channel) => {
      const part = channel / 255;
      return part <= .03928 ? part / 12.92 : ((part + .055) / 1.055) ** 2.4;
    });
    return .2126 * (linear[0] || 0) + .7152 * (linear[1] || 0) + .0722 * (linear[2] || 0);
  };
  const [high = 0, low = 1] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (high + .05) / (low + .05);
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