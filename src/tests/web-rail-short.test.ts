import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-rail-short-token";

// Short windows must keep the rail inside the workspace instead of letting
// room content push it past the viewport.
test.skipIf(!browserModule)("the rail stays usable in short windows", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-rail-short-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Rail tester");
    await page.locator("#inRoomName").fill("Rail room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const ownerSession = await page.evaluate(() => sessionStorage.getItem("chat.sessionID")) as string;
    expect(ownerSession).toBeTruthy();
    const protectedRoom = await page.evaluate(async ({ origin, token, ownerSession }: { origin: string; token: string; ownerSession: string }) => {
      const response = await fetch(`${origin}/rooms`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Protected rail", ownerId: "Rail tester", joinPolicy: "approval", sessionID: ownerSession }),
      });
      return response.json() as Promise<{ id: string }>;
    }, { origin, token, ownerSession });
    expect(protectedRoom.id).toBeTruthy();

    const profile = await profileMetrics(page);
    for (const height of [250, 220, 180, 160]) {
      await expectRailFits(page, height);
      expect(await profileMetrics(page)).toEqual(profile);
    }

    // Mac's screenshot had a live approval request while another room stayed open.
    const peerContext = await browser.newContext({ viewport: { width: 1418, height: 850 } });
    const peer = await peerContext.newPage();
    await peer.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await peer.goto(`${origin}/chat`);
    await peer.locator("#inName").fill("Peer rail");
    await peer.locator("#roomList .room-row", { hasText: "Rail room" }).click();
    await peer.locator("#chatView").waitFor({ state: "visible" });
    await peer.locator("#roomListChat .room-row", { hasText: "Protected rail" }).click();
    await peer.locator("#confirmDialog").waitFor({ state: "visible" });
    await peer.locator("#btnAcceptConfirm").click();
    await peer.locator("#joinNotice").waitFor({ state: "visible" });
    expect(await peer.locator("#joinNoticeText").textContent()).toContain("Request sent");
    const peerProfile = await profileMetrics(peer);
    // Pending approval keeps a full notice; the compact tiers cover it only while
    // the notice and composer can both fit.
    for (const height of [250]) {
      await expectRailFits(peer, height);
      expect(await profileMetrics(peer)).toEqual(peerProfile);
    }
    await peerContext.close();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function expectRailFits(page: any, height: number) {
  await page.setViewportSize({ width: 1418, height });
  await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) - innerHeight) < 1);
  await page.locator("#msgInput").click();
  await page.waitForTimeout(80);
  const metrics = await page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)!;
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
    };
    return {
      viewport: innerHeight,
      doc: { scrollHeight: document.scrollingElement!.scrollHeight, clientHeight: document.scrollingElement!.clientHeight, scrollWidth: document.scrollingElement!.scrollWidth, clientWidth: document.scrollingElement!.clientWidth, scrollTop: document.scrollingElement!.scrollTop },
      rail: box("#roomRail"),
      rooms: box("#roomListChat"),
      row: box("#roomListChat .room-row"),
      foot: box(".rail-foot"),
      profile: box("#btnSettings"),
      composer: box(".composer"),
      notice: document.querySelector("#joinNotice")?.getBoundingClientRect().height ?? 0,
    };
  });
  const detail = `height ${height}: ${JSON.stringify(metrics)}`;
  expect(metrics.doc.scrollHeight, detail).toBe(metrics.doc.clientHeight);
  expect(metrics.doc.scrollWidth, detail).toBe(metrics.doc.clientWidth);
  expect(metrics.doc.scrollTop, detail).toBe(0);
  expect(metrics.rail.top, detail).toBeGreaterThanOrEqual(0);
  expect(metrics.rail.bottom, detail).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.row.top).toBeGreaterThanOrEqual(metrics.rooms.top - 1);
  expect(metrics.row.bottom).toBeLessThanOrEqual(metrics.rooms.bottom + 1);
  expect(metrics.row.height).toBeGreaterThanOrEqual(30);
  expect(metrics.foot.top).toBeGreaterThanOrEqual(metrics.rooms.bottom - 1);
  expect(metrics.profile.bottom).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.composer.left).toBeGreaterThanOrEqual(metrics.rail.right - 1);
  // The rail's identity divider follows the composer's divider while no notice is open.
  if (!metrics.notice) expect(Math.abs(metrics.foot.top - metrics.composer.top), detail).toBeLessThanOrEqual(1.5);
  expect(await page.locator("#btnShortcuts").isVisible()).toBe(true);
  if (height <= 400) {
    const placeholder = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement>("#msgInput")!;
      const before = getComputedStyle(input, "::before");
      return { input: input.getBoundingClientRect().height, top: parseFloat(before.top), line: parseFloat(before.lineHeight) };
    });
    expect(Math.abs(placeholder.top + placeholder.line / 2 - placeholder.input / 2), JSON.stringify(placeholder)).toBeLessThanOrEqual(1.5);
  }
  return metrics.notice;
}
async function profileMetrics(page: any) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 };
    };
    return { trigger: box("#btnSettings"), avatar: box("#btnSettings .rail-avatar") };
  });
}

async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env }; for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function waitForServer(origin: string) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/chat`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Local isolated chat server did not start");
}