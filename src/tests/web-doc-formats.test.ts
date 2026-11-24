/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-doc-formats-token";
const tooLargeLabel = "This file is too large to preview (over 2 MB). Download it instead.";

test.skipIf(!browserModule)("plain text, code, and PDF resources preview in the reading pane", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-doc-formats-"));
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
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    const contentRequests: string[] = [];
    page.on("request", (request: any) => {
      if (/\/resources\/[^/]+\/content$/.test(new URL(request.url()).pathname)) contentRequests.push(request.url());
    });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_FormatsOwner");
    await page.locator("#inRoomName").fill("__Test_DocFormats");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { roomID: app.state.room.id as string, sessionID: app.LS.sessionID as string };
    }, "/assets/chat/state.js");
    roomID = identity.roomID; sessionID = identity.sessionID;

    const longLine = `long ${"segment ".repeat(120)}line`;
    const text = `Plain <b>text</b> & symbols\n${longLine}\n`;
    const typescript = "const answer: number = 42;\nexport default answer;\n";
    const json = '{"answer": 42, "items": ["a", "b"]}';
    const html = "<script>window.__docXss = 1</script>\n<p>hello</p>";
    const markdown = "# Raw title\n\n- **bold** item\n\n`inline`\n";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
    const pdf = pdfBytes();
    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 0, 7]);
    const files: Array<[string, Buffer | string]> = [
      ["sample.txt", text],
      ["sample.ts", typescript],
      ["sample.json", json],
      ["sample.html", html],
      ["notes.md", markdown],
      ["pixel.png", png],
      ["sample.pdf", pdf],
      ["too-big.txt", Buffer.from("x".repeat(2 * 1024 * 1024 + 1))],
      ["empty.txt", Buffer.from("")],
      ["sample.bin", binary],
    ];
    const resources = [];
    for (const [name, content] of files) resources.push(await upload(origin, roomID, sessionID, name, content));
    const broken = await upload(origin, roomID, sessionID, "broken.log", "log that will not load");
    resources.push(broken);
    const byName = new Map(resources.map((resource) => [resource.name, resource]));
    const contentCount = (name: string) => contentRequests.filter((url) => url.includes(byName.get(name)!.id)).length;
    const markers = resources.map((resource) => `[[resource:${resource.id}]]`).join("\n");
    await page.evaluate(async ({ url, id, sessionID, markers }: any) => {
      const { app } = await import(url);
      await app.api(`/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ sessionID, text: markers }) });
    }, { url: "/assets/chat/state.js", id: roomID, sessionID, markers });
    const cardFor = (name: string) => page.locator("#msgList .chat-resource").filter({ hasText: name });
    for (const name of ["sample.txt", "sample.ts", "sample.json", "sample.html", "sample.pdf", "too-big.txt", "empty.txt", "notes.md", "broken.log"]) {
      await cardFor(name).getByRole("button", { name: `Preview: ${name}` }).waitFor();
    }
    for (const name of ["pixel.png", "sample.bin"]) await cardFor(name).locator(".resource-name").waitFor();
    expect(await cardFor("sample.bin").locator("button[data-i18n='resourcePreview']").count()).toBe(0);

    await page.evaluate(() => {
      (window as any).__copied = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).__copied.push(value); } } });
    });
    const copiedLength = () => page.evaluate(() => (window as any).__copied.length as number);
    const lastCopied = () => page.evaluate(() => (window as any).__copied.at(-1) as string);
    const copyFailedText = await page.evaluate(async (url: string) => (await import(url)).app.t("copyMessageFailed"), "/assets/chat/state.js");

    // Card copy stays lazy and copies the raw file, not the rendered document.
    const txtCopy = cardFor("sample.txt").locator(".resource-copy");
    await txtCopy.waitFor();
    expect(contentCount("sample.txt")).toBe(0);
    expect(await txtCopy.getAttribute("aria-label")).toBe("Copy");
    expect(await txtCopy.locator("svg.copy-icon").evaluate((node: SVGElement) => node.getBoundingClientRect().width)).toBe(16);
    expect(await txtCopy.locator("svg.copy-icon use").getAttribute("href")).toBe("/assets/fluent-icons.svg#fluent-copy-24");
    await txtCopy.click();
    await page.waitForFunction(() => (window as any).__copied.length === 1);
    expect(await lastCopied()).toBe(text);
    expect(await txtCopy.getAttribute("aria-label")).toBe("Copied");
    expect(await txtCopy.locator(".copy-feedback").textContent()).toBe("Copied");
    expect(contentCount("sample.txt")).toBe(1);
    await cardFor("notes.md").locator(".resource-copy").click();
    await page.waitForFunction(() => (window as any).__copied.length === 2);
    expect(await lastCopied()).toBe(markdown);
    expect(contentCount("notes.md")).toBe(1);
    expect(await cardFor("sample.pdf").locator(".resource-copy").count()).toBe(0);
    expect(await cardFor("pixel.png").locator(".resource-copy").count()).toBe(0);
    expect(await cardFor("sample.bin").locator(".resource-copy").count()).toBe(0);
    const beforeBigCard = await copiedLength();
    await cardFor("too-big.txt").locator(".resource-copy").click();
    await cardFor("too-big.txt").locator(".resource-copy.is-copy-failed").waitFor();
    expect(await copiedLength()).toBe(beforeBigCard);
    expect(contentCount("too-big.txt")).toBe(0);
    await page.screenshot({ path: path.join(artifacts, "web-doc-formats-cards-1440.png") });

    const dialog = page.locator("#docPreview");
    const openPreview = async (name: string) => {
      await cardFor(name).getByRole("button", { name: `Preview: ${name}` }).click();
      await dialog.waitFor({ state: "visible" });
    };
    const closePreview = async () => {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    };

    // Plain text is escaped, wrapped, and fills the reading width.
    await openPreview("sample.txt");
    const code = page.locator("#docPreviewBody .doc-code code");
    await code.waitFor();
    expect(await code.textContent()).toBe(text);
    expect(await page.locator("#docPreviewBody b").count()).toBe(0);
    expect(await page.locator("#docPreviewLanguage").textContent()).toBe("TXT");
    expect(await page.locator("#docPreviewEyebrow").textContent()).toBe("File preview");
    expect(await code.evaluate((node: HTMLElement) => getComputedStyle(node).whiteSpace)).toBe("pre-wrap");
    const wrapped = await page.locator("#docPreviewBody .doc-code").evaluate((pre: HTMLElement) => ({
      scroll: pre.scrollWidth, client: pre.clientWidth,
      preWidth: pre.getBoundingClientRect().width,
      bodyWidth: pre.closest("#docPreviewBody")!.getBoundingClientRect().width,
    }));
    expect(wrapped.scroll).toBeLessThanOrEqual(wrapped.client + 1);
    expect(Math.abs(wrapped.preWidth - wrapped.bodyWidth)).toBeLessThanOrEqual(2);
    const txtHeaderCopy = page.locator("#btnDocPreviewCopy");
    expect(await txtHeaderCopy.isVisible()).toBe(true);
    const beforeHeaderCopy = await copiedLength();
    await txtHeaderCopy.click();
    await page.waitForFunction((count: number) => (window as any).__copied.length === count + 1, beforeHeaderCopy);
    expect(await lastCopied()).toBe(text);
    expect(await txtHeaderCopy.getAttribute("aria-label")).toBe("Copied");
    expect(contentCount("sample.txt")).toBe(2);
    await closePreview();

    // TypeScript gets a real highlight token and a readable language label.
    await openPreview("sample.ts");
    await page.locator("#docPreviewBody code.language-typescript").waitFor();
    expect(await page.locator("#docPreviewBody .doc-code [class*='hljs-']").count()).toBeGreaterThan(0);
    expect(await page.locator("#docPreviewLanguage").textContent()).toBe("TypeScript");
    expect(await page.locator("#docPreviewBody").textContent()).toContain("answer");
    const beforeTsCopy = await copiedLength();
    await page.locator("#btnDocPreviewCopy").click();
    await page.waitForFunction((count: number) => (window as any).__copied.length === count + 1, beforeTsCopy);
    expect(await lastCopied()).toBe(typescript);
    await closePreview();

    await openPreview("sample.json");
    await page.locator("#docPreviewBody .doc-code").waitFor();
    expect(await page.locator("#docPreviewLanguage").textContent()).toBe("JSON");
    expect(await page.locator("#docPreviewBody .doc-code [class*='hljs-']").count()).toBeGreaterThan(0);
    await closePreview();

    // Markup previews as escaped source: no script nodes and no execution.
    await openPreview("sample.html");
    await page.locator("#docPreviewBody .doc-code").waitFor();
    expect(await page.locator("#docPreviewBody").textContent()).toContain("<script>window.__docXss = 1</script>");
    expect(await page.locator("#docPreviewBody script").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__docXss)).toBeUndefined();
    await closePreview();

    // Markdown copies its raw source, not the rendered text in the pane.
    await openPreview("notes.md");
    await page.locator("#docPreviewBody h1").filter({ hasText: "Raw title" }).waitFor();
    const beforeMarkdownCopy = await copiedLength();
    await page.locator("#btnDocPreviewCopy").click();
    await page.waitForFunction((count: number) => (window as any).__copied.length === count + 1, beforeMarkdownCopy);
    expect(await lastCopied()).toBe(markdown);
    await closePreview();

    // Empty files keep the existing empty state and fail the copy cleanly.
    await openPreview("empty.txt");
    await page.locator("#docPreviewEmpty").waitFor({ state: "visible" });
    expect(await page.locator("#docPreviewBody .doc-code").count()).toBe(0);
    const emptyCopy = page.locator("#btnDocPreviewCopy");
    expect(await emptyCopy.isVisible()).toBe(true);
    const beforeEmptyCopy = await copiedLength();
    await emptyCopy.click();
    await page.waitForFunction(() => document.querySelector("#btnDocPreviewCopy")?.classList.contains("is-copy-failed"));
    expect(await copiedLength()).toBe(beforeEmptyCopy);
    expect(await emptyCopy.locator(".copy-feedback").textContent()).toBe(copyFailedText);
    await closePreview();

    // Over the 2 MiB cap: a localized notice and a usable download, never rendered text.
    await openPreview("too-big.txt");
    await page.locator("#docPreviewNotice").waitFor({ state: "visible" });
    expect(await page.locator("#docPreviewNotice").textContent()).toBe(tooLargeLabel);
    expect(await page.locator("#docPreviewBody .doc-code").count()).toBe(0);
    expect(await page.locator("#btnDocPreviewDownload").isEnabled()).toBe(true);
    const beforeBigCopy = await copiedLength();
    await page.locator("#btnDocPreviewCopy").click();
    await page.waitForFunction(() => document.querySelector("#btnDocPreviewCopy")?.classList.contains("is-copy-failed"));
    expect(await copiedLength()).toBe(beforeBigCopy);
    expect(contentCount("too-big.txt")).toBe(0);
    await page.evaluate(async (url: string) => (await import(url)).app.setLocale("zh-CN"), "/assets/chat/state.js");
    await page.waitForFunction(() => document.querySelector("#docPreviewNotice")?.textContent?.includes("2 MB"));
    expect(await page.locator("#docPreviewNotice").textContent()).toContain("文件太大");
    await page.evaluate(async (url: string) => (await import(url)).app.setLocale("en"), "/assets/chat/state.js");
    await closePreview();

    // A failed content load leaves the copy action hidden.
    const brokenId = byName.get("broken.log")!.id;
    await page.route(`**/resources/${brokenId}/content`, (route: any) => route.fulfill({ status: 500, contentType: "text/plain", body: "no" }));
    await openPreview("broken.log");
    await page.waitForFunction(() => document.querySelector("#docPreviewStatus")?.textContent === "This document could not be loaded.");
    expect(await page.locator("#btnDocPreviewCopy").isVisible()).toBe(false);
    await closePreview();
    await page.unroute(`**/resources/${brokenId}/content`);

    // PDF opens in a borderless, full-height iframe and its object URL is revoked on close.
    await page.evaluate(() => {
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      (window as any).__created = []; (window as any).__revoked = [];
      URL.createObjectURL = (value: Blob) => { const url = create(value); (window as any).__created.push(url); return url; };
      URL.revokeObjectURL = (url: string) => { (window as any).__revoked.push(url); revoke(url); };
    });
    await openPreview("sample.pdf");
    const frame = page.locator("#docPreviewBody iframe.doc-pdf-frame");
    await frame.waitFor();
    const pdfSrc = (await frame.getAttribute("src")) || "";
    expect(pdfSrc).toMatch(/^blob:/);
    expect(await page.locator("#docPreviewLanguage").textContent()).toBe("PDF");
    expect(await page.locator("#btnDocPreviewCopy").isVisible()).toBe(false);
    const pdfBox = await frame.evaluate((node: HTMLIFrameElement) => ({
      border: getComputedStyle(node).borderWidth,
      height: node.getBoundingClientRect().height,
    }));
    expect(pdfBox.border).toBe("0px");
    expect(pdfBox.height).toBeGreaterThan(300);
    await closePreview();
    await page.waitForFunction((url: string) => (window as any).__revoked.includes(url), pdfSrc);

    // The same PDF works in the modal layout at 900x700.
    await page.setViewportSize({ width: 900, height: 700 });
    await openPreview("sample.pdf");
    await page.locator("#docPreviewBody iframe.doc-pdf-frame").waitFor();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#docPreview")!).position)).toBe("fixed");
    const modalHeight = await page.locator("#docPreviewBody iframe.doc-pdf-frame").evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    expect(modalHeight).toBeGreaterThan(200);
    await closePreview();

    // The Files dialog routes text rows to the reading pane as well.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnFiles").click();
    await page.locator("#filesDialog[open]").waitFor();
    await page.waitForFunction(() => document.querySelectorAll("#fileList .file-row").length >= 11);
    for (const name of ["sample.txt", "sample.ts", "sample.json", "sample.html", "sample.pdf"]) {
      const row = page.locator("#fileList .file-row").filter({ hasText: name });
      expect(await row.locator('[data-file-action="preview"]').count()).toBe(1);
    }
    expect(await page.locator("#fileList .file-row").filter({ hasText: "sample.bin" }).locator('[data-file-action="preview"]').count()).toBe(0);
    for (const name of ["sample.txt", "sample.ts", "sample.json", "sample.html", "notes.md", "empty.txt", "too-big.txt", "broken.log"]) {
      expect(await page.locator("#fileList .file-row").filter({ hasText: name }).locator('[data-file-action="copy"]').count()).toBe(1);
    }
    for (const name of ["sample.pdf", "pixel.png", "sample.bin"]) {
      expect(await page.locator("#fileList .file-row").filter({ hasText: name }).locator('[data-file-action="copy"]').count()).toBe(0);
    }
    const beforeFilesCopy = await copiedLength();
    await page.locator("#fileList .file-row").filter({ hasText: "sample.txt" }).locator('[data-file-action="copy"]').click();
    await page.waitForFunction((count: number) => (window as any).__copied.length === count + 1, beforeFilesCopy);
    expect(await lastCopied()).toBe(text);
    expect(await page.locator("#filesDialog").isVisible()).toBe(true);
    await page.screenshot({ path: path.join(artifacts, "web-doc-formats-files-1440.png") });
    await page.locator("#fileList .file-row").filter({ hasText: "sample.txt" }).locator('[data-file-action="preview"]').click();
    await page.locator("#filesDialog").waitFor({ state: "hidden" });
    await dialog.waitFor({ state: "visible" });
    await page.locator("#docPreviewBody .doc-code code").waitFor();
    await page.screenshot({ path: path.join(artifacts, "web-doc-formats-text-1440.png") });
    await closePreview();

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