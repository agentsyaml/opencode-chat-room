import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-mention-clipboard-token";

test.skipIf(!browserModule)("copy and cut preserve real mentions but not stale names", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-mention-copy-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const owner = await browser.newPage({ viewport: { width: 1000, height: 760 } });
    const peer = await browser.newPage({ viewport: { width: 1000, height: 760 } });
    await owner.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await peer.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await owner.goto(`${origin}/chat`);
    await owner.locator("#inName").fill("Copy tester");
    await owner.locator("#inRoomName").fill("Mention room");
    await owner.locator("#btnCreate").click();
    await owner.locator("#chatView").waitFor({ state: "visible" });
    await peer.goto(`${origin}/chat`);
    await peer.locator("#inName").fill("Peer");
    await peer.locator(".room-row", { hasText: "Mention room" }).first().click();
    await peer.locator("#chatView").waitFor({ state: "visible" });
    await owner.evaluate(async (modulePath: string) => { const { app } = await import(modulePath); await app.loadManageableMembers(); }, "/assets/chat/state.js");

    await owner.locator("#msgInput").click();
    await owner.keyboard.type("@Pe");
    await owner.locator("#mentionPicker .mention-opt", { hasText: "Peer" }).waitFor();
    await owner.keyboard.press("Enter");
    await owner.keyboard.type(" tail");
    expect(await editorText(owner)).toBe("<at>@Peer</at> tail");

    const copied = await selectAndCopy(owner, "copy");
    expect(copied.text).toContain("<at>@Peer</at>");
    expect(copied.html).toContain("data-chatroom-mentions");
    await clearEditor(owner);
    await paste(owner, copied);
    expect(await mentionCount(owner)).toBe(1);
    expect(await editorText(owner)).toContain("<at>@Peer</at>");

    await clearEditor(owner);
    await owner.locator("#msgInput").click();
    await owner.keyboard.type("@Pe");
    await owner.locator("#mentionPicker .mention-opt", { hasText: "Peer" }).waitFor();
    await owner.keyboard.press("Enter");
    await owner.keyboard.type(" tail");
    await owner.locator("#btnSend").click();
    const message = owner.locator("#msgList .msg:not(.pending)", { hasText: "tail" }).last();
    await message.waitFor();
    const fromMessage = await message.evaluate((row: Element) => {
      const chip = row.querySelector(".mention-chip");
      if (!chip?.firstChild) throw new Error("message mention chip is missing");
      const range = document.createRange();
      range.setStart(chip.firstChild, 1);
      range.setEnd(chip.firstChild, 4);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      chip.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
      return { text: data.getData("text/plain"), html: data.getData("text/html") };
    });
    expect(fromMessage.text).toContain("<at>@Peer</at>");
    expect(fromMessage.html).toContain("data-chatroom-mentions");
    await clearEditor(owner);
    await paste(owner, fromMessage);
    expect(await mentionCount(owner)).toBe(1);
    expect(await editorText(owner)).toContain("<at>@Peer</at>");
    await owner.locator("#msgInput").click();
    await owner.keyboard.type(" tail");

    const partialCopy = await selectChipPartial(owner, "copy");
    expect(partialCopy.text).toContain("<at>@Peer</at>");
    expect(partialCopy.html).toContain("data-chatroom-mentions");
    const partialCut = await selectChipPartial(owner, "cut");
    expect(partialCut.text).toContain("<at>@Peer</at>");
    expect(await editorText(owner)).not.toContain("<at>@Peer</at>");
    expect(await editorText(owner)).toContain("tail");
    await paste(owner, partialCut);
    expect(await mentionCount(owner)).toBe(1);

    const cut = await selectAndCopy(owner, "cut");
    expect(cut.text).toContain("<at>@Peer</at>");
    expect(await editorText(owner)).toBe("");
    await paste(owner, cut);
    expect(await mentionCount(owner)).toBe(1);
    expect(await editorText(owner)).toContain("<at>@Peer</at>");

    await setPlainEditorText(owner, "plain @Peer text");
    const plain = await selectAndCopy(owner, "copy");
    expect(plain.text).toBe("plain @Peer text");
    expect(plain.html).toBe("");
    await clearEditor(owner);
    await paste(owner, plain);
    expect(await mentionCount(owner)).toBe(0);
    expect(await editorText(owner)).toBe("plain @Peer text");

    await clearEditor(owner);
    await paste(owner, { text: "<at>@all</at>", html: "<div data-chatroom-mentions>&lt;at&gt;@all&lt;/at&gt;</div>" });
    expect(await mentionCount(owner, "all")).toBe(1);

    await clearEditor(owner);
    await paste(owner, { text: "<at>@Ghost</at>", html: "<div data-chatroom-mentions>&lt;at&gt;@Ghost&lt;/at&gt;</div>" });
    expect(await mentionCount(owner, "Ghost")).toBe(0);
    expect(await editorText(owner)).toBe("@Ghost");
  } finally {
    await browser?.close(); server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 90000);

async function editorText(page: any): Promise<string> {
  return page.evaluate(async (modulePath: string) => { const { editorText } = await import(modulePath); return editorText(document.querySelector("#msgInput")!); }, "/assets/chat/editor.js");
}
async function mentionCount(page: any, name = "Peer"): Promise<number> { return page.locator(`#msgInput .editor-mention[data-mention='${name}']`).count(); }
async function clearEditor(page: any) { await page.evaluate(() => { document.querySelector("#msgInput")!.replaceChildren(); }); }
async function setPlainEditorText(page: any, text: string) {
  await page.evaluate((value: string) => { const editor = document.querySelector("#msgInput")!; editor.replaceChildren(document.createTextNode(value)); }, text);
}
async function selectChipPartial(page: any, type: "copy" | "cut") {
  return page.evaluate((kind: string) => {
    const editor = document.querySelector("#msgInput")!, chip = editor.querySelector(".editor-mention");
    if (!chip?.firstChild) throw new Error("editor mention chip is missing");
    const range = document.createRange(), selection = getSelection()!, data = new DataTransfer();
    range.setStart(chip.firstChild, 1); range.setEnd(chip.firstChild, 4);
    selection.removeAllRanges(); selection.addRange(range);
    editor.dispatchEvent(new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData("text/plain"), html: data.getData("text/html") };
  }, type);
}
async function selectAndCopy(page: any, type: "copy" | "cut") {
  return page.evaluate((kind: string) => {
    const editor = document.querySelector("#msgInput")!, range = document.createRange(), selection = getSelection()!, data = new DataTransfer();
    range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
    editor.dispatchEvent(new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData("text/plain"), html: data.getData("text/html") };
  }, type);
}
async function paste(page: any, data: { text: string; html: string }) {
  await page.evaluate((value: { text: string; html: string }) => {
    const editor = document.querySelector("#msgInput")!, transfer = new DataTransfer(), selection = getSelection()!, range = document.createRange();
    range.selectNodeContents(editor); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
    transfer.setData("text/plain", value.text); if (value.html) transfer.setData("text/html", value.html);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, data);
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