import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-questions-local-token";

test.skipIf(!browserModule)("questions can be answered inline without replacing the message draft", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-questions-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore",
  });
  let browser: any;
  try {
    await waitForServer(origin);
    await mkdir(screenshotDir, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript((value: string) => {
      localStorage.setItem("chat.token", value);
      (window as any).__failCopy = false;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
        if ((window as any).__failCopy) throw new Error("clipboard unavailable");
        (window as any).__copiedQuestion = text;
      } } });
      document.execCommand = (command: string) => command === "copy" && !(window as any).__failCopy;
    }, token);
    let failAnswer = true;
    let holdAnswer = false, answerRequestCount = 0, questionRefreshes = 0, markdownQuestionFixture = true;
    let concurrentAnswer = false, holdQuestionSnapshot = false, staleQuestionSnapshot: any[] = [];
    let releaseAnswer = () => {}, signalAnswerStarted = () => {};
    let holdConflictAnswer = false, releaseConflictAnswer = () => {}, signalConflictAnswer = () => {};
    const answerStarted = new Promise<void>((resolve) => { signalAnswerStarted = resolve; });
    const conflictStarted = new Promise<void>((resolve) => { signalConflictAnswer = resolve; });
    const sent: any[] = [];
    const answerPayloads: any[] = [];
    await page.route("**/rooms/*/questions", async (route: any) => {
      if (route.request().method() === "GET") {
        questionRefreshes++;
        if (holdQuestionSnapshot) return route.fulfill({ json: { questions: staleQuestionSnapshot } });
        const response = await route.fetch(), body = await response.json();
        if (markdownQuestionFixture && body.questions?.length) {
          body.questions[0].text = "**Which direction should we take?**\n\n[Open details](https://example.com)\n\n```js\nconst choice = 'bold';\n```";
          markdownQuestionFixture = false;
        }
        return route.fulfill({ response, json: body });
      }
      return route.continue();
    });
    await page.route("**/questions/*/answers", async (route: any) => {
      if (route.request().method() === "POST") answerPayloads.push(route.request().postDataJSON());
      if (failAnswer && route.request().method() === "POST") {
        failAnswer = false;
        return route.fulfill({ status: 500, json: { error: "temporary" } });
      }
      if (holdAnswer) {
        if (++answerRequestCount > 1) return route.fulfill({ status: 500, json: { error: "duplicate" } });
        signalAnswerStarted();
        await new Promise<void>((resolve) => { releaseAnswer = resolve; });
        holdAnswer = false;
      }
      if (concurrentAnswer) {
        if (holdConflictAnswer) {
          signalConflictAnswer();
          await new Promise<void>((resolve) => { releaseConflictAnswer = resolve; });
          holdConflictAnswer = false;
        }
        const response = await route.fetch();
        if (response.status() === 409) holdQuestionSnapshot = false;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    await page.route("**/rooms/*/messages", async (route: any) => { if (route.request().method() === "POST") sent.push(route.request().postDataJSON()); return route.continue(); });
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("Question tester");
    await page.locator("#inRoomName").fill("Question room");
    await page.locator("#btnCreate").click();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("#chatView")?.hidden || !document.querySelector<HTMLElement>("#joinError")?.hidden, undefined, { timeout: 10000 });
    if (await page.locator("#joinError").isVisible()) throw new Error(await page.locator("#joinError").textContent() || "Room creation failed");
    await page.locator("#questionPanel").waitFor({ state: "hidden" });
    const roomId = await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js");
    await page.locator("#msgInput").fill("An ordinary reply to the room");
    expect(await page.locator("#questionToggle").isChecked()).toBe(false);
    await page.locator("#btnSend").click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#msgList .msg-text")).at(-1)?.textContent?.trim() === "An ordinary reply to the room");
    expect(sent.at(-1)).toMatchObject({ text: "An ordinary reply to the room", isQuestion: false });
    await page.locator("#questionToggle").check();
    await page.locator("#msgInput").fill("Which direction should we take?");
    await page.locator("#btnSend").click();
    await page.waitForFunction(() => document.querySelector("#msgList .question-message .question-mark")?.textContent === "Question");
    expect(sent.at(-1)).toMatchObject({ text: "Which direction should we take?", isQuestion: true });
    await page.locator("#msgInput").fill("Do you prefer warm or cool colors?");
    await page.locator("#btnSend").click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#msgList .msg-text")).at(-1)?.textContent?.trim() === "Do you prefer warm or cool colors?");
    await page.locator("#msgInput").fill("Keep my regular draft");
    await page.locator("#btnQuestions").click();
    await page.locator(".question-item").getByText("Which direction should we take?").waitFor();
    expect(await page.locator(".question-item strong").textContent()).toBe("Which direction should we take?");
    expect(await page.locator(".question-item pre").count()).toBe(1);
    expect(await page.locator(".question-item").first().evaluate((node: Element) => node.textContent?.includes("**") || node.textContent?.includes("```"))).toBe(false);
    expect(await page.locator(".question-item-body").first().evaluate((node: HTMLElement) => getComputedStyle(node).maxHeight)).toBe("none");
    expect(await page.locator(".question-select").first().getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator(".question-item a").evaluate((node: Element) => node.closest("button"))).toBeNull();
    await page.locator(".question-select").first().focus(); await page.keyboard.press("Enter");
    expect(await page.locator("#questionReply [contenteditable=true]").evaluate((node: Element) => node === document.activeElement)).toBe(true);
    expect(await page.locator("#questionReply .question-reply-quote").count()).toBe(0);
    await page.locator("#questionReply .question-copy").click();
    expect(await page.locator(".question-copy-feedback").getAttribute("aria-live")).toBe("polite");
    await page.waitForFunction(() => document.querySelector(".question-copy-feedback")?.textContent === "Question copied.");
    expect(await page.evaluate(() => (window as any).__copiedQuestion)).toContain("```js");
    await page.evaluate(() => { (window as any).__failCopy = true; });
    await page.locator("#questionReply .question-copy").click();
    await page.waitForFunction(() => document.querySelector(".question-copy-feedback")?.textContent === "Could not copy question.");
    await page.evaluate(() => { (window as any).__failCopy = false; });
    expect(await page.locator("#questionPanel").evaluate((node: HTMLElement) => node.getBoundingClientRect().width)).toBeGreaterThan(390);
    const questionVisibility = await page.evaluate(() => ({ panel: (document.querySelector("#questionPanel") as HTMLElement).hidden, reply: (document.querySelector("#questionReply") as HTMLElement).hidden, visible: Boolean(document.querySelector("#questionReply [contenteditable=true]")?.getClientRects().length) }));
    if (!questionVisibility.visible) throw new Error(JSON.stringify(questionVisibility));
    const replyEditor = page.locator("#questionReply [contenteditable=true]");
    await replyEditor.fill("Composition draft");
    await replyEditor.evaluate((node: HTMLElement) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 229 })));
    expect(await replyEditor.evaluate((node: any) => node.value)).toBe("Composition draft");
    expect(answerPayloads).toHaveLength(0);
    await replyEditor.fill("x".repeat(2001));
    expect(await page.locator("#questionReply button[type=submit]").isDisabled()).toBe(true);
    expect(await page.locator("#questionStatus").textContent()).toContain("2,000");
    await page.evaluate(() => document.querySelector<HTMLFormElement>("#questionReply form")!.requestSubmit());
    expect(answerPayloads).toHaveLength(0);
    await page.locator("#questionReply [contenteditable=true]").fill("Use the warmer palette.");
    await page.locator("#questionReply button[type=submit]").click();
    expect(await page.locator("#questionReply [contenteditable=true]").evaluate((node: any) => node.value)).toBe("Use the warmer palette.");
    await page.waitForFunction(() => document.querySelector("#questionStatus")?.textContent?.includes("Reply failed"));
    holdAnswer = true;
    const refreshBefore = questionRefreshes;
    await page.evaluate(() => {
      const input = document.querySelector<HTMLElement & { value: string; selectionStart: number; selectionEnd: number; setSelectionRange(start: number, end: number): void }>("#questionReply [contenteditable=true]")!;
      (window as any).__replyInput = input;
      input.focus();
      input.setSelectionRange(4, 9);
       input.closest("form")!.requestSubmit();
    });
    await answerStarted;
    for (let i = 0; i < 70 && questionRefreshes === refreshBefore; i++) await page.waitForTimeout(100);
    expect(questionRefreshes).toBeGreaterThan(refreshBefore);
    const replyState = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement & { value: string; selectionStart: number; selectionEnd: number; setSelectionRange(start: number, end: number): void }>("#questionReply [contenteditable=true]")!;
      const button = document.querySelector<HTMLButtonElement>("#questionReply button[type=submit]")!;
       input.closest("form")!.requestSubmit();
      return { sameNode: input === (window as any).__replyInput, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, text: input.value, disabled: button.disabled };
    });
    expect(replyState).toEqual({ sameNode: true, focused: true, start: 4, end: 9, text: "Use the warmer palette.", disabled: true });
    await page.waitForTimeout(100);
    expect(answerRequestCount).toBe(1);
    await page.locator(".question-item").nth(1).click();
    await page.locator("#questionReply [contenteditable=true]").fill("Draft for the second question.");
    await page.evaluate(() => {
      const input = document.querySelector<HTMLElement & { value: string; selectionStart: number; selectionEnd: number; setSelectionRange(start: number, end: number): void }>("#questionReply [contenteditable=true]")!;
      (window as any).__secondReply = input;
      input.focus();
      input.setSelectionRange(6, 12);
    });
    releaseAnswer();
    await page.waitForFunction(() => document.querySelectorAll("#questionList .question-item").length === 1);
    const secondReplyState = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement & { value: string; selectionStart: number; selectionEnd: number; setSelectionRange(start: number, end: number): void }>("#questionReply [contenteditable=true]")!;
      return { sameNode: input === (window as any).__secondReply, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, text: input.value };
    });
    expect(secondReplyState).toEqual({ sameNode: true, focused: true, start: 6, end: 12, text: "Draft for the second question." });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#msgList .msg-text")).at(-1)?.textContent?.trim() === "Use the warmer palette.");
    expect(await page.locator("#msgInput").evaluate((node: any) => node.value)).toBe("Keep my regular draft");
    expect((await api(origin, `/rooms/${roomId}/questions`)).questions).toHaveLength(1);
    const savedRoom = await api(origin, `/rooms/${roomId}`);
    expect(savedRoom.messages.map((message: any) => message.text)).toContain("Use the warmer palette.");
    await page.locator("#questionToggle").check();
    await page.locator("#msgInput").fill("Can you review the mobile layout?");
    await page.locator("#btnSend").click();
    await page.waitForFunction(() => document.querySelector("#msgList .question-message .question-mark")?.textContent === "Question");
    expect(sent.at(-1)).toMatchObject({ text: "Can you review the mobile layout?", isQuestion: true });
    await page.locator("#msgInput").fill("Which color should stay?");
    await page.locator("#btnSend").click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#msgList .msg-text")).at(-1)?.textContent?.trim() === "Which color should stay?");
    expect(await page.locator("#msgList [data-msg-id]:not(.sys)").evaluateAll((rows: Element[]) => rows.every((row) => row.querySelector("[data-copy-message]")))).toBe(true);
    await setLocale(page, "zh-CN");
    expect(await page.locator("#questionHeading").textContent()).toBe("待回答的问题");
    await page.locator("#btnQuestions").click();
    await page.locator("#questionPanel").waitFor({ state: "visible" });
    await page.locator(".question-item").getByText("Can you review the mobile layout?").waitFor();
    await page.locator(".question-item").getByText("Can you review the mobile layout?").click();
    await page.locator("#questionReply [contenteditable=true]").waitFor({ state: "visible" });
    await page.locator("#questionReply [contenteditable=true]").fill("Keep this translated reply draft.");
    const zhPanelHeight = await page.locator("#questionPanel").evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    await page.locator("#btnSettings").click(); await page.locator("#chatSettings").waitFor({ state: "visible" });
    await page.locator("#localeSelectSettings").selectOption("en"); await page.keyboard.press("Escape");
    await page.locator("#btnQuestions").click(); await page.locator("#questionReply [contenteditable=true]").waitFor({ state: "visible" });
    expect(await page.locator("#questionReply [contenteditable=true]").evaluate((node: any) => node.value)).toBe("Keep this translated reply draft.");
    const enPanelHeight = await page.locator("#questionPanel").evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
    expect(Math.abs(zhPanelHeight - enPanelHeight)).toBeLessThanOrEqual(1);
    await page.locator("#btnSettings").click(); await page.locator("#chatSettings").waitFor({ state: "visible" });
    await page.locator("#localeSelectSettings").selectOption("zh-CN"); await page.keyboard.press("Escape"); await page.locator("#btnQuestions").click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "questions-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
    await page.screenshot({ path: path.join(screenshotDir, "questions-mobile.png"), fullPage: true });
    expect(await page.locator("#btnQuestions").getAttribute("aria-expanded")).toBe("true");
    const authorSession = randomUUID();
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: authorSession, participantId: "Question author", participantName: "Question author" });
    await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: authorSession, text: "Peer authored test question", isQuestion: true });
    await page.evaluate(async (url: string) => { const { app } = await import(url); await app.loadManageableMembers(); }, "/assets/chat/state.js");
    await page.locator("#btnRefreshQuestions").click();
    await page.locator(".question-item").getByText("Peer authored test question").click();
    expect(await replyEditor.evaluate((node: any) => node.value)).toBe("<at>@Question author</at> ");
    expect(await replyEditor.locator("[data-mention]").count()).toBe(1);
    expect(await replyEditor.locator("[data-mention]").evaluate((node: HTMLElement) => ({ text: node.textContent, editable: node.contentEditable, label: node.getAttribute("aria-label") }))).toEqual({ text: "@Question author", editable: "false", label: "Mention Question author" });
    await replyEditor.fill("");
    await page.locator("#questionReply").evaluate((node: HTMLElement) => { node.dataset.questionId = "force-draft-restore"; });
    await page.locator(".question-item").getByText("Peer authored test question").click();
    expect((await replyEditor.evaluate((node: any) => node.value)).trim()).toBe("");
    expect(await replyEditor.locator("[data-mention]").count()).toBe(0);
    await page.keyboard.press("End"); await page.keyboard.insertText("@Quest");
    await page.locator('#mentionPicker [data-name="Question author"]').waitFor();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    expect(await replyEditor.evaluate((node: any) => node.value)).toBe("<at>@Question author</at>");
    await page.keyboard.press("Enter");
    await page.waitForFunction(async (url: string) => (await import(url)).app.state.room.messages.at(-1)?.text === "<at>@Question author</at>", "/assets/chat/state.js");
    expect(answerPayloads.at(-1)?.text).toBe("<at>@Question author</at>");
    await page.evaluate(async ({ url, authorSession }: { url: string; authorSession: string }) => {
      const { app } = await import(url), members = app.state.memberSessions.get(app.state.room.id), author = members.find((member: any) => member.sessionID === authorSession);
      members.push({ ...author, sessionID: "duplicate-author-session" });
    }, { url: "/assets/chat/state.js", authorSession });
    expect(await page.evaluate(async (url: string) => (await import(url)).app.state.memberSessions.get((await import(url)).app.state.room.id).filter((member: any) => member.name === "Question author").length, "/assets/chat/state.js")).toBe(2);
    const ambiguous = await api(origin, `/rooms/${roomId}/messages`, "POST", { sessionID: authorSession, text: "Ambiguous author question", isQuestion: true });
    const ambiguousId = ambiguous.messages.at(-1).id;
    await page.locator("#btnRefreshQuestions").click();
    await page.locator("#questionList .question-item").getByText("Ambiguous author question").click();
    expect(await replyEditor.evaluate((node: any) => node.value)).toBe("");
    expect(await replyEditor.locator("[data-mention]").count()).toBe(0);
    const ownerSession = await page.evaluate(async (url: string) => (await import(url)).LS.sessionID, "/assets/chat/state.js");
    await api(origin, `/rooms/${roomId}/questions/${ambiguousId}/answers`, "POST", { sessionID: ownerSession, text: "Resolved safely." });
    await page.locator("#btnRefreshQuestions").click();
    const pendingBefore = (await api(origin, `/rooms/${roomId}/questions`)).questions;
    expect(pendingBefore).toHaveLength(3);
    const answeredElsewhere = pendingBefore[0]!, stillPending = pendingBefore[1]!;
    staleQuestionSnapshot = pendingBefore;
    holdQuestionSnapshot = true;
    const peerSessionID = randomUUID();
    await api(origin, `/rooms/${roomId}/join`, "POST", { sessionID: peerSessionID, participantId: "Peer", participantName: "Peer" });
    await api(origin, `/rooms/${roomId}/questions/${answeredElsewhere.id}/answers`, "POST", { sessionID: peerSessionID, text: "Answered by another member." });
    concurrentAnswer = true;
    holdConflictAnswer = true;
    await page.locator(`#questionList [data-question-id="${answeredElsewhere.id}"]`).click();
    await page.locator("#questionReply [contenteditable=true]").fill("Another attempt.");
    await page.locator("#questionReply button[type=submit]").click();
    await conflictStarted;
    await page.locator(`#questionList [data-question-id="${stillPending.id}"]`).click();
    await page.locator("#questionReply [contenteditable=true]").fill("Keep this selected reply.");
    await page.evaluate(() => {
      const input = document.querySelector<HTMLElement & { value: string; selectionStart: number; selectionEnd: number; setSelectionRange(start: number, end: number): void }>("#questionReply [contenteditable=true]")!;
      (window as any).__conflictReply = input;
      input.focus();
      input.setSelectionRange(3, 9);
    });
    releaseConflictAnswer();
    await page.waitForFunction((count: number) => document.querySelector<HTMLElement>("#questionStatus")?.dataset.i18n === "questionAlreadyAnswered" && document.querySelectorAll("#questionList .question-item").length === count - 1, pendingBefore.length);
    const conflictReply = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement & { value: string; selectionStart: number; selectionEnd: number; setSelectionRange(start: number, end: number): void }>("#questionReply [contenteditable=true]")!;
      return { sameNode: input === (window as any).__conflictReply, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, text: input.value };
    });
    expect(conflictReply).toEqual({ sameNode: true, focused: true, start: 3, end: 9, text: "Keep this selected reply." });
    expect(await page.locator("#questionStatus").textContent()).toBe("此问题已由其他人回答。");
    expect(await page.locator("#questionList .question-item").count()).toBe(pendingBefore.length - 1);
    expect(await page.locator("#questionList .question-item-body").evaluateAll((items: Element[]) => items.map((item) => item.textContent?.trim()))).toContain(stillPending.text);
    await page.locator("#msgInput").fill("Keep draft through unsupported server");
    await page.evaluate(async (url: string) => (await import(url)).app.stopPolling(), "/assets/chat/state.js");
    let legacyQuestionRequests = 0;
    await page.route(`**/rooms/${roomId}/questions`, async (route: any) => { legacyQuestionRequests++; return route.fulfill({ status: 404, json: { error: "unsupported endpoint" } }); });
    await page.locator("#btnRefreshQuestions").click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#questionStatus")?.dataset.i18n === "questionsUnsupported");
    expect(legacyQuestionRequests).toBeGreaterThan(0);
    expect(await page.locator("#chatView").isVisible()).toBe(true);
    expect(await page.evaluate(async (url: string) => (await import(url)).app.state.room.id, "/assets/chat/state.js")).toBe(roomId);
    await api(origin, `/rooms/${roomId}`, "DELETE", { sessionID: ownerSession });
    await page.locator("#btnRefreshQuestions").click();
    await page.locator("#joinView").waitFor({ state: "visible" });
    expect(await page.evaluate(async ({ url, id }: { url: string; id: string }) => (await import(url)).app.state.drafts.get(id), { url: "/assets/chat/state.js", id: roomId })).toBe("Keep draft through unsupported server");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function setLocale(page: any, locale: string) {
  await page.locator("#btnSettings").click(); await page.locator("#chatSettings").waitFor({ state: "visible" });
  await page.locator("#localeSelectSettings").selectOption(locale); await page.keyboard.press("Escape");
  await page.locator("#chatSettings").waitFor({ state: "hidden" });
}

async function api(origin: string, route: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), XDG_CONFIG_HOME: path.join(stateDir, "config"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
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
