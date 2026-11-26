/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-office-fullscreen-token";
const OFFICE_ROUTE = "**/assets/chat/office-preview.js";
// The Office engine belongs to another lane; this mock proves the preview bridge.
const OFFICE_MOCK = `
export async function renderOffice(kind, blob, body, options = {}) {
  window.__officeCalls = window.__officeCalls || [];
  window.__officeCalls.push({ kind, size: blob.size, width: body.clientWidth, progress: typeof options.onProgress === "function" });
  if (window.__officeMode === "fail") throw new Error("mock parse failure");
  options.onProgress?.({ page: 1 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const node = document.createElement("div");
  node.className = "mock-office-doc";
  node.dataset.kind = kind;
  node.textContent = "Rendered " + kind.toUpperCase() + " (" + blob.size + " bytes)";
  body.append(node);
}
`;

test.skipIf(!browserModule)("Office previews and full screen work for every reading type", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-office-fullscreen-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || dir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(dir, port), stdio: "ignore" });
  let browser: any, roomID = "", sessionID = "";
  const pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light", acceptDownloads: true });
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.route(OFFICE_ROUTE, (route: any) => route.fulfill({ status: 200, contentType: "application/javascript", body: OFFICE_MOCK }));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_OfficeOwner");
    await page.locator("#inRoomName").fill("__Test_OfficeFullscreen");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { roomID: app.state.room.id as string, sessionID: app.LS.sessionID as string };
    }, "/assets/chat/state.js");
    roomID = identity.roomID; sessionID = identity.sessionID;

    const markdown = `# Full screen report\n\n${"Paragraph body for the reading pane.\n\n".repeat(40)}`;
    const typescript = "const answer: number = 42;\nexport default answer;\n";
    const text = "Plain text body\nsecond line\n";
    const docx = Buffer.from("PK\u0003\u0004mock docx bytes");
    const xlsx = Buffer.from("PK\u0003\u0004mock xlsx bytes");
    const pptx = Buffer.from("PK\u0003\u0004mock pptx bytes");
    const huge = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
    const files: Array<[string, Buffer | string]> = [
      ["REPORT.md", markdown], ["sample.txt", text], ["sample.ts", typescript],
      ["sample.pdf", pdfBytes()], ["spec.docx", docx], ["sheet.xlsx", xlsx],
      ["deck.pptx", pptx], ["huge.xlsx", huge],
    ];
    const resources = [];
    for (const [name, content] of files) resources.push(await upload(origin, roomID, sessionID, name, content));
    const byName = new Map(resources.map((resource) => [resource.name, resource]));
    const markers = resources.map((resource) => `[[resource:${resource.id}]]`).join("\n");
    await page.evaluate(async ({ url, id, sessionID, markers }: any) => {
      const { app } = await import(url);
      await app.api(`/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ sessionID, text: markers }) });
    }, { url: "/assets/chat/state.js", id: roomID, sessionID, markers });

    const cardFor = (name: string) => page.locator("#msgList .chat-resource").filter({ hasText: name });
    for (const name of ["REPORT.md", "sample.txt", "sample.ts", "sample.pdf", "spec.docx", "sheet.xlsx", "deck.pptx", "huge.xlsx"]) {
      await cardFor(name).getByRole("button", { name: `Preview: ${name}` }).waitFor();
    }
    const dialog = page.locator("#docPreview");
    const fullscreen = page.locator("#btnDocPreviewFullscreen");
    const openPreview = async (name: string) => {
      await cardFor(name).getByRole("button", { name: `Preview: ${name}` }).click();
      await dialog.waitFor({ state: "visible" });
    };
    const closePreview = async () => {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    };
    const toggleFullscreen = async () => {
      await fullscreen.click();
      await page.waitForFunction(() => document.querySelector("#docPreview")!.classList.contains("is-fullscreen"));
    };
    const leaveFullscreen = async () => {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#docPreview")!.classList.contains("is-fullscreen"));
    };
    const fullscreenMetrics = () => page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>("#docPreview")!;
      const box = pane.getBoundingClientRect();
      const head = pane.querySelector<HTMLElement>(".doc-preview-head")!.getBoundingClientRect();
      const scroll = pane.querySelector<HTMLElement>(".doc-preview-scroll")!.getBoundingClientRect();
      const styles = getComputedStyle(pane);
      return {
        full: pane.classList.contains("is-fullscreen"), pane: pane.classList.contains("is-pane"),
        position: styles.position, radius: styles.borderRadius, zIndex: Number(styles.zIndex),
        width: box.width, height: box.height, left: box.left, top: box.top,
        viewWidth: innerWidth, viewHeight: innerHeight,
        bodyOverflow: getComputedStyle(document.body).overflow,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        headerHeight: head.height, scrollHeight: scroll.height, headerTop: head.top, scrollTop: scroll.top,
        open: pane.hasAttribute("open"),
      };
    });

    // Office cards offer the reading pane, never the plain-text copy action.
    for (const name of ["spec.docx", "sheet.xlsx", "deck.pptx"]) {
      expect(await cardFor(name).locator(".resource-copy").count()).toBe(0);
      expect(await cardFor(name).getByRole("button", { name: /Download/ }).count()).toBe(1);
    }

    // The bridge receives the authenticated blob, reports progress, and owns the body.
    await openPreview("spec.docx");
    await page.waitForFunction(() => (window as any).__officeCalls?.length === 1);
    expect(await page.locator("#docPreviewStatus").textContent()).toBe("Loading file…");
    expect(await page.locator("#docPreviewBody .mock-office-doc").count()).toBe(0);
    await page.locator("#docPreviewBody .mock-office-doc").waitFor();
    const officeCall = await page.evaluate(() => {
      const call = (window as any).__officeCalls[0];
      return { ...call, bodyText: document.querySelector("#docPreviewBody")!.textContent || "" };
    });
    expect(officeCall.kind).toBe("docx");
    expect(officeCall.size).toBe(docx.length);
    expect(officeCall.progress).toBe(true);
    expect(officeCall.bodyText).toContain("Rendered DOCX");
    expect(await page.locator("#docPreviewLanguage").isVisible()).toBe(false);
    expect(await page.locator("#btnDocPreviewCopy").isVisible()).toBe(false);
    expect(await page.locator("#btnDocPreviewDownload").isEnabled()).toBe(true);
    expect(await fullscreen.isVisible()).toBe(true);
    expect((await fullscreen.locator("svg").boundingBox())?.width || 0).toBeGreaterThan(10);

    // Full screen fills the viewport, keeps the header and body, and locks the page.
    await toggleFullscreen();
    const wide = await fullscreenMetrics();
    expect(wide.full).toBe(true);
    expect(wide.pane).toBe(false);
    expect(wide.position).toBe("fixed");
    expect(wide.radius).toBe("0px");
    expect(wide.width).toBeGreaterThanOrEqual(wide.viewWidth - 1);
    expect(wide.height).toBeGreaterThanOrEqual(wide.viewHeight - 1);
    expect(Math.abs(wide.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(wide.top)).toBeLessThanOrEqual(1);
    expect(wide.bodyOverflow).toBe("hidden");
    expect(wide.htmlOverflow).toBe("hidden");
    expect(wide.headerHeight).toBeGreaterThan(40);
    expect(wide.scrollHeight).toBeGreaterThan(300);
    expect(wide.headerTop).toBeLessThan(wide.scrollTop);
    expect(await fullscreen.getAttribute("aria-label")).toBe("Exit full screen");
    expect(await fullscreen.locator("use").getAttribute("href")).toContain("arrow_minimize");
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(artifacts, "web-doc-office-fullscreen-1440.png") });

    // The first Esc leaves full screen only; the second closes and restores focus.
    await leaveFullscreen();
    expect(await dialog.getAttribute("open")).not.toBeNull();
    expect(await page.locator("body").evaluate((node: HTMLElement) => getComputedStyle(node).overflow)).not.toBe("hidden");
    await page.waitForFunction(() => document.querySelector("#docPreview")!.classList.contains("is-pane"));
    expect(await fullscreen.getAttribute("aria-label")).toBe("Full screen");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview: spec.docx");

    // The close button exits full screen and restores the opener in one step.
    await openPreview("spec.docx");
    await page.locator("#docPreviewBody .mock-office-doc").waitFor();
    await toggleFullscreen();
    await page.locator("#btnCloseDocPreview").click();
    await dialog.waitFor({ state: "hidden" });
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview: spec.docx");

    // Every reading type exposes the same full-screen control.
    for (const name of ["REPORT.md", "sample.txt", "sample.ts", "sample.pdf", "sheet.xlsx"]) {
      await openPreview(name);
      await fullscreen.waitFor({ state: "visible" });
      expect(await fullscreen.getAttribute("aria-label")).toBe("Full screen");
      expect(await fullscreen.locator("svg.fluent-icon").count()).toBe(1);
      await toggleFullscreen();
      expect((await fullscreenMetrics()).full).toBe(true);
      if (name === "sample.pdf") {
        const frame = page.locator("#docPreviewBody iframe.doc-pdf-frame");
        await frame.waitFor();
        expect(await frame.evaluate((node: HTMLElement) => node.getBoundingClientRect().height)).toBeGreaterThan(400);
      }
      if (name === "REPORT.md") {
        // Wheel and shortcut keys belong to the preview while it owns the screen.
        const before = await page.evaluate(() => ({
          thread: document.querySelector<HTMLElement>("#thread")!.scrollTop,
          preview: document.querySelector<HTMLElement>("#docPreview .doc-preview-scroll")!.scrollTop,
        }));
        const box = (await dialog.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 300);
        await page.waitForFunction((start: number) => document.querySelector<HTMLElement>("#docPreview .doc-preview-scroll")!.scrollTop > start, before.preview);
        await page.keyboard.press("Alt+Home");
        await page.waitForTimeout(50);
        const after = await page.evaluate(() => ({
          thread: document.querySelector<HTMLElement>("#thread")!.scrollTop,
          preview: document.querySelector<HTMLElement>("#docPreview .doc-preview-scroll")!.scrollTop,
        }));
        expect(after.thread).toBe(before.thread);
        expect(after.preview).toBeGreaterThan(before.preview);
      }
      await leaveFullscreen();
      await closePreview();
    }

    // Narrow windows keep the overlay behind full screen and close on the second Esc.
    await page.setViewportSize({ width: 390, height: 740 });
    await openPreview("REPORT.md");
    await page.locator("#docPreviewBody h1").getByText("Full screen report").waitFor();
    await toggleFullscreen();
    expect((await fullscreenMetrics()).position).toBe("fixed");
    await leaveFullscreen();
    expect(await dialog.getAttribute("open")).not.toBeNull();
    expect(await page.evaluate(() => document.querySelector("#docPreview")!.classList.contains("is-pane"))).toBe(false);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview: REPORT.md");
    await page.setViewportSize({ width: 1440, height: 900 });

    // A fixed-width slide deck is laid out again when the preview grows, so full
    // screen does not keep showing pane-sized slides.
    await openPreview("deck.pptx");
    await page.locator("#docPreviewBody .mock-office-doc").waitFor();
    const panePptx = await page.evaluate(() => {
      const calls = ((window as any).__officeCalls || []).filter((call: any) => call.kind === "pptx");
      return { count: calls.length, width: calls.at(-1).width as number };
    });
    await toggleFullscreen();
    await page.waitForFunction((count: number) => {
      const calls = ((window as any).__officeCalls || []).filter((call: any) => call.kind === "pptx");
      return calls.length > count;
    }, panePptx.count);
    const fullPptx = await page.evaluate(() => {
      const calls = ((window as any).__officeCalls || []).filter((call: any) => call.kind === "pptx");
      return { count: calls.length, width: calls.at(-1).width as number };
    });
    expect(fullPptx.width).toBeGreaterThan(panePptx.width + 100);
    await leaveFullscreen();
    await closePreview();

    // A parse failure leaves a clear message and a working download.
    await page.evaluate(() => { (window as any).__officeMode = "fail"; });
    await openPreview("deck.pptx");
    await page.waitForFunction(() => document.querySelector("#docPreviewNotice")?.textContent === "This Office file could not be previewed. Download it instead.");
    expect(await page.locator("#docPreviewBody .mock-office-doc").count()).toBe(0);
    expect(await page.locator("#docPreviewBody").textContent()).toBe("");
    expect(await page.locator("#btnDocPreviewDownload").isEnabled()).toBe(true);
    const failedDownload = page.waitForEvent("download");
    await page.locator("#btnDocPreviewDownload").click();
    expect((await failedDownload).suggestedFilename()).toBe("deck.pptx");
    await page.evaluate(() => { delete (window as any).__officeMode; });
    await closePreview();

    // Over 20 MiB: localized notice, no fetch, no engine call, download still offered.
    const callsBeforeHuge = await page.evaluate(() => ((window as any).__officeCalls || []).length as number);
    await openPreview("huge.xlsx");
    await page.locator("#docPreviewNotice").waitFor({ state: "visible" });
    expect(await page.locator("#docPreviewNotice").textContent()).toBe("This Office file is too large to preview (over 20 MB). Download it instead.");
    expect(await page.locator("#docPreviewLanguage").isVisible()).toBe(false);
    expect(await page.locator("#btnDocPreviewDownload").isEnabled()).toBe(true);
    expect(await page.locator("#docPreviewBody").textContent()).toBe("");
    expect(await page.evaluate(() => ((window as any).__officeCalls || []).length as number)).toBe(callsBeforeHuge);
    await closePreview();

    // Files rows route all three Office formats to the reading pane without a copy action.
    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnFiles").click();
    await page.locator("#filesDialog[open]").waitFor();
    await page.waitForFunction(() => document.querySelectorAll("#fileList .file-row").length >= 8);
    for (const name of ["spec.docx", "sheet.xlsx", "deck.pptx"]) {
      const row = page.locator("#fileList .file-row").filter({ hasText: name });
      expect(await row.locator('[data-file-action="preview"]').count()).toBe(1);
      expect(await row.locator('[data-file-action="copy"]').count()).toBe(0);
    }
    await page.locator("#fileList .file-row").filter({ hasText: "sheet.xlsx" }).locator('[data-file-action="preview"]').click();
    await page.locator("#filesDialog").waitFor({ state: "hidden" });
    await dialog.waitFor({ state: "visible" });
    await page.locator("#docPreviewBody .mock-office-doc").waitFor();
    expect(await page.evaluate(() => (window as any).__officeCalls.at(-1).kind)).toBe("xlsx");
    await page.screenshot({ path: path.join(artifacts, "web-doc-office-files-1440.png") });
    await closePreview();

    expect(pageErrors).toEqual([]);
  } finally {
    if (roomID && sessionID) await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionID }) }).catch(() => {});
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);

// Runs once the parallel lane lands its engine bundle; skipped while it is absent.
test.skipIf(!browserModule || !existsSync(path.join(process.cwd(), "server/assets/chat/office-preview.js")))("a real xlsx renders through the bundled Office engine", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-office-real-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || dir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(dir, port), stdio: "ignore" });
  let browser: any, roomID = "", sessionID = "";
  const pageErrors: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_RealOfficeOwner");
    await page.locator("#inRoomName").fill("__Test_RealOffice");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { roomID: app.state.room.id as string, sessionID: app.LS.sessionID as string };
    }, "/assets/chat/state.js");
    roomID = identity.roomID; sessionID = identity.sessionID;
    const XLSX: any = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Metric", "Value"], ["Revenue", 42]]), "Sheet1");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const resource = await upload(origin, roomID, sessionID, "real.xlsx", bytes);
    await page.evaluate(async ({ url, id, sessionID, text }: any) => {
      const { app } = await import(url);
      await app.api(`/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ sessionID, text }) });
    }, { url: "/assets/chat/state.js", id: roomID, sessionID, text: `[[resource:${resource.id}]]` });
    const card = page.locator(`.chat-resource[data-resource-id="${resource.id}"]`);
    await card.getByRole("button", { name: "Preview: real.xlsx" }).click();
    await page.locator("#docPreview[open]").waitFor();
    await page.waitForFunction(() => {
      const status = document.querySelector("#docPreviewStatus");
      const body = document.querySelector("#docPreviewBody");
      return status?.textContent === "" && (body?.children.length || 0) > 0;
    });
    expect(await page.evaluate(() => document.querySelector("#docPreview")!.classList.contains("is-office"))).toBe(true);
    expect(await page.locator("#docPreviewNotice").isVisible()).toBe(false);
    expect(await page.locator("#docPreviewLanguage").isVisible()).toBe(false);
    expect(await page.locator("#docPreviewBody").textContent()).toContain("Revenue");
    await page.locator("#btnDocPreviewFullscreen").click();
    await page.waitForFunction(() => document.querySelector("#docPreview")!.classList.contains("is-fullscreen"));
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(artifacts, "web-doc-office-real-1440.png") });
    expect(pageErrors).toEqual([]);
  } finally {
    if (roomID && sessionID) await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionID }) }).catch(() => {});
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);

async function upload(origin: string, roomID: string, sessionID: string, name: string, content: Buffer | string) {
  const response = await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}/resources`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Session-ID": sessionID,
      "X-File-Name": encodeURIComponent(name),
      "Content-Type": "application/octet-stream",
    },
    body: typeof content === "string" ? content : Uint8Array.from(content),
  });
  expect(response.status).toBe(201);
  return (await response.json()).resource as { id: string; name: string };
}

function pdfBytes() {
  const stream = "BT /F1 18 Tf 20 100 Td (Preview me) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
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