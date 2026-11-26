/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-panel-mode-token";

test.skipIf(!browserModule)("panel preferences choose dialog or side pane and fall back safely", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-panel-mode-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any;
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
    await page.locator("#inName").fill("__Test_PanelOwner");
    await page.locator("#inRoomName").fill("__Test_PanelRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });

    // Reminders left the header and lives in Options with the other room tools.
    expect(await page.locator("#btnReminders.chip").count()).toBe(0);
    expect(await page.locator("#roomOptions #btnReminders").count()).toBe(1);
    await page.locator("#btnRoomOptions").click();
    expect(await page.locator("#btnReminders").innerText()).toBe("Reminders");
    expect(await page.locator("#roomOptions .menu-action svg").count()).toBe(7);
    // Keyboard activation reaches the same reminders surface.
    await page.locator("#btnReminders").focus();
    await page.keyboard.press("Enter");
    await page.locator("#remindersDialog[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#remindersDialog").waitFor({ state: "hidden" });
    await waitForFocus(page, "btnRoomOptions");

    // Defaults: Tasks is a pane; Files, announcements, and reminders are dialogs.
    await openSurface(page, "#btnTasks");
    await page.locator("#tasksDialog.is-pane[open]").waitFor();
    expect(await paneBox(page, "#tasksDialog")).toMatchObject({ position: "relative", column: "4" });
    expect(await page.locator("#sidePaneHandle").isVisible()).toBe(true);
    expect(await page.locator("#chatView").evaluate((node: HTMLElement) => node.classList.contains("has-tasks"))).toBe(true);
    await page.locator("#btnCloseTasks").click();
    await waitForFocus(page, "btnRoomOptions");

    for (const [button, dialog, heading] of [
      ["#btnFiles", "#filesDialog", "#filesHeading"],
      ["#btnAnnouncements", "#announcementsDialog", "#announcementHeading"],
      ["#btnReminders", "#remindersDialog", "#reminderHeading"],
    ] as const) {
      await openSurface(page, button);
      await page.locator(`${dialog}[open]`).waitFor();
      expect(await paneBox(page, dialog)).toMatchObject({ open: true, pane: false, position: "fixed" });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(heading.slice(1));
      await page.keyboard.press("Escape");
      await page.locator(dialog).waitFor({ state: "hidden" });
      await waitForFocus(page, "btnRoomOptions");
    }

    // A preference change applies to an open pane when Settings closes.
    await openSurface(page, "#btnTasks");
    await page.locator("#tasksDialog.is-pane[open]").waitFor();
    await openSettings(page);
    expect(await page.locator('[data-panel-mode="tasks"]').inputValue()).toBe("pane");
    expect(await page.locator('[data-panel-mode="files"]').inputValue()).toBe("dialog");
    await page.locator('[data-panel-mode="tasks"]').selectOption("dialog");
    await page.locator("#btnCloseSettings").click();
    await page.waitForFunction(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#tasksDialog")!;
      return dialog.open && !dialog.classList.contains("is-pane");
    });
    expect(await paneBox(page, "#tasksDialog")).toMatchObject({ pane: false, position: "fixed" });
    await page.locator("#btnCloseTasks").click();
    await waitForFocus(page, "btnRoomOptions");

    // Choose side panes for the other three surfaces and persist one object.
    await openSettings(page);
    await page.locator('[data-panel-mode="announcements"]').selectOption("pane");
    await page.locator('[data-panel-mode="files"]').selectOption("pane");
    await page.locator('[data-panel-mode="reminders"]').selectOption("pane");
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("chat.panelMode") || "{}"))).toEqual({
      announcements: "pane", files: "pane", tasks: "dialog", reminders: "pane",
    });
    if (process.env.CHAT_UI_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "panel-mode-settings.png") });
    }
    await page.locator("#btnCloseSettings").click();

    // Announcements open in the shared split pane.
    await openSurface(page, "#btnAnnouncements");
    await page.locator("#announcementsDialog.is-pane[open]").waitFor();
    expect(await paneBox(page, "#announcementsDialog")).toMatchObject({ position: "relative", column: "4" });
    await page.locator("#announcementStatus").filter({ hasText: "No announcements yet." }).waitFor();
    await page.locator("#btnRefreshAnnouncements").click();
    await page.locator("#announcementStatus").filter({ hasText: "No announcements yet." }).waitFor();
    await page.locator("#btnCloseAnnouncements").click();
    await waitForFocus(page, "btnRoomOptions");

    // Files use the same pane and the shared width handle.
    await openSurface(page, "#btnFiles");
    await page.locator("#filesDialog.is-pane[open]").waitFor();
    await page.locator("#filesEmpty").filter({ hasText: "No files in this room yet." }).waitFor();
    await page.locator("#btnRefreshFiles").click();
    await page.locator("#filesEmpty").filter({ hasText: "No files in this room yet." }).waitFor();
    const before = (await page.locator("#filesDialog").boundingBox())!.width;
    await page.locator("#sidePaneHandle").focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction((width: number) => document.querySelector<HTMLElement>("#filesDialog")!.getBoundingClientRect().width > width, before);
    expect(await page.locator("#sidePaneHandle").getAttribute("aria-valuenow")).not.toBe(String(Math.round(before)));

    // Opening another side pane closes the previous one instead of stacking surfaces.
    await openSurface(page, "#btnReminders");
    await page.locator("#remindersDialog.is-pane[open]").waitFor();
    await page.locator("#filesDialog").waitFor({ state: "hidden" });
    await page.locator("#reminderStatus").filter({ hasText: "No reminders yet." }).waitFor();
    await page.locator("#btnRefreshReminders").click();
    await page.locator("#reminderStatus").filter({ hasText: "No reminders yet." }).waitFor();
    expect(await page.locator("#chatView > dialog.is-pane[open]").count()).toBe(1);
    if (process.env.CHAT_UI_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "panel-mode-reminders-pane.png") });
    }
    await page.locator("#btnCloseReminders").click();
    await waitForFocus(page, "btnRoomOptions");

    // Tasks keeps its dialog preference even at a wide size.
    await openSurface(page, "#btnTasks");
    await page.locator("#tasksDialog[open]").waitFor();
    expect(await paneBox(page, "#tasksDialog")).toMatchObject({ pane: false, position: "fixed" });
    await page.locator("#btnCloseTasks").click();
    await waitForFocus(page, "btnRoomOptions");

    // A narrow window falls back from the pane to the dialog with the same content.
    await page.setViewportSize({ width: 900, height: 700 });
    await openSurface(page, "#btnFiles");
    await page.locator("#filesDialog[open]").waitFor();
    await page.locator("#filesEmpty").filter({ hasText: "No files in this room yet." }).waitFor();
    expect(await paneBox(page, "#filesDialog")).toMatchObject({ pane: false, position: "fixed" });
    expect(await page.locator("#chatView").evaluate((node: HTMLElement) => node.classList.contains("has-pane"))).toBe(false);
    await page.locator("#btnCloseFiles").click();
    await waitForFocus(page, "btnRoomOptions");

    // A short window also falls back even when it is wide.
    await page.setViewportSize({ width: 1280, height: 500 });
    await openSurface(page, "#btnFiles");
    await page.locator("#filesDialog[open]").waitFor();
    expect(await paneBox(page, "#filesDialog")).toMatchObject({ pane: false, position: "fixed" });
    await page.locator("#btnCloseFiles").click();
    await waitForFocus(page, "btnRoomOptions");

    // Resizing an open pane converts it in place without dropping its content.
    await page.setViewportSize({ width: 1280, height: 850 });
    await openSurface(page, "#btnFiles");
    await page.locator("#filesDialog.is-pane[open]").waitFor();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForFunction(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#filesDialog")!;
      return dialog.open && !dialog.classList.contains("is-pane");
    });
    await page.locator("#filesEmpty").filter({ hasText: "No files in this room yet." }).waitFor();
    expect(await paneBox(page, "#filesDialog")).toMatchObject({ pane: false, position: "fixed" });
    await page.locator("#btnCloseFiles").click();
    await waitForFocus(page, "btnRoomOptions");

    // Preferences survive a reload.
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await openSettings(page);
    expect(await page.locator('[data-panel-mode="announcements"]').inputValue()).toBe("pane");
    expect(await page.locator('[data-panel-mode="files"]').inputValue()).toBe("pane");
    expect(await page.locator('[data-panel-mode="tasks"]').inputValue()).toBe("dialog");
    expect(await page.locator('[data-panel-mode="reminders"]').inputValue()).toBe("pane");
    await page.locator("#btnCloseSettings").click();
    await openSurface(page, "#btnFiles");
    await page.locator("#filesDialog.is-pane[open]").waitFor();
    await page.locator("#btnCloseFiles").click();
    await waitForFocus(page, "btnRoomOptions");

    // Bad stored values fall back to the defaults without breaking the page.
    await page.evaluate(() => localStorage.setItem("chat.panelMode", "{not-json"));
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await openSettings(page);
    expect(await page.locator('[data-panel-mode="announcements"]').inputValue()).toBe("dialog");
    expect(await page.locator('[data-panel-mode="files"]').inputValue()).toBe("dialog");
    expect(await page.locator('[data-panel-mode="tasks"]').inputValue()).toBe("pane");
    expect(await page.locator('[data-panel-mode="reminders"]').inputValue()).toBe("dialog");
    await page.locator("#btnCloseSettings").click();
    await openSurface(page, "#btnTasks");
    await page.locator("#tasksDialog.is-pane[open]").waitFor();
    await page.locator("#btnCloseTasks").click();
    await waitForFocus(page, "btnRoomOptions");

    // Invalid values fall back per key without discarding the valid ones.
    await page.evaluate(() => localStorage.setItem("chat.panelMode", JSON.stringify({ files: "bogus", tasks: 42, reminders: "pane" })));
    await page.reload();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await openSettings(page);
    expect(await page.locator('[data-panel-mode="announcements"]').inputValue()).toBe("dialog");
    expect(await page.locator('[data-panel-mode="files"]').inputValue()).toBe("dialog");
    expect(await page.locator('[data-panel-mode="tasks"]').inputValue()).toBe("pane");
    expect(await page.locator('[data-panel-mode="reminders"]').inputValue()).toBe("pane");
    await page.locator("#btnCloseSettings").click();

    expect(nativeDialogs).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function openSurface(page: any, button: string) {
  await page.locator("#btnRoomOptions").click();
  await page.locator(button).click();
}

async function openSettings(page: any) {
  await page.locator("#btnSettings").click();
  await page.locator("#chatSettings[open]").waitFor();
  await page.locator("#settingsTabAppearance").click();
  await page.locator("#settingsPanelAppearance").waitFor({ state: "visible" });
}

async function paneBox(page: any, selector: string) {
  return page.locator(selector).evaluate((node: HTMLDialogElement) => {
    const style = getComputedStyle(node);
    return { open: node.open, pane: node.classList.contains("is-pane"), position: style.position, column: style.gridColumnStart };
  });
}

async function waitForFocus(page: any, id: string) {
  await page.waitForFunction((target: string) => document.activeElement?.id === target, id);
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