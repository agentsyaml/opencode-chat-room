/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Request as BrowserRequest, Route as BrowserRoute } from "playwright";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-attachment-test-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0HcAAAAASUVORK5CYII=", "base64");

test.skipIf(!browserModule)("attachments stage, upload, retry, and send as message resources", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href), stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-web-attachments-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin); browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    if (process.env.CHAT_UI_SCREENSHOT_DIR) await mkdir(process.env.CHAT_UI_SCREENSHOT_DIR, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage(), uploads: any[] = [], configHeaders: any[] = [];
    let configUnavailable = true;
    await page.route("**/resources/config", (route: BrowserRoute) => configUnavailable
      ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) })
      : route.fulfill({ contentType: "application/json", body: JSON.stringify({ maxFileSizeBytes: 2 * 1024 * 1024 }) }));
    page.on("request", (request: BrowserRequest) => { const url = new URL(request.url()); if (url.pathname === "/resources/config") configHeaders.push({ url: request.url(), headers: request.headers() }); if (request.method() === "POST" && /\/rooms\/[^/]+\/resources$/.test(url.pathname)) uploads.push({ url: request.url(), headers: request.headers() }); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`); await page.locator("#inName").fill("__Test_AttachmentOwner");
    await page.locator("#inRoomName").fill("__Test_AttachmentMain"); await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const info = await page.evaluate(async (url: string) => { const { app } = await import(url); return { roomId: app.state.room.id, sessionID: app.LS.sessionID }; }, "/assets/chat/state.js");
    expect(await page.locator("#attachmentPicker").getAttribute("accept")).toBeNull();
    expect(await page.locator("#attachmentPicker").evaluate((node: HTMLInputElement) => node.multiple)).toBe(true);
    expect(await page.locator("#btnAddAttachments").getAttribute("aria-label")).toBe("Add files");
    for (let index = 0; index < 20; index++) await api(origin, `/rooms/${info.roomId}/messages`, "POST", { sessionID: info.sessionID, text: `__Test_history_${index}\n${"Conversation line.\n".repeat(3)}` });
    await page.reload(); await page.locator("#msgList .msg").nth(19).waitFor();
    const thread = page.locator("#thread"), threadBox = await thread.boundingBox();
    await page.mouse.move(threadBox!.x + threadBox!.width / 2, threadBox!.y + threadBox!.height / 2); await page.mouse.wheel(0, -10000); await page.waitForTimeout(30); await page.mouse.wheel(0, 10000); await page.waitForTimeout(180);
    const initialGap = await thread.evaluate((node: HTMLElement) => node.scrollHeight - node.clientHeight - node.scrollTop);
    expect(Math.abs(initialGap)).toBeLessThan(1);
    await page.locator("#msgInput").fill("1\n2\n3\n4\n5");
    const inputGap = await thread.evaluate((node: HTMLElement) => node.scrollHeight - node.clientHeight - node.scrollTop);
    expect(Math.abs(inputGap)).toBeLessThan(1);
    await page.locator("#attachmentPicker").setInputFiles([
      { name: "__Test_note.txt", mimeType: "text/plain", buffer: Buffer.from("A staged note") },
      { name: "__Test_preview.png", mimeType: "image/png", buffer: png },
      { name: "__Test_vector.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>") },
      { name: "__Test_untrusted.html", mimeType: "text/html", buffer: Buffer.from("<script>alert(1)</script>") },
    ]);
    await page.waitForFunction(() => document.querySelectorAll("#attachmentList .attachment-item").length === 4 && Array.from(document.querySelectorAll("#attachmentList .attachment-detail")).every((node) => node.textContent?.includes("Ready to send")));
    expect(uploads.filter(({ headers }) => ["__Test_note.txt", "__Test_preview.png", "__Test_vector.svg", "__Test_untrusted.html"].includes(decodeURIComponent(headers["x-file-name"]))).length).toBe(4);
    configUnavailable = false;
    expect(await page.locator("#attachmentList img").count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const stagedLayout = await page.evaluate(() => { const thread = document.querySelector<HTMLElement>("#thread")!, input = document.querySelector<HTMLElement>("#msgInput")!; return { gap: thread.scrollHeight - thread.clientHeight - thread.scrollTop, inputFits: input.scrollHeight <= input.clientHeight }; });
    expect(Math.abs(stagedLayout.gap)).toBeLessThan(1); expect(stagedLayout.inputFits).toBe(true);
    if (process.env.CHAT_UI_SCREENSHOT_DIR) await writeFile(path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "chat-attachments-metrics.json"), JSON.stringify({ viewport: [390, 844], initialBottomGap: initialGap, fiveLineInputBottomGap: inputGap, stagedTrayBottomGap: stagedLayout.gap, fiveLineInputFits: stagedLayout.inputFits }, null, 2));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#chatView")!).opacity === "1");
    if (process.env.CHAT_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "chat-attachments-staged-mobile.png"), fullPage: true });
    await page.locator("#msgInput").fill("x".repeat(2000)); expect(await page.locator("#btnSend").isDisabled()).toBe(true);
    expect(Number((await page.locator("#draftCount").textContent())!.split(" /")[0])).toBeGreaterThan(2000);
    await page.locator("#msgInput").fill("__Test_caption"); await page.locator("#questionToggle").check();
    await page.locator("#btnRoomsDrawer").click(); await page.locator("#btnNewRoom").click();
    await page.locator("#inRoomNameChat").fill("__Test_AttachmentSecond"); await page.locator("#btnCreateChatRoom").click();
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_AttachmentSecond");
    expect(await page.locator("#attachmentList .attachment-item").count()).toBe(0);
    if (!(await page.locator("#roomRail").evaluate((rail: HTMLElement) => rail.classList.contains("drawer-open")))) await page.locator("#btnRoomsDrawer").click();
    await page.locator(`#roomListChat [data-room-id="${info.roomId}"]`).click(); await page.waitForFunction((id: string) => document.querySelector<HTMLElement>("#btnCopyId")?.title.endsWith(id), info.roomId);
    expect(await page.locator("#attachmentList .attachment-item").count()).toBe(4);
    let releaseSend!: () => void, sendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; }), sendRequest = new Promise<void>((resolve) => { sendStarted = resolve; }), messagePattern = `**/rooms/${info.roomId}/messages`;
    expect(await page.locator("#btnSend").isEnabled()).toBe(true);
    await page.route(messagePattern, async (route: BrowserRoute) => { if (route.request().method() === "POST" && route.request().postDataJSON()?.text.startsWith("__Test_caption")) { sendStarted(); await sendGate; } await route.continue(); });
    await page.locator("#btnSend").click(); await sendRequest;
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_during_send.txt", mimeType: "text/plain", buffer: Buffer.from("Next draft file") });
    await page.waitForFunction(() => document.querySelectorAll("#attachmentList .attachment-item").length === 5 && Array.from(document.querySelectorAll("#attachmentList .attachment-detail")).every((node) => node.textContent?.includes("Ready to send")));
    await page.locator("#msgInput").fill("__Test_next_draft"); releaseSend();
    await page.locator("#msgList").getByText("__Test_caption").waitFor(); await page.unroute(messagePattern);
    expect(await page.locator("#msgInput").evaluate((node: any) => node.value)).toBe("__Test_next_draft");
    await page.waitForFunction(() => document.querySelectorAll("#attachmentList .attachment-item").length === 1 && document.querySelector("#attachmentList .attachment-name")?.textContent === "__Test_during_send.txt");
    const firstMessage = (await api(origin, `/rooms/${info.roomId}`)).messages.find((message: any) => message.text.startsWith("__Test_caption"));
    expect(firstMessage.isQuestion).toBe(true);
    expect((firstMessage.text.match(/\[\[resource:/g) || []).length).toBe(4);
    await page.waitForFunction(() => document.querySelectorAll("#msgList .chat-resource").length === 4);
    expect(await page.locator("#msgList .chat-resource").count()).toBe(4);
    for (const name of ["__Test_vector.svg", "__Test_untrusted.html"]) expect(await page.locator("#msgList .chat-resource").filter({ hasText: name }).locator("button").count()).toBe(1);
    await page.locator("#msgInput").fill(""); await page.locator("#questionToggle").uncheck();
    expect(await page.locator("#btnSend").isEnabled()).toBe(true); await page.locator("#btnSend").click();
    await page.locator("#attachmentTray").waitFor({ state: "hidden" });
    const attachmentOnly = (await api(origin, `/rooms/${info.roomId}`)).messages.at(-1);
    expect(attachmentOnly.text).toMatch(/^\[\[resource:[\da-f-]{36}\]\]$/); expect(Boolean(attachmentOnly.isQuestion)).toBe(false);
    expect(await page.locator("#attachmentTray").isHidden()).toBe(true);
    const scroll = await page.locator("#thread").boundingBox(); await page.mouse.move(scroll!.x + 20, scroll!.y + 40); await page.mouse.wheel(0, -600); await page.waitForTimeout(50);
    const anchorBefore = await visibleAnchor(page); expect(anchorBefore.gap).toBeGreaterThan(1);
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_anchor.txt", mimeType: "text/plain", buffer: Buffer.from("Preserve this reading point") });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const anchorAfter = await visibleAnchor(page); expect(anchorAfter.id).toBe(anchorBefore.id); expect(Math.abs(anchorAfter.top - anchorBefore.top)).toBeLessThan(2); expect(anchorAfter.gap).toBeGreaterThan(1);
    await page.locator("#msgInput").fill(""); await page.locator("#btnSend").click(); await page.locator("#attachmentTray").waitFor({ state: "hidden" });
    const pastedTextAllowed = await page.evaluate((base64: string) => {
      const transfer = new DataTransfer(), bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], "__Test_clipboard.png", { type: "image/png", lastModified: 123 });
      transfer.items.add(file); transfer.setData("text/plain", "Clipboard caption");
      const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
      document.querySelector<HTMLElement>("#msgInput")!.dispatchEvent(event); return !event.defaultPrevented;
    }, png.toString("base64"));
    expect(pastedTextAllowed).toBe(true);
    await page.waitForFunction(() => document.querySelectorAll("#attachmentList .attachment-item").length === 1 && document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    expect(uploads.filter((request) => decodeURIComponent(request.headers["x-file-name"]) === "__Test_clipboard.png")).toHaveLength(1);
    expect(await page.locator("#attachmentList img").count()).toBe(1); await page.locator("#msgInput").fill("Clipboard caption");
    await page.locator("#btnSend").click(); await page.locator("#msgList").getByText("Clipboard caption").waitFor();
    const clipboardMessage = (await api(origin, `/rooms/${info.roomId}`)).messages.at(-1);
    expect(clipboardMessage.text).toMatch(/^Clipboard caption\n\n\[\[resource:[\da-f-]{36}\]\]$/);
    const drop = await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(["dropped"], "__Test_drop.txt", { type: "text/plain" }));
      const target = document.querySelector("#chatView")!, enter = new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(enter); const visible = !(document.querySelector<HTMLElement>("#attachmentDropOverlay")!).hidden;
      const event = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }); target.dispatchEvent(event);
      return { visible, prevented: event.defaultPrevented, hidden: (document.querySelector<HTMLElement>("#attachmentDropOverlay")!).hidden };
    });
    expect(drop).toEqual({ visible: true, prevented: true, hidden: true });
    expect(await page.locator("#attachmentDropOverlay").getAttribute("role")).toBe("status");
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    await page.locator("#btnSend").click(); await page.locator("#attachmentTray").waitFor({ state: "hidden" });
    expect((await api(origin, `/rooms/${info.roomId}`)).messages.at(-1).text).toMatch(/^\[\[resource:[\da-f-]{36}\]\]$/);
    const uploadsBeforeRetry = uploads.length; let failedOnce = false, releaseFailure!: () => void, failureStarted!: () => void;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; }), failureRequest = new Promise<void>((resolve) => { failureStarted = resolve; });
    await page.route(messagePattern, async (route: BrowserRoute) => {
      if (!failedOnce && route.request().method() === "POST" && route.request().postDataJSON()?.text.startsWith("__Test_retry_caption")) { failedOnce = true; failureStarted(); await failureGate; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary test failure" }) }); }
      else await route.continue();
    });
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_retry.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    await page.locator("#questionToggle").check(); await page.locator("#msgInput").fill("__Test_retry_caption"); await page.locator("#btnSend").click(); await failureRequest;
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_next_after_failure.txt", mimeType: "text/plain", buffer: Buffer.from("Next draft") });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("Ready to send"));
    await page.locator("#msgInput").fill("__Test_next_caption"); releaseFailure(); await page.locator(".failed-message").waitFor();
    const failedText = await page.locator(".failed-message p").textContent(); expect(failedText).toContain("[[resource:");
    expect(await page.locator("#attachmentList .attachment-name").filter({ hasText: "__Test_next_after_failure.txt" }).textContent()).toBe("__Test_next_after_failure.txt");
    expect(await page.locator("#msgInput").evaluate((node: any) => node.value)).toBe("__Test_next_caption");
    expect(await page.locator("#attachmentList .attachment-item").filter({ hasText: "__Test_next_after_failure.txt" }).locator("[data-upload-action=remove]").isVisible()).toBe(true);
    await page.unroute(messagePattern); await page.locator(".failed-message [data-failed-action=retry]").click();
    await page.locator("#msgList").getByText("__Test_retry_caption").waitFor(); await page.locator(".failed-message").waitFor({ state: "hidden" });
    const retried = (await api(origin, `/rooms/${info.roomId}`)).messages.at(-1);
    expect(retried.text).toBe(failedText); expect(retried.isQuestion).toBe(true);
    expect(uploads.length).toBe(uploadsBeforeRetry + 2);
    await setLocaleThroughProfile(page, "zh-CN");
    expect(await page.locator("#attachmentList .attachment-detail").first().textContent()).toContain("可以发送");
    expect(await page.locator("#attachmentList [data-upload-action=remove]").first().textContent()).toBe("移除");
    await setLocaleThroughProfile(page, "en");
    expect(await page.locator("#attachmentList .attachment-detail").first().textContent()).toContain("Ready to send");
    await page.locator("#questionToggle").uncheck();
    await page.locator("#btnSend").click(); await page.locator("#msgList").getByText("__Test_next_caption").waitFor();
    const nextText = (await api(origin, `/rooms/${info.roomId}`)).messages.at(-1).text;
    expect(nextText).toContain("__Test_next_caption"); expect(nextText).not.toContain(failedText.match(/\[\[resource:[^\]]+/)?.[0] || "missing-resource");
    await page.unroute("**/resources/config");
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_over_limit.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024 * 1024 + 1) });
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("current size limit"));
    expect(await page.locator("#btnSend").isDisabled()).toBe(true);
    const overLimitRequests = uploads.filter((request) => decodeURIComponent(request.headers["x-file-name"]) === "__Test_over_limit.bin");
    expect(overLimitRequests).toHaveLength(1); const configCountBeforeRetry = configHeaders.length;
    await page.locator("#attachmentList [data-upload-action=retry]").click();
    await page.waitForFunction(() => document.querySelector("#attachmentList .attachment-detail")?.textContent?.includes("current size limit"));
    expect(configHeaders.length).toBeGreaterThan(configCountBeforeRetry);
    expect(uploads.filter((request) => decodeURIComponent(request.headers["x-file-name"]) === "__Test_over_limit.bin")).toHaveLength(1);
    await setLocaleThroughProfile(page, "zh-CN");
    expect(await page.locator("#attachmentList .attachment-detail").first().textContent()).toContain("当前大小限制");
    expect(await page.locator("#attachmentList [data-upload-action=retry]").textContent()).toBe("重试");
    await setLocaleThroughProfile(page, "en");
    expect(await page.locator("#attachmentList .attachment-detail").first().textContent()).toContain("current size limit");
    await page.locator("#attachmentList [data-upload-action=remove]").click(); await page.locator("#attachmentTray").waitFor({ state: "hidden" });
    await page.evaluate(() => { const revoke = URL.revokeObjectURL.bind(URL); (window as any).__revokedFiles = []; URL.revokeObjectURL = (url: string) => { (window as any).__revokedFiles.push(url); revoke(url); }; });
    const uploadPattern = `**/rooms/${info.roomId}/resources`;
    let releaseCancel!: () => void, cancelStarted!: () => void;
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; }), cancelRequest = new Promise<void>((resolve) => { cancelStarted = resolve; });
    await page.route(uploadPattern, async (route: BrowserRoute) => { if (decodeURIComponent(route.request().headers()["x-file-name"] || "") === "__Test_cancel.bin") { cancelStarted(); await cancelGate; try { await route.abort(); } catch {} } else await route.continue(); });
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_cancel.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(512 * 1024) }); await cancelRequest;
    await page.locator("#attachmentList progress").waitFor({ state: "visible" });
    expect(await page.locator("#attachmentList progress").getAttribute("aria-label")).toContain("Uploading");
    expect(await page.locator("#btnSend").isDisabled()).toBe(true);
    await page.locator("#attachmentList [data-upload-action=remove]").click(); await page.locator("#attachmentTray").waitFor({ state: "hidden" }); releaseCancel();
    await page.waitForTimeout(50); await page.unroute(uploadPattern);
    let releaseLeave!: () => void, leaveStarted!: () => void;
    const leaveGate = new Promise<void>((resolve) => { releaseLeave = resolve; }), leaveRequest = new Promise<void>((resolve) => { leaveStarted = resolve; });
    await page.route(uploadPattern, async (route: BrowserRoute) => { if (decodeURIComponent(route.request().headers()["x-file-name"] || "") === "__Test_leave.png") { leaveStarted(); await leaveGate; try { await route.abort(); } catch {} } else await route.continue(); });
    await page.locator("#attachmentPicker").setInputFiles({ name: "__Test_leave.png", mimeType: "image/png", buffer: png }); await leaveRequest;
    await page.locator("#btnRoomOptions").click(); await page.locator("#btnLeave").click();
    await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_AttachmentSecond"); releaseLeave();
    await page.waitForTimeout(50); await page.unroute(uploadPattern);
    expect(await page.locator("#attachmentList .attachment-item").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__revokedFiles.length)).toBeGreaterThan(0);
    expect(configHeaders.length).toBeGreaterThan(0);
    expect(configHeaders.every(({ url, headers }) => new URL(url).search === "" && headers.authorization === `Bearer ${token}` && !headers["x-chat-admin-token"])).toBe(true);
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every(({ url, headers }) => new URL(url).search === "" && headers.authorization === `Bearer ${token}` && headers["x-session-id"] === info.sessionID && !headers["x-chat-admin-token"] && headers["content-type"] === "application/octet-stream")).toBe(true);
    await context.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); await rm(stateDir, { recursive: true, force: true });
  }
}, 120000);

async function setLocaleThroughProfile(page: any, locale: string) {
  const drawer = page.locator("#btnRoomsDrawer"), rail = page.locator("#roomRail"), trigger = page.locator("#btnSettings");
  if (!(await trigger.isVisible())) { await drawer.click(); await rail.waitFor({ state: "visible" }); }
  await trigger.click(); await page.locator("#chatSettings").waitFor({ state: "visible" });
  await page.locator("#localeSelectSettings").selectOption(locale); await trigger.click(); await page.locator("#chatSettings").waitFor({ state: "hidden" });
  if (await drawer.getAttribute("aria-expanded") === "true") { await page.keyboard.press("Escape"); await rail.waitFor({ state: "hidden" }); }
}

async function visibleAnchor(page: any) {
  return page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>("#thread")!, top = thread.getBoundingClientRect().top + thread.clientTop;
    const row = Array.from(thread.querySelectorAll<HTMLElement>("#msgList .msg")).find((item) => item.getBoundingClientRect().bottom > top)!;
    return { id: row.dataset.msgId, top: row.getBoundingClientRect().top, gap: thread.scrollHeight - thread.clientHeight - thread.scrollTop };
  });
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
