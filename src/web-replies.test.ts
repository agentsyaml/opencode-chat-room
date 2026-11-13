import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE, token = "chat-replies-local-token";
test.skipIf(!browserModule)("reply drafts, mentions, retries, and history quotes", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-replies-")), port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`, server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(10000);
    const pageErrors: string[] = []; page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#joinView")?.hidden || !document.querySelector<HTMLElement>("#restoreError")?.hidden).catch(async () => {
      throw new Error(JSON.stringify({ pageErrors, restoreError: await page.locator("#restoreError").textContent(), restore: await page.locator("#restoreView").innerText() }));
    });
    if (pageErrors.length || await page.locator("#restoreError").isVisible()) throw new Error(JSON.stringify({ pageErrors, restoreError: await page.locator("#restoreError").textContent() }));
    await page.locator("#inName").fill("Reply tester"); await page.locator("#inRoomName").fill("Reply room");
    await page.locator("#btnCreate").click(); await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    const peerSessionID = "reply-peer-session";
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: peerSessionID, participantId: "Peer", participantName: "Peer" });
    const original = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerSessionID, text: "Original peer message", isQuestion: false });
    const otherSession = "reply-other-session";
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: otherSession, participantId: "Other", participantName: "Other" });
    const otherMessage = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: otherSession, text: "Other member message", isQuestion: false });
    await page.evaluate(async (url: string) => { const { app } = await import(url); await app.loadManageableMembers(); }, "/assets/chat/state.js");
    await page.locator(`#msgList [data-msg-id="${original.messages.at(-1).id}"] .message-reply`).waitFor();
    await page.locator(`#msgList [data-msg-id="${otherMessage.messages.at(-1).id}"] .message-reply`).waitFor();
    const replyAction = page.locator(`#msgList [data-msg-id="${original.messages.at(-1).id}"] .message-reply`);
    expect(await replyAction.getAttribute("aria-label")).toBe("Reply");
    expect(await replyAction.locator("svg[aria-hidden=true]").count()).toBe(1);
    expect(await page.locator("#replyCancel").getAttribute("aria-label")).toBe("Cancel reply");
    await checkComposerEditor(page);
    let failReply = true, replyPayload: any, retryPayload: any, releaseConcurrentSend = () => {}, signalConcurrentSend = () => {};
    const concurrentSendStarted = new Promise<void>((resolve) => { signalConcurrentSend = resolve; });
    await page.route("**/rooms/*/messages", async (route: any) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      if (body.text === "Concurrent send") { signalConcurrentSend(); await new Promise<void>((resolve) => { releaseConcurrentSend = resolve; }); return route.continue(); }
      if (!body.replyToMessageID) return route.continue();
      if (failReply) { failReply = false; replyPayload = body; return route.fulfill({ status: 500, json: { error: "temporary" } }); }
      retryPayload = body; return route.continue();
    });
    const originalId = original.messages.at(-1).id;
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    const editor = page.locator("#msgInput");
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at> ");
    expect(await editor.locator("[data-mention]").count()).toBe(1);
    expect(await page.locator("#replyPreview").isVisible()).toBe(true);
    const guardedBackspace = await page.evaluate(() => {
      const input = document.querySelector<any>("#msgInput"), value = input.value, draft = input.draftValue;
      const dispatch = (options: KeyboardEventInit) => { const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true, ...options }); input.dispatchEvent(event); return event.defaultPrevented; };
      const composing = dispatch({ isComposing: true }), imeKey = dispatch({ keyCode: 229 });
      input.value = "x".repeat(value.length); input.setCaret(value.length);
      const changedPrefix = dispatch({}); input.draftValue = draft; input.setCaret(value.length);
      return [composing, imeKey, changedPrefix];
    });
    expect(guardedBackspace).toEqual([false, false, false]);
    await page.keyboard.press("Backspace");
    expect(await editor.evaluate((node: any) => node.value)).toBe("");
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    await page.keyboard.insertText("  ");
    const afterBackspaces: string[] = [];
    for (let index = 0; index < 3; index++) {
      await page.keyboard.press("Backspace"); afterBackspaces.push(await editor.evaluate((node: any) => node.value));
    }
    expect(afterBackspaces).toEqual(["<at>@Peer</at>  ", "<at>@Peer</at> ", ""]);
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at> ");
    await editor.focus(); await editor.evaluate((node: any) => node.setCaret(node.value.length));
    await page.keyboard.press("Backspace");
    expect(await editor.evaluate((node: any) => node.value)).toBe("");
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    await page.locator("#replyCancel").click();
    expect(await page.locator("#replyPreview").isVisible()).toBe(false);
    expect(await editor.evaluate((node: any) => node.value)).toBe("");
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    await page.keyboard.press("End"); await page.keyboard.insertText("@Peer");
    await page.locator('#mentionPicker [data-name="Peer"]').waitFor(); await page.keyboard.press("Enter");
    await page.keyboard.insertText(" @");
    await page.locator('#mentionPicker [data-name="all"]').waitFor(); await page.keyboard.press("Enter");
    await page.locator(`#msgList [data-msg-id="${otherMessage.messages.at(-1).id}"] .message-reply`).click();
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Other</at> <at>@Peer</at> <at>@all</at>");
    await page.locator("#replyCancel").click();
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at> <at>@all</at>");
    await editor.fill("");
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.setData("text/plain", "literal <at>@all</at>");
      document.querySelector("#msgInput")!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    expect(await editor.evaluate((node: any) => node.value)).toBe("literal <at>@all</at>");
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at> literal <at>@all</at>");
    expect(await editor.locator('[data-mention="all"]').count()).toBe(0);
    await page.locator("#replyCancel").click();
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await editor.evaluate((node: any) => node.value)).toBe("literal <at>@all</at>");
    expect(await editor.locator('[data-mention="all"]').count()).toBe(0);
    await editor.fill("");
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    await page.keyboard.press("End"); await page.keyboard.insertText("Thanks for sharing.");
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await page.locator("#replyPreview").isVisible()).toBe(true);
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at> Thanks for sharing.");
    await page.locator("#btnSend").click();
    await page.locator(`.failed-message[data-reply-target-id="${originalId}"]`).waitFor();
    expect(replyPayload).toMatchObject({ replyToMessageID: originalId, text: "<at>@Peer</at> Thanks for sharing." });
    await page.locator(`.failed-message[data-reply-target-id="${originalId}"] [data-failed-action="retry"]`).click();
    await page.waitForFunction(async ({ url, target }: { url: string; target: string }) => {
      const { app } = await import(url); return app.state.room.messages.at(-1)?.answerToMessageID === target;
    }, { url: "/assets/chat/state.js", target: originalId });
    expect(retryPayload).toMatchObject({ replyToMessageID: originalId, text: "<at>@Peer</at> Thanks for sharing." });
    await page.evaluate(async ({ url, target }: { url: string; target: string }) => {
      const { app } = await import(url), room = app.state.room;
      room.messages = room.messages.filter((message: any) => message.id !== target);
      app.state.rooms.get(room.id).room = room; app.rerenderMessages();
    }, { url: "/assets/chat/state.js", target: originalId });
    const quote = page.locator(`#msgList [data-reply-target-id="${originalId}"]`);
    expect(await quote.textContent()).toBe("View original message");
    let failHistoryOnce = true;
    const historyRoute = async (route: any) => {
      if (failHistoryOnce) { failHistoryOnce = false; return route.fulfill({ status: 503, json: { error: "history temporarily unavailable" } }); }
      return route.continue();
    };
    await page.route("**/rooms/*/history?*", historyRoute);
    const failedHistory = page.waitForResponse((response: any) => response.status() === 503);
    await quote.click(); await failedHistory;
    expect(await quote.isDisabled()).toBe(false);
    await quote.click();
    await page.locator(`#msgList [data-msg-id="${originalId}"]`).waitFor();
    await page.unroute("**/rooms/*/history?*", historyRoute);
    expect(await quote.textContent()).toContain("Original peer message");
    await page.evaluate(async (url: string) => {
      const { app } = await import(url), message = app.state.room.messages.at(-1);
      message.answerToMessageID = "reply-target-missing"; app.rerenderMessages();
    }, "/assets/chat/state.js");
    await page.locator('[data-reply-target-id="reply-target-missing"]').click();
    await page.locator('[data-reply-target-id="reply-target-missing"][disabled]').waitFor();
    let holdHistory = true, releaseHistory = () => {}, signalHistory = () => {};
    const historyStarted = new Promise<void>((resolve) => { signalHistory = resolve; });
    await page.route("**/rooms/*/history?*", async (route: any) => {
      if (holdHistory) { holdHistory = false; signalHistory(); await new Promise<void>((resolve) => { releaseHistory = resolve; }); }
      return route.continue();
    });
    await page.evaluate(async ({ url, id }: { url: string; id: string }) => {
      const { app } = await import(url), room = app.state.room;
      room.messages.find((message: any) => message.answerToMessageID === id && message.text.includes("Thanks for sharing.")).answerToMessageID = id;
      room.messages = room.messages.filter((message: any) => message.id !== id);
      app.state.rooms.get(room.id).room = room; app.rerenderMessages();
    }, { url: "/assets/chat/state.js", id: originalId });
    await page.locator(`#msgList [data-reply-target-id="${originalId}"]`).click(); await historyStarted;
    await editor.fill("Concurrent send"); await page.locator("#btnSend").click(); await concurrentSendStarted;
    await page.locator("#btnNewRoom").click(); await page.locator("#inRoomNameChat").fill("Jump destination");
    await page.locator("#btnCreateChatRoom").click(); await page.waitForFunction(() => document.querySelector("#roomName")?.textContent === "Jump destination");
    const destination = await page.evaluate(() => sessionStorage.getItem("chat.roomId"));
    releaseHistory(); releaseConcurrentSend();
    await page.waitForFunction((id: string) => sessionStorage.getItem("chat.roomId") === id, destination);
    expect(await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js")).toBe(destination);
    await page.locator(`#roomListChat [data-room-id="${roomId}"]`).click();
    await page.waitForFunction((id: string) => (document.querySelector("#btnCopyId") as HTMLButtonElement | null)?.title.endsWith(id), roomId);
    let failQuestionAnswer = true, questionAnswerPath = "", questionAnswerBody: any;
    await page.route("**/questions/*/answers", async (route: any) => {
      if (route.request().method() !== "POST") return route.continue();
      questionAnswerPath = new URL(route.request().url()).pathname;
      questionAnswerBody = route.request().postDataJSON();
      if (failQuestionAnswer) { failQuestionAnswer = false; return route.fulfill({ status: 500, json: { error: "temporary" } }); }
      return route.continue();
    });
    const question = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerSessionID, text: "Question for composer", isQuestion: true });
    const questionId = question.messages.at(-1).id;
    await page.waitForFunction(async ({ id, url }: { id: string; url: string }) => (await import(url)).app.state.room.messages.some((item: any) => item.id === id), { id: questionId, url: "/assets/chat/state.js" });
    await page.locator(`#msgList [data-msg-id="${questionId}"] .message-reply`).click();
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at> ");
    await page.keyboard.press("End"); await page.keyboard.insertText("Yes, I can help."); await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    expect(await page.locator("#replyPreview").isVisible()).toBe(true);
    expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at> Yes, I can help.");
    await page.locator("#btnSend").click();
    await page.locator(`.failed-message[data-reply-target-id="${questionId}"]`).waitFor();
    await page.locator(`.failed-message[data-reply-target-id="${questionId}"] [data-failed-action="retry"]`).click();
    await page.waitForFunction(async ({ id, url }: { id: string; url: string }) => (await import(url)).app.state.room.messages.at(-1)?.answerToMessageID === id, { id: questionId, url: "/assets/chat/state.js" });
    expect(questionAnswerPath).toBe(`/rooms/${roomId}/questions/${questionId}/answers`);
    expect(questionAnswerBody).toMatchObject({ text: "<at>@Peer</at> Yes, I can help." });
    const conflict = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerSessionID, text: "Answered elsewhere", isQuestion: true });
    const conflictId = conflict.messages.at(-1).id;
    await page.waitForFunction(async ({ id, url }: { id: string; url: string }) => (await import(url)).app.state.room.messages.some((item: any) => item.id === id), { id: conflictId, url: "/assets/chat/state.js" });
    const conflictSession = "reply-conflict-session";
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: conflictSession, participantId: "Other", participantName: "Other" });
    await api(origin, `/rooms/${roomId}/questions/${conflictId}/answers`, "POST", { sessionID: conflictSession, text: "Already handled." });
    await page.locator(`#msgList [data-msg-id="${conflictId}"] .message-reply`).click();
    await page.keyboard.press("End"); await page.keyboard.insertText("I was going to answer."); await page.locator("#btnSend").click();
    // The question was answered first, so the answer can never be retried; the text
    // returns to the draft and no failed message is queued.
    await page.locator("#sendError").waitFor({ state: "visible" });
    expect(await page.evaluate(async (url: string) => (await import(url)).app.state.drafts.get((await import(url)).app.state.room.id) || "", "/assets/chat/state.js")).toContain("I was going to answer.");
    expect(await editor.evaluate((node: any) => node.value)).toContain("I was going to answer.");
    expect(await page.locator(`.failed-message[data-reply-target-id="${conflictId}"]`).count()).toBe(0);
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.clearDraft(app.state.room.id); app.$("#msgInput").draftValue = "";
    }, "/assets/chat/state.js");
    await page.evaluate(async ({ url, peerSessionID }: { url: string; peerSessionID: string }) => {
      const { app } = await import(url), members = app.state.memberSessions.get(app.state.room.id), peer = members.find((member: any) => member.sessionID === peerSessionID);
      members.push({ ...peer, sessionID: "reply-duplicate-peer" });
    }, { url: "/assets/chat/state.js", peerSessionID });
    await page.locator(`#msgList [data-msg-id="${originalId}"] .message-reply`).click();
    expect(await editor.evaluate((node: any) => node.value)).toBe("");
    expect(await editor.locator("[data-mention]").count()).toBe(0);
    await page.locator("#replyCancel").click();
    await page.evaluate(async (url: string) => (await import(url)).app.stopPolling(), "/assets/chat/state.js");
    const database = new Database(path.join(stateDir, "chat-room.sqlite"));
    const baseTime = Date.now() + 1000, insert = database.query("INSERT INTO messages(id,room_id,sender_id,sender_session_id,text,created_at,is_question,answer_to) VALUES(?,?,?,?,?,?,0,NULL)");
    database.transaction(() => { for (let index = 0; index < 505; index++) insert.run(randomUUID(), roomId, "Peer", peerSessionID, `History entry ${index}`, baseTime + index); })();
    const newerReply = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: peerSessionID, text: "Reply after long history", replyToMessageID: originalId });
    const newerReplyId = newerReply.messages.at(-1).id;
    const laterCount = database.query("SELECT COUNT(*) AS count FROM messages WHERE room_id=? AND seq>(SELECT seq FROM messages WHERE id=?)").get(roomId, originalId) as { count: number };
    expect(laterCount.count).toBeGreaterThan(500);
    database.close();
    let inboxPolls = 0, readRequests = 0;
    await page.route("**/inbox?*", (route: any) => { inboxPolls++; return route.fulfill({ json: { member: true, items: [], hasMore: false } }); });
    await page.route("**/read", async (route: any) => { if (route.request().method() === "POST") readRequests++; return route.continue(); });
    await page.reload(); await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator(`#msgList [data-msg-id="${newerReplyId}"] [data-reply-target-id="${originalId}"]`).waitFor();
    await page.locator(`#msgList [data-reply-target-id="${originalId}"]`).click();
    await page.locator(`#msgList [data-msg-id="${originalId}"]`).waitFor();
    expect(await page.evaluate(async (url: string) => (await import(url)).app.state.room.messages.length, "/assets/chat/state.js")).toBeGreaterThan(500);
    expect(await page.locator("#thread").evaluate((thread: HTMLElement) => thread.scrollHeight - thread.scrollTop - thread.clientHeight)).toBeGreaterThan(80);
    await page.waitForTimeout(300); const pollsBefore = inboxPolls, readsBefore = readRequests;
    await page.waitForTimeout(2600);
    expect(inboxPolls).toBeGreaterThan(pollsBefore);
    expect(readRequests).toBe(readsBefore);
    await page.locator(`#msgList [data-msg-id="${originalId}"]`).waitFor();
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

