/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Route as BrowserRoute } from "playwright";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-paste-limit-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0HcAAAAASUVORK5CYII=", "base64");

test.skipIf(!browserModule)("composer limits text to 5000 and pastes larger text as a file", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href), stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-paste-limit-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors: string[] = [], uploads: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("request", (request: any) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && /\/rooms\/[^/]+\/resources$/.test(url.pathname)) uploads.push(decodeURIComponent(request.headers()["x-file-name"] || ""));
    });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_PasteOwner"); await page.locator("#inRoomName").fill("__Test_PasteLimit");
    await page.locator("#btnCreate").click(); await page.locator("#chatView").waitFor({ state: "visible" });
    const info = await page.evaluate(async (url: string) => { const { app } = await import(url); return { roomId: app.state.room.id, sessionID: app.LS.sessionID }; }, "/assets/chat/state.js");
    const input = page.locator("#msgInput"), tray = page.locator("#attachmentTray"), items = page.locator("#attachmentList .attachment-item");

    // Exact boundary: 5000 stays in the composer, 5001 becomes a file before touching the DOM.
    expect((await paste(page, "b".repeat(5000))).prevented).toBe(true);
    expect(await input.evaluate((node: any) => node.value.length)).toBe(5000);
    expect(await tray.isHidden()).toBe(true);
    expect((await page.locator("#draftCount").textContent())!.trim()).toBe("5000 / 5000");
    expect(await page.locator("#btnSend").isEnabled()).toBe(true);
    await input.fill("");
    const emptyValue = await input.evaluate((node: any) => node.value);
    const pasted = await paste(page, "b".repeat(5001));
    expect(pasted.prevented).toBe(true);
    expect(pasted.status).toBe("Pasted 5001 characters saved as a text file");
    expect(await input.evaluate((node: any) => node.value)).toBe(emptyValue);
    expect(await items.count()).toBe(1);
    expect(await page.locator("#attachmentList .attachment-name").textContent()).toMatch(/^pasted-text-\d{14}\.txt$/);
    expect(await page.locator("#attachmentStatus").getAttribute("role")).toBe("status");
    expect(await page.locator("#attachmentStatus").getAttribute("aria-live")).toBe("polite");
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    await page.locator("#attachmentList [data-upload-action=remove]").click(); await tray.waitFor({ state: "hidden" });

    // A huge paste never enters the editor, keeps the draft and selection, and lands byte-for-byte in the file.
    const huge = `${"Line with 汉字 and 🙂\n".repeat(5000)}END`;
    await input.fill("Keep my draft");
    await input.evaluate((node: any) => node.setSelectionRange(0, 4));
    const uploadResponse = page.waitForResponse((response: any) => {
      const request = response.request();
      return request.method() === "POST" && /\/rooms\/[^/]+\/resources$/.test(new URL(response.url()).pathname) && decodeURIComponent(request.headers()["x-file-name"] || "").startsWith("pasted-text-");
    });
    const pasteStarted = Date.now(), hugePaste = await paste(page, huge), pasteDuration = Date.now() - pasteStarted;
    expect(hugePaste.prevented).toBe(true); expect(pasteDuration).toBeLessThan(1000);
    expect(hugePaste.status).toBe(`Pasted ${huge.length} characters saved as a text file`);
    expect(await input.evaluate((node: any) => node.value)).toBe("Keep my draft");
    expect(await input.evaluate((node: any) => node.getSelectionOffsets())).toEqual([0, 4]);
    const resource = (await (await uploadResponse).json()).resource;
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    const stored = await resourceText(origin, info.roomId, resource.id);
    expect(stored).toBe(huge);
    expect(new TextEncoder().encode(stored).byteLength).toBe(new TextEncoder().encode(huge).byteLength);
    await page.locator("#attachmentList [data-upload-action=remove]").click(); await input.fill("");

    // Mixed clipboard: long text plus an image keeps both, and the message carries two markers.
    const mixed = "mixed clipboard ".repeat(400);
    const mixedUpload = page.waitForResponse((response: any) => decodeURIComponent(response.request().headers()["x-file-name"] || "").startsWith("pasted-text-"));
    const mixedImage = page.waitForRequest((request: any) => decodeURIComponent(request.headers()["x-file-name"] || "") === "__Test_mixed.png");
    mixedUpload.catch(() => {}); mixedImage.catch(() => {});
    await paste(page, mixed, [{ name: "__Test_mixed.png", type: "image/png", base64: png.toString("base64") }]);
    expect((await input.evaluate((node: any) => node.value)).trim()).toBe("");
    expect(await items.count()).toBe(2);
    await mixedImage;
    expect(uploads.filter((name) => name === "__Test_mixed.png")).toHaveLength(1);
    const mixedResource = (await (await mixedUpload).json()).resource;
    await page.waitForFunction(() => {
      const details = Array.from(document.querySelectorAll("#attachmentList .attachment-detail"));
      return document.querySelectorAll("#attachmentList .attachment-item").length === 2 && details.every((node) => node.textContent?.includes("Ready to send"));
    });
    expect(await resourceText(origin, info.roomId, mixedResource.id)).toBe(mixed);
    await page.locator("#btnSend").click(); await tray.waitFor({ state: "hidden" });
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.at(-1)?.text.includes("[[resource:"), "/assets/chat/state.js");
    const mixedMessage = (await api(origin, `/rooms/${info.roomId}`)).messages.at(-1);
    expect((mixedMessage.text.match(/\[\[resource:/g) || []).length).toBe(2);

    // Resource markers count toward the limit: one 49-character marker leaves 4949 caption characters.
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_marker.txt", mimeType: "text/plain", buffer: Buffer.from("marker") });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    await input.fill("m".repeat(4949));
    expect((await page.locator("#draftCount").textContent())!.trim()).toBe("5000 / 5000");
    expect(await page.locator("#btnSend").isEnabled()).toBe(true);
    await input.fill("m".repeat(4950));
    expect(await page.locator("#draftCount").getAttribute("class")).toContain("over-limit");
    expect(await page.locator("#btnSend").isDisabled()).toBe(true);
    await page.locator("#attachmentList [data-upload-action=remove]").click(); await input.fill("");

    // Typed or programmatic over-limit text converts on Send, then uploads and sends in one action.
    await input.fill("x".repeat(5001));
    expect(await page.locator("#btnSend").isEnabled()).toBe(true);
    const typedUpload = page.waitForResponse((response: any) => decodeURIComponent(response.request().headers()["x-file-name"] || "").startsWith("pasted-text-"));
    await page.locator("#btnSend").click();
    const typedResource = (await (await typedUpload).json()).resource;
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.at(-1)?.text.startsWith("[[resource:"), "/assets/chat/state.js");
    expect((await input.evaluate((node: any) => node.value)).trim()).toBe("");
    expect(await resourceText(origin, info.roomId, typedResource.id)).toBe("x".repeat(5001));

    // A failed upload keeps the text in a retryable row and sends nothing until it succeeds.
    const beforeFailure = (await api(origin, `/rooms/${info.roomId}`)).messages.length;
    let failed = false;
    await page.route("**/rooms/*/resources", async (route: BrowserRoute) => {
      if (!failed && decodeURIComponent(route.request().headers()["x-file-name"] || "").startsWith("pasted-text-")) {
        failed = true; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary test failure" }) }); return;
      }
      await route.continue();
    });
    await input.fill("y".repeat(5001)); await page.locator("#btnSend").click();
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Upload failed"));
    expect((await api(origin, `/rooms/${info.roomId}`)).messages.length).toBe(beforeFailure);
    expect(await input.evaluate((node: any) => node.value)).toBe("y".repeat(5001));
    expect(await page.locator("#btnSend").isDisabled()).toBe(true);
    await page.unroute("**/rooms/*/resources");
    await page.locator("#attachmentList [data-upload-action=retry]").click();
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    expect(await page.locator("#btnSend").isEnabled()).toBe(true);
    await page.locator("#btnSend").click(); await tray.waitFor({ state: "hidden" });
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.at(-1)?.text.startsWith("[[resource:"), "/assets/chat/state.js");
    expect((await api(origin, `/rooms/${info.roomId}`)).messages.length).toBe(beforeFailure + 1);
    const retryResource = (await api(origin, `/rooms/${info.roomId}`)).messages.at(-1).text.match(/\[\[resource:([\da-f-]{36})\]\]/)![1];
    expect(await resourceText(origin, info.roomId, retryResource)).toBe("y".repeat(5001));

    // A pending typed conversion keeps the draft across reload; the text record is skipped, not duplicated.
    const pendingTyped = "r".repeat(5001);
    await input.fill(pendingTyped);
    let holdTyped = true, releaseTyped!: () => void;
    const typedGate = new Promise<void>((resolve) => { releaseTyped = resolve; });
    let typedStarted!: () => void;
    const typedRequest = new Promise<void>((resolve) => { typedStarted = resolve; });
    await page.route("**/rooms/*/resources", async (route: BrowserRoute) => {
      if (holdTyped && decodeURIComponent(route.request().headers()["x-file-name"] || "").startsWith("pasted-text-")) {
        typedStarted(); await typedGate; try { await route.continue(); } catch {}
        return;
      }
      await route.continue();
    });
    await page.locator("#btnSend").click(); await typedRequest;
    expect(await input.evaluate((node: any) => node.contentEditable)).toBe("false");
    expect(await input.evaluate((node: any) => node.value)).toBe(pendingTyped);
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction((text: string) => (document.querySelector("#msgInput") as any).value === text, pendingTyped);
    expect(await items.count()).toBe(0);
    holdTyped = false; releaseTyped(); await page.unroute("**/rooms/*/resources");
    await page.waitForFunction(() => (document.querySelector("#btnSend") as HTMLButtonElement).disabled === false);
    const resend = page.waitForResponse((response: any) => response.request().method() === "POST" && decodeURIComponent(response.request().headers()["x-file-name"] || "").startsWith("pasted-text-"));
    resend.catch(() => {});
    await page.locator("#btnSend").click();
    const resentResource = (await (await resend).json()).resource;
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.at(-1)?.text.startsWith("[[resource:"), "/assets/chat/state.js");
    expect(await resourceText(origin, info.roomId, resentResource.id)).toBe(pendingTyped);
    await tray.waitFor({ state: "hidden" });

    // A failed pasted-text upload is restored from storage after reload and retries successfully.
    let failOnce = true;
    await page.route("**/rooms/*/resources", async (route: BrowserRoute) => {
      if (failOnce && decodeURIComponent(route.request().headers()["x-file-name"] || "").startsWith("pasted-text-")) {
        failOnce = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary test failure" }) }); return;
      }
      await route.continue();
    });
    await input.fill("Durable draft stays");
    const failedText = "Recover this paste ".repeat(600);
    await paste(page, failedText);
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Upload failed"));
    const recoveredUpload = page.waitForResponse((response: any) => response.request().method() === "POST" && decodeURIComponent(response.request().headers()["x-file-name"] || "").startsWith("pasted-text-") && response.status() === 201);
    recoveredUpload.catch(() => {});
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction((draft: string) => (document.querySelector("#msgInput") as any).value === draft, "Durable draft stays");
    await page.waitForFunction(() => document.querySelectorAll("#attachmentList .attachment-item").length === 1 && document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    const recoveredResource = (await (await recoveredUpload).json()).resource;
    expect(await resourceText(origin, info.roomId, recoveredResource.id)).toBe(failedText);
    await page.locator("#attachmentList [data-upload-action=remove]").click();
    await input.fill(""); await page.unroute("**/rooms/*/resources");

    // Mixed pasted text and an image both survive reload while the uploads are pending.
    await input.fill("Mixed draft stays");
    const mixedText = "Mixed durable text ".repeat(500);
    let holdMixed = true, releaseMixed!: () => void, mixedStarted = 0, mixedBoth!: () => void;
    const mixedGate = new Promise<void>((resolve) => { releaseMixed = resolve; }), mixedReady = new Promise<void>((resolve) => { mixedBoth = resolve; });
    await page.route("**/rooms/*/resources", async (route: BrowserRoute) => {
      if (!holdMixed) return route.continue();
      mixedStarted++; if (mixedStarted >= 2) mixedBoth();
      await mixedGate; try { await route.continue(); } catch {}
    });
    await paste(page, mixedText, [{ name: "__Test_durable_mixed.png", type: "image/png", base64: png.toString("base64") }]);
    await mixedReady; await page.waitForTimeout(250);
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    await page.waitForFunction((draft: string) => (document.querySelector("#msgInput") as any).value === draft, "Mixed draft stays");
    holdMixed = false; releaseMixed(); await page.unroute("**/rooms/*/resources");
    await page.waitForFunction(() => {
      const items = document.querySelectorAll("#attachmentList .attachment-item"), details = document.querySelectorAll("#attachmentList .attachment-detail");
      return items.length === 2 && Array.from(details).every((node) => node.textContent?.includes("Ready to send"));
    });
    expect(await page.locator("#attachmentList .attachment-name").allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/^pasted-text-/), "__Test_durable_mixed.png"]));
    await page.locator("#attachmentList [data-upload-action=remove]").first().click();
    await page.locator("#attachmentList [data-upload-action=remove]").first().click();
    await input.fill("");
    expect(errors).toEqual([]);
  } finally {
    await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true });
  }
}, 120000);

