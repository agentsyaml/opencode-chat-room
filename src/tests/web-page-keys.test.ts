/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-page-keys-test-token";

test.skipIf(!browserModule)("PageUp and PageDown scroll the thread while the composer is focused", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-page-keys-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(15000);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_PageOwner");
    await page.locator("#inRoomName").fill("__Test_PageKeys");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const room = await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      return { id: app.state.room.id, sessionID: app.LS.sessionID };
    }, "/assets/chat/state.js");
    for (let index = 0; index < 24; index++) {
      await api(origin, `/rooms/${room.id}/messages`, "POST", {
        sessionID: room.sessionID,
        text: `__Test_page ${index}\n${"Filler line for height.\n".repeat(4)}`,
      });
    }
    await page.locator("#msgList").getByText("__Test_page 23").waitFor();
    await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      thread.scrollTop = thread.scrollHeight;
    });
    await page.locator("#msgInput").fill("__Test_draft");
    await page.locator("#msgInput").focus();

    const read = () => page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      const input = document.querySelector<HTMLElement>("#msgInput")!;
      return {
        top: thread.scrollTop,
        gap: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
        value: (input as any).value,
        focused: document.activeElement === input,
        pageTop: document.scrollingElement?.scrollTop ?? 0,
      };
    });
    const before = await read();
    expect(before.gap).toBeLessThan(8);
    await page.keyboard.press("PageUp");
    await page.waitForFunction((top: number) => document.querySelector<HTMLElement>("#thread")!.scrollTop < top - 100, before.top);
    await page.waitForTimeout(350);
    expect(await page.locator("#msgList").evaluate((node: Element) => node.classList.contains("thread-jump-up"))).toBe(false);
    const afterUp = await read();
    expect(afterUp.top).toBeLessThan(before.top - 100);
    expect(afterUp.value).toBe("__Test_draft");
    expect(afterUp.focused).toBe(true);
    expect(afterUp.pageTop).toBe(0);

    await page.keyboard.press("PageDown");
    await page.waitForFunction((top: number) => document.querySelector<HTMLElement>("#thread")!.scrollTop > top + 100, afterUp.top);
    await page.waitForTimeout(350);
    expect(await page.locator("#msgList").evaluate((node: Element) => node.classList.contains("thread-jump-down"))).toBe(false);
    const afterDown = await read();
    expect(afterDown.top).toBeGreaterThan(afterUp.top + 100);
    expect(afterDown.value).toBe("__Test_draft");
    expect(afterDown.focused).toBe(true);

    await page.keyboard.press("Alt+PageUp");
    await page.waitForFunction((top: number) => document.querySelector<HTMLElement>("#thread")!.scrollTop < top - 100, afterDown.top);
    await page.waitForTimeout(350);
    expect(await page.locator("#msgList").evaluate((node: Element) => node.classList.contains("thread-jump-up"))).toBe(false);
    const altUp = await read();
    expect(altUp.value).toBe("__Test_draft");
    expect(altUp.focused).toBe(true);

    await page.keyboard.press("Alt+PageDown");
    await page.waitForFunction((top: number) => document.querySelector<HTMLElement>("#thread")!.scrollTop > top + 100, altUp.top);
    await page.waitForTimeout(350);
    expect(await page.locator("#msgList").evaluate((node: Element) => node.classList.contains("thread-jump-down"))).toBe(false);
    const altDown = await read();
    expect(altDown.top).toBeGreaterThan(altUp.top + 100);
    expect(altDown.value).toBe("__Test_draft");
    expect(altDown.focused).toBe(true);

    // Page distance is configurable and animated; repeated presses extend the
    // same target instead of restarting the animation.
    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      app.LS.pageStep = 50;
      const thread = document.querySelector<HTMLElement>("#thread")!;
      thread.scrollTop = thread.clientHeight * 3;
    }, "/assets/chat/state.js");
    const singleStart = await page.evaluate(() => document.querySelector<HTMLElement>("#thread")!.scrollTop);
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(80);
    const singleMid = await page.evaluate(() => document.querySelector<HTMLElement>("#thread")!.scrollTop);
    await page.waitForTimeout(600);
    const single = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      return { top: thread.scrollTop, page: thread.clientHeight };
    });
    expect(singleMid).toBeGreaterThan(singleStart);
    expect(singleMid).toBeLessThan(single.top - 10);
    expect(Math.abs(single.top - singleStart - single.page * 0.5)).toBeLessThan(24);

    await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      app.LS.pageStep = 90;
      const thread = document.querySelector<HTMLElement>("#thread")!;
      thread.scrollTop = thread.clientHeight * 0.5;
    }, "/assets/chat/state.js");
    const rapidStart = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>("#thread")!;
      return { top: thread.scrollTop, page: thread.clientHeight };
    });
    for (let index = 0; index < 5; index++) await page.keyboard.press("PageDown");
    await page.waitForTimeout(700);
    const rapidTop = await page.evaluate(() => document.querySelector<HTMLElement>("#thread")!.scrollTop);
    expect(rapidTop - rapidStart.top).toBeGreaterThan(rapidStart.page * 3.5);

    // Conversation jumps animate the scroll position itself, with no flash.
    const animation = await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      const thread = document.querySelector<HTMLElement>("#thread")!;
      thread.scrollTop = thread.scrollHeight;
      const start = thread.scrollTop;
      const samples: number[] = [];
      app.animateThreadScrollTo(0);
      for (let index = 0; index < 4; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push(thread.scrollTop);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { start, samples, end: thread.scrollTop };
    }, "/assets/chat/state.js");
    expect(animation.samples.some((top: number) => top > 0 && top < animation.start)).toBe(true);
    expect(animation.end).toBeLessThan(2);
    expect(await page.locator("#msgList").evaluate((node: Element) => node.className.includes("thread-jump"))).toBe(false);

    // A wheel scroll cancels a running animation instead of fighting it.
    const cancelled = await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      const thread = document.querySelector<HTMLElement>("#thread")!;
      thread.scrollTop = thread.scrollHeight;
      app.animateThreadScrollTo(0);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
      thread.scrollTop = 200;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return thread.scrollTop;
    }, "/assets/chat/state.js");
    expect(cancelled).toBe(200);

    // Reduced motion jumps directly instead of animating.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await page.evaluate(async (modulePath: string) => {
      const { app } = await import(modulePath);
      const thread = document.querySelector<HTMLElement>("#thread")!;
      thread.scrollTop = thread.scrollHeight;
      app.animateThreadScrollTo(0);
      return thread.scrollTop;
    }, "/assets/chat/state.js");
    expect(reduced).toBeLessThan(2);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Home must not land inside a non-editable mention chip, where the caret is invisible.
    await page.locator("#msgInput").fill("@a");
    await page.locator("#mentionPicker").waitFor({ state: "visible" });
    await page.keyboard.press("Enter");
    await page.keyboard.type(" tail");
    await page.keyboard.press("Home");
    const caret = await page.evaluate(() => {
      const selection = getSelection();
      return {
        active: document.activeElement?.id,
        type: selection?.anchorNode?.nodeType,
        offset: selection?.anchorOffset,
        previous: (selection?.anchorNode as ChildNode | null)?.previousSibling?.nodeName,
        length: selection?.anchorNode?.textContent?.length,
        height: selection?.getRangeAt(0).getBoundingClientRect().height,
      };
    });
    expect(caret).toMatchObject({ active: "msgInput", type: 3, offset: 0, previous: "SPAN", length: 5 });
    expect(caret.height).toBeGreaterThan(0);
    await page.keyboard.press("End");
    const lineEnd = await page.evaluate(() => {
      const selection = getSelection();
      return { active: document.activeElement?.id, type: selection?.anchorNode?.nodeType };
    });
    expect(lineEnd).toEqual({ active: "msgInput", type: 3 });
    await page.locator("#msgInput .editor-mention").click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("msgInput");
    await page.keyboard.press("Backspace");
    expect(await page.locator("#msgInput .editor-mention").count()).toBe(0);

    // Mobile keyboards can emit beforeinput without a usable Backspace keydown.
    await page.locator("#msgInput").fill("@a");
    await page.locator("#mentionPicker").waitFor({ state: "visible" });
    await page.keyboard.press("Enter");
    await page.evaluate(() => {
      document.querySelector("#msgInput")!.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "deleteContentBackward", bubbles: true, cancelable: true,
      }));
    });
    expect(await page.locator("#msgInput .editor-mention").count()).toBe(0);

    // Pasting multi-line text must stay plain text and must not break the
    // mention range: a leftover trigger @ used to survive the insertion.
    const pasted = "Excel 已完成文件级验证和修复。此工作簿的某些部分可能已被修复或丢弃。\n已修复的记录: /xl/worksheets/sheet1.xml 部分的 字符串属性";
    await page.evaluate((text: string) => {
      const editor = document.querySelector<HTMLElement>("#msgInput")!;
      editor.focus();
      const data = new DataTransfer();
      data.setData("text/plain", text);
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    await page.waitForFunction((text: string) => (document.querySelector("#msgInput") as any).value === text, pasted);
    expect(await page.locator("#msgInput b, #msgInput i, #msgInput u, #msgInput a, #msgInput font, #msgInput > div").count()).toBe(0);
    await page.locator("#msgInput").focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    expect(await page.evaluate(() => (document.querySelector("#msgInput") as any).value)).toBe(pasted.slice(0, -1));
    await page.keyboard.insertText(pasted.slice(-1));
    expect(await page.evaluate(() => (document.querySelector("#msgInput") as any).value)).toBe(pasted);
    await page.keyboard.type(" @a");
    await page.locator("#mentionPicker").waitFor({ state: "visible" });
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (document.querySelector("#msgInput") as any).value)).toBe(`${pasted} <at>@all</at>`);

    // Selecting a mention from an empty trigger, then pasting after it, must not
    // leave the typed trigger behind.
    await page.evaluate(() => { (document.querySelector("#msgInput") as any).value = ""; });
    await page.locator("#msgInput").focus();
    await page.keyboard.type("@");
    await page.locator("#mentionPicker").waitFor({ state: "visible" });
    await page.locator(".mention-opt").first().click();
    expect(await page.evaluate(() => (document.querySelector("#msgInput") as any).value)).toBe("<at>@all</at>");
    expect(await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>("#msgInput")!;
      return { empty: editor.dataset.empty, placeholder: getComputedStyle(editor, "::before").content };
    })).toMatchObject({ empty: "false", placeholder: "none" });
    await page.evaluate((text: string) => {
      const editor = document.querySelector<HTMLElement>("#msgInput")!;
      const data = new DataTransfer();
      data.setData("text/plain", text);
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    expect(await page.evaluate(() => (document.querySelector("#msgInput") as any).value)).toBe(`<at>@all</at>${pasted}`);

    // The deployed 0.6.9 failure pasted first, moved Home, then inserted a
    // mention at the line start; the old block DOM left the trigger behind.
    await page.evaluate(() => { (document.querySelector("#msgInput") as any).value = ""; });
    await page.locator("#msgInput").focus();
    await page.evaluate((text: string) => {
      const editor = document.querySelector<HTMLElement>("#msgInput")!;
      const data = new DataTransfer();
      data.setData("text/plain", text);
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement & { setCaret(offset: number): void }>("#msgInput")!;
      editor.focus();
      editor.setCaret(0);
    });
    await page.keyboard.type("@");
    await page.locator("#mentionPicker").waitFor({ state: "visible" });
    await page.locator(".mention-opt").first().click();
    expect(await page.evaluate(() => (document.querySelector("#msgInput") as any).value)).toBe(`<at>@all</at>${pasted}`);
    expect(await page.evaluate(() => document.querySelectorAll("#msgInput div").length)).toBe(0);

    // A draft ending in a newline has a text node plus one <br>; the old
    // :has(> br:only-child) placeholder rule ignored the text and overlapped it.
    await page.evaluate(async (modulePath: string) => {
      const { setEditorText } = await import(modulePath);
      setEditorText(document.querySelector("#msgInput"), "draft\n");
    }, "/assets/chat/editor.js");
    const withNewline = await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>("#msgInput")!;
      return { html: editor.innerHTML, empty: editor.dataset.empty, placeholder: getComputedStyle(editor, "::before").content };
    });
    expect(withNewline.html).toBe("draft<br>");
    expect(withNewline).toMatchObject({ empty: "false", placeholder: "none" });
    await page.evaluate(async (modulePath: string) => {
      const { setEditorText } = await import(modulePath);
      setEditorText(document.querySelector("#msgInput"), "");
    }, "/assets/chat/editor.js");
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("#msgInput")!.dataset.empty)).toBe("true");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}, 60000);

async function api(origin: string, route: string, method: string, body: unknown) {
  const response = await fetch(`${origin}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status})`);
  return response.json();
}
function isolatedEnv(dir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_STATE_DIR: dir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}
async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Could not reserve local port");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}
async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}