import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { uploadAgentResource } from "./resource-upload";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-resource-integration-local-token";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WioAAAAASUVORK5CYII=", "base64");

test.skipIf(!browserModule)("agent uploads render and download real browser media", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-resource-integration-"));
  const artifacts = process.env.CHAT_UI_SCREENSHOT_DIR || dir;
  await mkdir(artifacts, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(dir, port), stdio: "ignore" });
  let browser: any, roomID = "", sessionID = "";
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ acceptDownloads: true });
    const resourceQueries: string[] = [];
    page.on("request", (request: any) => { if (request.url().includes("/resources/")) resourceQueries.push(new URL(request.url()).search); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Media tester");
    await page.locator("#inRoomName").fill("__Test_MediaIntegration");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const identity = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { roomID: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    roomID = identity.roomID; sessionID = identity.sessionID;
    const wav = makeWav();
    const uploadDir = await realpath(dir);
    const media = [{ name: "valid.png", bytes: png }, { name: "sample.wav", bytes: wav }];
    for (const file of media) await writeFile(path.join(dir, file.name), file.bytes);
    const webm = await makeWebm(page);
    if (webm) { media.push({ name: "sample.webm", bytes: Buffer.from(webm) }); await writeFile(path.join(dir, "sample.webm"), Buffer.from(webm)); }
    const resources: Array<{ id: string; name: string; bytes: Buffer }> = [];
    for (const file of media) {
      const permissions: string[] = [];
      const result = await uploadAgentResource({ center: origin, token }, roomID, file.name, identity.sessionID, {
        directory: uploadDir, worktree: uploadDir,
        ask: async (request) => { permissions.push(request.permission); },
      });
      expect(permissions).toEqual(["read"]);
      const marker = result.match(/\[\[resource:([\da-f-]+)\]\]/i);
      expect(marker).not.toBeNull();
      resources.push({ id: marker![1]!, name: file.name, bytes: file.bytes });
    }
    const text = resources.map((resource) => `[[resource:${resource.id}]]`).join(" ");
    const sent = await page.evaluate(async ({ url, id, sessionID, text }: any) => {
      const { app } = await import(url);
      return app.api(`/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ sessionID, text }) });
    }, { url: "/assets/chat/state.js", id: roomID, sessionID: identity.sessionID, text });
    expect(sent).toBeTruthy();
    for (const resource of resources) {
      const card = page.locator(`.chat-resource[data-resource-id="${resource.id}"]`);
      await card.getByText(resource.name).waitFor();
      const preview = card.getByRole("button", { name: /Preview/ });
      await preview.click();
      if (resource.name.endsWith(".png")) {
        const img = card.locator("img"); await img.waitFor();
        expect(await img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth === 1)).toBe(true);
      } else {
        const node = card.locator(resource.name.endsWith(".wav") ? "audio" : "video");
        await node.waitFor();
        await page.waitForFunction((selector: string) => (document.querySelector(selector) as HTMLMediaElement)?.readyState >= 1, `.${"chat-resource"}[data-resource-id="${resource.id}"] ${resource.name.endsWith(".wav") ? "audio" : "video"}`);
        expect(await node.evaluate((element: HTMLMediaElement) => element.readyState >= 1)).toBe(true);
      }
      expect(await page.evaluate((id: string) => Array.from(document.querySelectorAll(".chat-resource")).find((node) => node.getAttribute("data-resource-id") === id)?.textContent, resource.id)).toContain(resource.name);
      const downloadPromise = page.waitForEvent("download");
      await card.getByRole("button", { name: /Download/ }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(resource.name);
      const downloadPath = await download.path();
      expect(Buffer.compare(await Bun.file(downloadPath!).arrayBuffer().then(Buffer.from), resource.bytes)).toBe(0);
      await page.screenshot({ path: path.join(artifacts, `resource-${resource.name}.png`) });
    }
    expect(resourceQueries.length).toBeGreaterThan(0);
    expect(resourceQueries.every((query) => query === "")).toBe(true);
  } finally {
    if (roomID && sessionID) await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionID }) }).catch(() => {});
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

function makeWav() {
  const samples = 800, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI / 20) * 8000), 44 + i * 2);
  return bytes;
}

async function makeWebm(page: any): Promise<number[] | undefined> {
  return page.evaluate(async () => {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) return undefined;
    const canvas = document.createElement("canvas"); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext("2d")!, stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0]! as CanvasCaptureMediaStreamTrack, chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start(); context.fillStyle = "red"; context.fillRect(0, 0, 16, 16); track.requestFrame();
    await new Promise((resolve) => setTimeout(resolve, 150)); recorder.stop(); await done;
    stream.getTracks().forEach((item) => item.stop());
    return [...new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer())];
  });
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