test.skipIf(!browserModule)("oversized paste warns before unload when durable storage is unavailable", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href), stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-paste-quota-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (String(key).startsWith("chat.pendingText:")) throw new DOMException("Quota exceeded", "QuotaExceededError");
        return original.call(this, key, value);
      };
      IDBObjectStore.prototype.put = function () { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
    });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_QuotaOwner"); await page.locator("#inRoomName").fill("__Test_PasteQuota");
    await page.locator("#btnCreate").click(); await page.locator("#chatView").waitFor({ state: "visible" });
    await paste(page, "q".repeat(5001));
    await page.waitForFunction(() => document.querySelector("#attachmentVolatile")?.textContent?.includes("too large"));
    expect(await page.locator("#attachmentVolatile").getAttribute("class")).toContain("danger-text");
    expect(await page.locator("#attachmentStatus").textContent()).toContain("too large");
    expect(await page.evaluate(() => typeof window.onbeforeunload === "function")).toBe(true);
  } finally {
    await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

async function paste(page: any, text: string, files: Array<{ name: string; type: string; base64: string }> = []) {
  return page.evaluate((payload: { text: string; files: Array<{ name: string; type: string; base64: string }> }) => {
    const transfer = new DataTransfer();
    for (const descriptor of payload.files) {
      const bytes = Uint8Array.from(atob(descriptor.base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], descriptor.name, { type: descriptor.type }));
    }
    transfer.setData("text/plain", payload.text);
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    document.querySelector<HTMLElement>("#msgInput")!.dispatchEvent(event);
    return { prevented: event.defaultPrevented, status: document.querySelector("#attachmentStatus")?.textContent || "" };
  }, { text, files });
}

async function resourceText(origin: string, roomId: string, resourceId: string) {
  const response = await fetch(`${origin}/rooms/${encodeURIComponent(roomId)}/resources/${resourceId}/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`resource content failed (${response.status})`);
  return response.text();
}

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token, CHAT_ROOM_MAX_FILE_SIZE_MB: "1" };
}

async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}