async function checkComposerEditor(page: any) {
  const editor = page.locator("#msgInput");
  const undo = await editor.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta+z" : "Control+z");
  const redo = undo.replace("+z", "+Shift+z");
  await editor.fill("");
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>("#msgInput")!, data = new DataTransfer();
    data.setData("text/plain", "Paste end\n"); editor.focus();
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.insertText("after");
  expect(await editor.evaluate((node: any) => node.value)).toBe("Paste end\nafter");
  await editor.fill("");
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>("#msgInput")!, data = new DataTransfer();
    data.setData("text/html", '<span class="editor-mention" data-mention="all">@all</span>'); data.setData("text/plain", "@all");
    editor.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
  });
  expect(await editor.evaluate((node: any) => node.value)).toBe("@all");
  expect(await editor.locator("[data-mention]").count()).toBe(0);
  await editor.fill("");
  await page.evaluate(() => Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined }));
  await editor.click(); await page.keyboard.insertText("@Pe");
  await page.locator('#mentionPicker [data-name="Peer"]').waitFor(); await page.keyboard.press("Enter");
  expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at>");
  expect(await editor.evaluate((node: any) => node.getSelectionOffsets())).toEqual([14, 14]);
  await page.evaluate(() => { delete (crypto as any).randomUUID; });
  await page.keyboard.insertText("!"); await page.keyboard.press(undo);
  await editor.evaluate((node: any) => node.setSelectionRange(0, 14));
  expect(await editor.evaluate((node: any) => node.getSelectionOffsets())).toEqual([0, 14]); await page.keyboard.press("Backspace");
  await page.keyboard.press(undo); expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at>");
  await page.keyboard.press(redo); expect(await editor.evaluate((node: any) => node.value)).toBe("");
  await page.keyboard.press(undo);
  await editor.evaluate((node: any) => {
    const chip = node.querySelector(".editor-mention")!.cloneNode(true) as HTMLElement;
    chip.dataset.mention = "all"; chip.textContent = "@all"; node.append(chip);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
  });
  expect(await editor.evaluate((node: any) => node.value)).toBe("<at>@Peer</at>@all");
  expect(await editor.evaluate((node: any) => node.value.includes("<at>@all</at>"))).toBe(false);
  await editor.fill("@Pe"); await page.locator('#mentionPicker [data-name="Peer"]').waitFor(); await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  expect(await editor.evaluate((node: any) => node.value)).toBe("");
  await editor.fill("");
  await editor.fill("Line\n@Pe"); await page.locator('#mentionPicker [data-name="Peer"]').waitFor(); await page.keyboard.press("Enter");
  expect(await editor.evaluate((node: any) => node.value)).toBe("Line\n<at>@Peer</at>");
  await editor.fill("@Pe"); await page.locator('#mentionPicker [data-name="Peer"]').waitFor(); await page.keyboard.press("Enter");
  await editor.evaluate((node: any) => { node.value = "x".repeat(1986) + node.value; node.dispatchEvent(new InputEvent("input", { bubbles: true })); });
  expect(await editor.evaluate((node: any) => node.value.length)).toBe(2000); expect(await page.locator("#btnSend").isDisabled()).toBe(false);
  await page.locator("#btnSend").click();
  await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.at(-1)?.text.length === 2000, "/assets/chat/state.js");
  await editor.evaluate((node: any) => { node.value = "x".repeat(1987) + "<at>@Peer</at>"; node.dispatchEvent(new InputEvent("input", { bubbles: true })); });
  expect(await editor.evaluate((node: any) => node.value.length)).toBe(2001); expect(await page.locator("#btnSend").isDisabled()).toBe(true); await editor.fill("");
  await editor.fill("Hello @Pe"); await page.locator('#mentionPicker [data-name="Peer"]').waitFor(); await page.keyboard.press("Enter");
  const before = await page.locator("#msgList [data-msg-id]").count(); await editor.evaluate((node: any) => node.setCaret(node.value.length));
  await page.evaluate(() => document.querySelector<HTMLElement>("#msgInput")!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await page.keyboard.insertText("仮");
  await editor.evaluate((node: any) => { node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })); node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 229 })); node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
  expect(await page.locator("#msgList [data-msg-id]").count()).toBe(before);
  expect(await editor.evaluate((node: any) => node.value)).toBe("Hello <at>@Peer</at>仮");
  await page.keyboard.press("Enter");
  await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.at(-1)?.text === "Hello <at>@Peer</at>仮", "/assets/chat/state.js");
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve local port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Wait for startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}
