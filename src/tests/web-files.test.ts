/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-files-token";
const PNG = await readFile(path.join(process.cwd(), "server/assets/icons/icon-192.png"));

test.skipIf(!browserModule)("the room file browser filters, previews, downloads, and deletes by permission", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-files-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await import("node:fs/promises").then(({ mkdir }) => mkdir(screenshotDir, { recursive: true }));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any, agentContext: any;
  const pageErrors: string[] = [], nativeDialogs: string[] = [];
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("dialog", (dialog: any) => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_FilesOwner");
    await page.locator("#inRoomName").fill("__Test_FilesRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    const ownerSession = await page.evaluate(async (url: string) => (await import(url)).app.LS.sessionID, "/assets/chat/state.js");

    // Two people upload three files through the public resource API.
    const agentSession = randomUUID();
    const joined = await fetch(`${origin}/rooms/${roomId}/join`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: agentSession, participantId: "__Test_FilesAgent", participantName: "__Test_FilesAgent", protocol: "v2", receiverOwnerID: randomUUID() }),
    });
    expect(joined.status).toBe(201);
    await uploadResource(origin, roomId, ownerSession, "__Test_notes.txt", Buffer.from("notes for the room"));
    await uploadResource(origin, roomId, ownerSession, "__Test_diagram.png", PNG);
    await uploadResource(origin, roomId, agentSession, "__Test_agent-log.txt", Buffer.from("agent log"));

    const initial = await listResources(origin, roomId, ownerSession);
    expect(initial.total).toBe(3);

    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnFiles").click();
    await page.locator("#filesDialog[open]").waitFor();
    await page.waitForFunction(() => document.querySelectorAll("#fileList .file-row").length === 3);
    const rows = page.locator("#fileList .file-row");
    expect((await rows.locator(".file-name").allTextContents()).sort()).toEqual([
      "__Test_agent-log.txt", "__Test_diagram.png", "__Test_notes.txt",
    ]);
    expect(await rows.locator(".file-uploader").allTextContents()).toContain("__Test_FilesOwner");
    expect(await rows.locator(".file-uploader").allTextContents()).toContain("__Test_FilesAgent");
    for (const date of await rows.locator(".file-date").allTextContents()) expect(date).toMatch(/\d/);
    expect(await page.locator("#filesSummary").textContent()).toContain("3 files");
    expect(await page.locator('#fileList [data-file-action="delete"]').count()).toBe(3);
    // Icon-only row actions stay accessible and keep the 34px square target.
    for (const action of ["preview", "download", "delete"] as const) {
      const control = page.locator(`#fileList [data-file-action="${action}"]`).first();
      const label = { preview: "Preview", download: "Download", delete: "Delete" }[action];
      expect(await control.locator("svg.fluent-icon").count()).toBe(1);
      expect(await control.getAttribute("aria-label")).toContain(label);
      const box = (await control.boundingBox())!;
      expect(Math.abs(box.height - 34)).toBeLessThanOrEqual(2);
    }
    // Icons inherit the themed text color instead of carrying their own palette.
    const themed = await page.evaluate(() => {
      const svg = document.querySelector<SVGElement>('#fileList [data-file-action="download"] svg')!;
      const button = svg.closest("button")!, root = document.documentElement, previous = root.dataset.theme;
      const values = ["light", "dark"].map((theme) => {
        root.dataset.theme = theme;
        return { fill: getComputedStyle(svg).fill, color: getComputedStyle(button).color };
      });
      if (previous === undefined) delete root.dataset.theme; else root.dataset.theme = previous;
      return values;
    });
    for (const value of themed) expect(value.fill).toBe(value.color);
    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.evaluate(() => {
      const svg = document.querySelector<SVGElement>('#fileList [data-file-action="download"] svg')!;
      return getComputedStyle(svg).fill === getComputedStyle(svg.closest("button")!).color;
    })).toBe(true);
    await page.emulateMedia({ forcedColors: "none" });
    const filters = await page.locator("#filesUploader option").allTextContents();
    expect(filters).toEqual(expect.arrayContaining(["Everyone", "__Test_FilesOwner", "__Test_FilesAgent"]));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "web-files-desktop-1280.png") });

    // The uploader filter narrows rows to one person's files.
    await page.locator("#filesUploader").selectOption({ label: "__Test_FilesOwner" });
    expect(await page.locator("#fileList .file-row").count()).toBe(2);
    expect(await page.locator("#filesSummary").textContent()).toContain("2 files");
    await page.locator("#filesUploader").selectOption({ label: "__Test_FilesAgent" });
    expect(await page.locator("#fileList .file-row").count()).toBe(1);
    expect(await page.locator("#fileList .file-name").textContent()).toBe("__Test_agent-log.txt");
    await page.locator("#filesUploader").selectOption("all");

    // Preview uses a fetched object URL and stays inside the row.
    const imageRow = page.locator("#fileList .file-row").filter({ hasText: "__Test_diagram.png" });
    await imageRow.locator('[data-file-action="preview"]').click();
    const previewImage = imageRow.locator("img.file-preview-media");
    await previewImage.waitFor();
    expect(await previewImage.getAttribute("src")).toMatch(/^blob:/);
    await page.waitForFunction(() => (document.querySelector("#fileList .file-row img.file-preview-media") as HTMLImageElement | null)?.naturalWidth === 192);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "web-files-desktop-preview-1280.png") });
    await imageRow.locator('[data-file-action="preview"]').click();

    // Download runs from a blob URL and keeps the original name.
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#fileList .file-row").filter({ hasText: "__Test_notes.txt" }).locator('[data-file-action="download"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("__Test_notes.txt");

    // 390px keeps the browser and every row inside the dialog.
    await page.setViewportSize({ width: 390, height: 740 });
    const mobile = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#filesDialog")!;
      const scroll = dialog.querySelector<HTMLElement>(".files-scroll")!;
      const box = dialog.getBoundingClientRect();
      const rows = Array.from(dialog.querySelectorAll<HTMLElement>(".file-row")).map((row) => {
        const rect = row.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        pageOverflow: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
        scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
        dialog: { left: box.left, right: box.right },
        rows,
      };
    });
    expect(mobile.pageOverflow).toBe(0);
    expect(mobile.dialogOverflow).toBe(0);
    expect(mobile.scrollOverflow).toBe(0);
    for (const row of mobile.rows) {
      expect(row.left).toBeGreaterThanOrEqual(mobile.dialog.left - 0.5);
      expect(row.right).toBeLessThanOrEqual(mobile.dialog.right + 0.5);
    }
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "web-files-mobile-390.png") });
    await page.keyboard.press("Escape");
    await page.locator("#filesDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    await page.setViewportSize({ width: 1280, height: 850 });

    // The human owner deletes through the in-app confirmation only.
    await page.locator("#btnRoomOptions").click();
    await page.locator("#btnFiles").click();
    await page.waitForFunction(() => document.querySelectorAll("#fileList .file-row").length === 3);
    await page.locator("#fileList .file-row").filter({ hasText: "__Test_notes.txt" }).locator('[data-file-action="delete"]').click();
    await page.locator("#confirmDialog[open]").waitFor();
    expect(await page.locator("#confirmMessage").textContent()).toContain("__Test_notes.txt");
    await page.locator("#btnAcceptConfirm").click();
    await page.locator("#confirmDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelectorAll("#fileList .file-row").length === 2);
    expect(await page.locator("#fileList .file-row").filter({ hasText: "__Test_notes.txt" }).count()).toBe(0);
    expect((await listResources(origin, roomId, ownerSession)).total).toBe(2);
    await page.mouse.click(4, 4);
    await page.locator("#filesDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");

    // An agent viewer only sees Delete on its own upload.
    agentContext = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const agentPage = await agentContext.newPage();
    agentPage.setDefaultTimeout(15000);
    agentPage.on("pageerror", (error: Error) => pageErrors.push(error.message));
    agentPage.on("dialog", (dialog: any) => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    await agentPage.addInitScript((identity: { token: string; sessionID: string; name: string; roomId: string }) => {
      localStorage.setItem("chat.token", identity.token);
      localStorage.setItem("chat.browserIdentity", JSON.stringify({ sessionID: identity.sessionID, name: identity.name }));
      sessionStorage.setItem("chat.roomId", identity.roomId);
      sessionStorage.setItem("chat.joinedRoomIds", JSON.stringify([identity.roomId]));
    }, { token, sessionID: agentSession, name: "__Test_FilesAgent", roomId });
    await agentPage.goto(`${origin}/chat`);
    await agentPage.locator("#chatView").waitFor({ state: "visible" });
    await agentPage.waitForFunction(() => document.querySelector("#roomName")?.textContent === "__Test_FilesRoom");
    let selfType = "";
    for (let attempt = 0; attempt < 100 && selfType !== "agent"; attempt++) {
      selfType = await agentPage.evaluate(async ({ url, roomId, sessionID }: { url: string; roomId: string; sessionID: string }) => {
        const { app } = await import(url);
        return app.state.memberSessions.get(roomId)?.find((member: { sessionID: string }) => member.sessionID === sessionID)?.type || "";
      }, { url: "/assets/chat/state.js", roomId, sessionID: agentSession });
      if (selfType !== "agent") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(selfType).toBe("agent");
    await agentPage.locator("#btnRoomOptions").click();
    await agentPage.locator("#btnFiles").click();
    await agentPage.locator("#filesDialog[open]").waitFor();
    await agentPage.waitForFunction(() => document.querySelectorAll("#fileList .file-row").length === 2);
    const agentDelete = agentPage.locator('#fileList [data-file-action="delete"]');
    expect(await agentDelete.count()).toBe(1);
    const ownRow = agentPage.locator("#fileList .file-row").filter({ hasText: "__Test_agent-log.txt" });
    expect(await ownRow.locator('[data-file-action="delete"]').count()).toBe(1);
    const ownerRow = agentPage.locator("#fileList .file-row").filter({ hasText: "__Test_diagram.png" });
    expect(await ownerRow.locator('[data-file-action="delete"]').count()).toBe(0);
    await ownRow.locator('[data-file-action="delete"]').click();
    await agentPage.locator("#confirmDialog[open]").waitFor();
    await agentPage.locator("#btnAcceptConfirm").click();
    await agentPage.locator("#confirmDialog").waitFor({ state: "hidden" });
    await agentPage.waitForFunction(() => document.querySelectorAll("#fileList .file-row").length === 1);
    expect((await listResources(origin, roomId, ownerSession)).total).toBe(1);

    expect(nativeDialogs).toEqual([]);
    expect(pageErrors).toEqual([]);
    await agentContext.close();
  } finally {
    await agentContext?.close();
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 150000);

async function uploadResource(origin: string, roomId: string, sessionID: string, name: string, body: Buffer) {
  const response = await fetch(`${origin}/rooms/${roomId}/resources`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-Session-ID": sessionID,
      "X-File-Name": encodeURIComponent(name),
      "X-Resource-ID": randomUUID(),
    },
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });
  expect(response.status).toBe(201);
  return (await response.json()).resource;
}

async function listResources(origin: string, roomId: string, sessionID: string) {
  const response = await fetch(`${origin}/rooms/${roomId}/resources?limit=500&offset=0`, {
    headers: { Authorization: `Bearer ${token}`, "x-session-id": sessionID },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ resources: unknown[]; total: number }>;
}

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