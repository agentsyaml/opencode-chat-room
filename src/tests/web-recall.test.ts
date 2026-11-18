import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-recall-local-token";

test.skipIf(!browserModule)("authors and human admins recall messages and members reveal the original", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-recall-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(12000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Recall tester");
    await page.locator("#inRoomName").fill("Recall room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    const sessionID = await page.evaluate(async (url: string) => (await import(url)).app.LS.sessionID, "/assets/chat/state.js");

    const recalledAt = Date.now() + 5, recallPosts: any[] = [], contentRequests: string[] = [];
    await page.route("**/rooms/*/messages/*/recall", async (route: any) => {
      recallPosts.push(JSON.parse(route.request().postData() || "{}"));
      const messageID = new URL(route.request().url()).pathname.split("/").at(-2);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, messageID, recalledAt, recalledBy: "Recall tester" }) });
    });
    await page.route("**/rooms/*/messages/*/content*", async (route: any) => {
      contentRequests.push(route.request().url());
      const messageID = new URL(route.request().url()).pathname.split("/").at(-2);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messageID, text: "Original **hidden** text", senderId: "Recall tester", createdAt: recalledAt, recalledAt }) });
    });
    // Own message: recall from the row actions.
    await page.locator("#msgInput").fill("Recall me please");
    await page.locator("#btnSend").click();
    const ownRow = page.locator("#msgList [data-msg-id]").filter({ hasText: "Recall me please" }).last();
    await ownRow.waitFor();
    const ownID = await ownRow.getAttribute("data-msg-id");
    const row = page.locator(`#msgList [data-msg-id="${ownID}"]`);
    const recallButton = row.locator(".message-recall");
    await recallButton.waitFor();
    await recallButton.click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    expect(await page.locator("#confirmMessage").textContent()).toContain("Recall this message");
    await page.locator("#btnAcceptConfirm").click();
    await row.locator(".recalled-note").waitFor();
    expect(recallPosts).toEqual([{ sessionID }]);
    expect((await row.locator(".recalled-note").textContent())?.trim()).toBe("Message recalled");
    expect(await row.locator(".message-copy").count()).toBe(0);
    expect(await row.locator(".message-readers").count()).toBe(0);
    expect(await row.locator(".recalled-by").count()).toBe(0);
    await page.waitForFunction((id: string) => document.querySelector(`#roomListChat [data-room-id="${CSS.escape(id)}"] .r-preview`)?.textContent === "Message recalled", roomId);

    // Members reveal the original on demand, then hide it without another request.
    const reveal = row.locator(".recalled-reveal");
    expect(await reveal.getAttribute("aria-expanded")).toBe("false");
    await reveal.click();
    await row.locator(".recalled-body").waitFor({ state: "visible" });
    expect((await row.locator(".recalled-body").textContent())?.trim()).toBe("Original hidden text");
    expect(await reveal.getAttribute("aria-expanded")).toBe("true");
    expect((await reveal.textContent())?.trim()).toBe("Hide original");
    await reveal.click();
    await row.locator(".recalled-body").waitFor({ state: "hidden" });
    expect(contentRequests.length).toBe(1);
    await reveal.click();
    await row.locator(".recalled-body").waitFor({ state: "visible" });
    expect(contentRequests.length).toBe(1);

    // The control stays tappable at phone width.
    await page.setViewportSize({ width: 360, height: 720 });
    await reveal.scrollIntoViewIfNeeded();
    const box = await reveal.boundingBox();
    if (!box) throw new Error("recall reveal control is not visible");
    expect(box.height).toBeGreaterThanOrEqual(32);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await page.setViewportSize({ width: 1280, height: 850 });

    // A human room administrator recalls someone else's message. The peer row is
    // inserted directly so this UI test does not depend on the join endpoint.
    const database = new Database(path.join(stateDir, "chat-room.sqlite"));
    database.exec("PRAGMA busy_timeout=5000");
    const peerID = randomUUID();
    const latest = database.query("SELECT max(created_at) AS ts FROM messages WHERE room_id=?").get(roomId) as { ts: number | null };
    database.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question) VALUES(?,?,?,?,?,?,0)")
      .run(peerID, roomId, "Peer", "recall-peer", "Peer message", Math.max(Date.now(), (latest?.ts ?? 0) + 1));
    database.close();
    const peerRow = page.locator(`#msgList [data-msg-id="${peerID}"]`);
    await peerRow.waitFor();
    const peerRecall = peerRow.locator(".message-recall");
    await peerRecall.waitFor();
    // A plain member gets no control on somebody else's message.
    const gated = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      const name = app.state.myName;
      app.state.myName = "Guest";
      app.rerenderMessages();
      const count = document.querySelectorAll("#msgList .message-recall").length;
      const systemAllowed = app.canRecallMessage({ id: "notice", senderId: "system", text: "x", createdAt: 1 });
      app.state.myName = name;
      app.rerenderMessages();
      return { count, systemAllowed };
    }, "/assets/chat/state.js");
    expect(gated.count).toBe(0);
    expect(gated.systemAllowed).toBe(false);
    await peerRecall.waitFor();
    await peerRecall.click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    expect(await page.locator("#confirmMessage").textContent()).toContain("Peer");
    await page.locator("#btnAcceptConfirm").click();
    await peerRow.locator(".recalled-note").waitFor();
    expect((await peerRow.locator(".recalled-by").textContent())?.trim()).toBe("Recalled by Recall tester");

    // A recall made elsewhere reaches this tab through the room recall version.
    const second = new Database(path.join(stateDir, "chat-room.sqlite"));
    second.exec("PRAGMA busy_timeout=5000");
    const secondID = randomUUID();
    const tail = second.query("SELECT max(created_at) AS ts FROM messages WHERE room_id=?").get(roomId) as { ts: number | null };
    second.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question) VALUES(?,?,?,?,?,?,0)")
      .run(secondID, roomId, "Peer", "recall-peer", "Peer second message", Math.max(Date.now(), (tail?.ts ?? 0) + 1));
    const secondRow = page.locator(`#msgList [data-msg-id="${secondID}"]`);
    await secondRow.waitFor();
    second.query("UPDATE messages SET recalled_at=?,recalled_by=? WHERE id=?").run(Date.now(), "Moderator", secondID);
    second.query("INSERT INTO room_recall_versions(room_id,version) VALUES(?,1) ON CONFLICT(room_id) DO UPDATE SET version=version+1").run(roomId);
    second.close();
    // The version-aware long-poll wakes this tab and the reconcile hides the row.
    await secondRow.locator(".recalled-note").waitFor();
    expect((await secondRow.locator(".recalled-by").textContent())?.trim()).toBe("Recalled by Moderator");

    // A recall far older than any fixed window still blanks already-loaded history.
    await page.evaluate(async (url: string) => (await import(url)).app.stopPolling(), "/assets/chat/state.js");
    const historyRequests: number[] = [];
    await page.route("**/history*", async (route: any) => {
      const before = Number(new URL(route.request().url()).searchParams.get("beforeSeq") || 3001);
      historyRequests.push(before);
      const start = Math.max(1, before - 200), messages = [];
      for (let seq = start; seq < before; seq++) messages.push({ id: `bulk-${seq}`, roomId, senderId: "Peer", text: seq === 500 ? "" : `bulk ${seq}`, createdAt: 1000 + seq, seq, ...(seq === 500 ? { recalledAt: 2000, recalledBy: "Moderator" } : {}) });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages, hasMore: start > 1, nextBeforeSeq: messages[0]?.seq ?? null, recallVersion: 9 }) });
    });
    const synced = await page.evaluate(async ({ url, room }: { url: string; room: string }) => {
      const { app } = await import(url);
      app.state.room.messages = Array.from({ length: 3000 }, (_, index) => ({ id: `bulk-${index + 1}`, roomId: room, senderId: "Peer", text: `bulk ${index + 1}`, createdAt: 1001 + index, seq: index + 1 }));
      const changed = await app.syncLoadedHistory(room, app.state.pollGeneration);
      const target = app.state.room.messages.find((message: any) => message.id === "bulk-500");
      return { changed, text: target?.text, recalledAt: target?.recalledAt };
    }, { url: "/assets/chat/state.js", room: roomId });
    expect(synced.changed).toBe(true);
    expect(synced.text).toBe("");
    expect(synced.recalledAt).toBeGreaterThan(0);
    expect(historyRequests.length).toBeGreaterThan(10);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(!browserModule)("the confirmed recall and content endpoints drive the tombstone", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-recall-real-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(12000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Real recall");
    await page.locator("#inRoomName").fill("Real recall room");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#msgInput").fill("Recall through the server");
    await page.locator("#btnSend").click();
    const row = page.locator("#msgList [data-msg-id]").filter({ hasText: "Recall through the server" }).last();
    await row.waitFor();
    const id = await row.getAttribute("data-msg-id");
    const target = page.locator(`#msgList [data-msg-id="${id}"]`);
    await target.locator(".message-recall").click();
    await page.locator("#confirmDialog").waitFor({ state: "visible" });
    await page.locator("#btnAcceptConfirm").click();
    await target.locator(".recalled-note").waitFor();
    // The confirmed reveal endpoint returns the retained text.
    await target.locator(".recalled-reveal").click();
    await target.locator(".recalled-body").waitFor({ state: "visible" });
    expect((await target.locator(".recalled-body").textContent())?.trim()).toBe("Recall through the server");
    // A human administrator can also recall a room notice, and members can reveal it.
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    const joined = await fetch(`${origin}/rooms/${roomId}/join`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "notice-peer", participantId: "NoticePeer", participantName: "NoticePeer" }),
    });
    expect(joined.ok).toBe(true);
    const notice = page.locator("#msgList li.sys").filter({ hasText: "joined the room" }).last();
    await notice.waitFor();
    const noticeId = await notice.getAttribute("data-msg-id");
    const noticeRow = page.locator(`#msgList [data-msg-id="${noticeId}"]`);
    await noticeRow.waitFor();
    expect(await noticeRow.locator(".sys-recall").count()).toBe(0);
    // The room snapshot a reload would use carries both recalled rows and the version.
    const payload: any = await (await fetch(`${origin}/rooms/${roomId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(payload.messages.some((message: any) => message.senderId === "system" && message.text === "" && message.recalledAt)).toBe(false);
    expect(payload.messages.some((message: any) => message.text === "" && message.recalledAt && message.senderId === "Real recall")).toBe(true);
    expect(payload.recallVersion).toBeGreaterThan(0);
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

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