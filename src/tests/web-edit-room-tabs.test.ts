/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-edit-room-tabs-token";

test.skipIf(!browserModule)("edit room groups fields into tabs without changing permissions", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-edit-room-tabs-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshotDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any, peerContext: any;
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill("__Test_Owner");
    await page.locator("#inRoomName").fill("__Test_TabsRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");

    // A second human joins in a real browser so the delegated-admin path can be tested.
    peerContext = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const peerPage = await peerContext.newPage();
    peerPage.setDefaultTimeout(15000);
    await peerPage.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await peerPage.goto(`${origin}/chat`);
    await peerPage.evaluate(async ({ url, id }: { url: string; id: string }) => {
      const { app } = await import(url);
      await app.joinRoom(id, "__Test_Admin");
    }, { url: "/assets/chat/state.js", id: roomId });
    await peerPage.locator("#chatView").waitFor({ state: "visible" });

    // A third person can inherit the room; an agent needs a membership binding for the picker.
    const joined = await fetch(`${origin}/rooms/${roomId}/join`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: randomUUID(), participantId: "__Test_NewOwner", participantName: "__Test_NewOwner" }),
    });
    expect(joined.status).toBe(201);
    const agentSession = randomUUID(), membershipID = `__Test_${randomUUID()}`;
    const joinedAgent = await fetch(`${origin}/rooms/${roomId}/join`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: agentSession, participantId: "__Test_Agent", participantName: "__Test_Agent", protocol: "v2", receiverOwnerID: randomUUID() }),
    });
    expect(joinedAgent.status).toBe(201);
    const db = new Database(path.join(stateDir, "chat-room.sqlite"));
    db.exec("PRAGMA busy_timeout = 3000");
    db.query("UPDATE registry SET membership_id=? WHERE room_id=? AND session_id=?").run(membershipID, roomId, agentSession);
    db.close();

    const openDialog = async (target: any = page) => {
      await target.locator("#btnRoomOptions").click();
      await target.locator("#btnEditRoom").click();
      await target.locator("#editRoomDialog[open]").waitFor();
    };
    const closeDialog = async (target: any = page) => {
      await target.locator("#btnCloseEditRoom").click();
      await target.locator("#editRoomDialog").waitFor({ state: "hidden" });
    };
    const submit = async (target: any = page) => {
      await target.locator("#editRoomForm button[type=submit]").click();
      await target.locator("#editRoomDialog").waitFor({ state: "hidden" });
    };
    const roomState = (target: any = page) => target.evaluate(async (url: string) => {
      const { app } = await import(url);
      return app.state.room as { name: string; description?: string; joinPolicy?: string; adminIds?: string[]; successorId?: string | null; adminSessionID?: string; ownerId: string };
    }, "/assets/chat/state.js");

    // Owner: four tabs, details first, correct tab semantics.
    await openDialog();
    expect(await page.locator('#editRoomDialog [role="tab"]').count()).toBe(4);
    expect(await page.locator('#editRoomDialog [role="tab"]:visible').count()).toBe(4);
    expect(await page.locator('#editRoomDialog [role="tabpanel"]').count()).toBe(4);
    for (const [tab, panel] of [["editRoomTabDetails", "editRoomPanelDetails"], ["editRoomTabJoining", "editRoomPanelJoining"], ["editRoomTabMembers", "editRoomPanelMembers"], ["editRoomTabOwnership", "editRoomPanelOwnership"]]) {
      expect(await page.locator(`#${tab}`).getAttribute("role")).toBe("tab");
      expect(await page.locator(`#${tab}`).getAttribute("aria-controls")).toBe(panel);
      expect(await page.locator(`#${panel}`).getAttribute("role")).toBe("tabpanel");
      expect(await page.locator(`#${panel}`).getAttribute("aria-labelledby")).toBe(tab);
    }
    expect(await page.locator("#editRoomTabDetails").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#editRoomTabDetails").getAttribute("tabindex")).toBe("0");
    expect(await page.locator("#editRoomTabJoining").getAttribute("tabindex")).toBe("-1");
    expect(await page.locator("#editRoomPanelDetails").isVisible()).toBe(true);
    for (const panel of ["#editRoomPanelJoining", "#editRoomPanelMembers", "#editRoomPanelOwnership"]) expect(await page.locator(panel).isVisible()).toBe(false);
    expect(await page.locator("#editRoomOwnerOnly").isVisible()).toBe(false); // not selected yet
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "edit-room-desktop-1280.png") });

    // Arrow keys move selection, focus, and the panel; Home/End jump; the tablist keeps one tab stop.
    await page.locator("#editRoomTabDetails").focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.locator("#editRoomTabJoining").getAttribute("aria-selected")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("editRoomTabJoining");
    expect(await page.locator("#editRoomPanelJoining").isVisible()).toBe(true);
    await page.keyboard.press("ArrowDown");
    expect(await page.locator("#editRoomTabMembers").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("End");
    expect(await page.locator("#editRoomTabOwnership").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#editRoomOwnerOnly").isVisible()).toBe(true);
    await page.keyboard.press("ArrowRight");
    expect(await page.locator("#editRoomTabDetails").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("ArrowLeft");
    expect(await page.locator("#editRoomTabOwnership").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("Home");
    expect(await page.locator("#editRoomTabDetails").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#editRoomTabDetails").getAttribute("tabindex")).toBe("0");
    // Enter and Space activate a focused tab like a native button.
    await page.locator("#editRoomTabMembers").focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("#editRoomTabMembers").getAttribute("aria-selected")).toBe("true");
    await page.locator("#editRoomTabJoining").focus();
    await page.keyboard.press("Space");
    expect(await page.locator("#editRoomTabJoining").getAttribute("aria-selected")).toBe("true");

    // Details save and reset-to-details on reopen.
    await page.locator("#editRoomTabDetails").click();
    await page.locator("#editRoomName").fill("__Test_TabsRenamed");
    await page.locator("#editRoomDescription").fill("Tabbed edit room dialog.");
    await submit();
    expect((await roomState()).name).toBe("__Test_TabsRenamed");
    expect((await roomState()).description).toBe("Tabbed edit room dialog.");
    await openDialog();
    expect(await page.locator("#editRoomTabDetails").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#editRoomPanelDetails").isVisible()).toBe(true);

    // A validation error lives in the fixed footer, above Save and outside every panel.
    await page.locator("#editRoomName").fill("   ");
    await page.locator("#editRoomForm button[type=submit]").click();
    expect(await page.locator("#editRoomDialog").evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(true);
    const status = page.locator("#editRoomStatus");
    await status.waitFor({ state: "visible" });
    expect((await status.textContent())?.trim()).not.toBe("");
    const errorLayout = await page.evaluate(() => {
      const statusNode = document.querySelector<HTMLElement>("#editRoomStatus")!;
      const saveNode = document.querySelector<HTMLElement>("#editRoomForm button[type=submit]")!;
      const statusRect = statusNode.getBoundingClientRect(), saveRect = saveNode.getBoundingClientRect();
      return {
        inPanel: Boolean(statusNode.closest('[role="tabpanel"]')),
        below: statusRect.bottom <= saveRect.top,
        visible: statusRect.width > 0 && statusRect.height > 0,
      };
    });
    expect(errorLayout.inPanel).toBe(false);
    expect(errorLayout.below).toBe(true);
    expect(errorLayout.visible).toBe(true);
    await page.locator("#editRoomName").fill("__Test_TabsRenamed");
    await page.locator("#btnCancelEditRoom").click();
    await page.locator("#editRoomDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");

    // Escape and the close button close and restore focus; a backdrop click keeps it open.
    await openDialog();
    await page.keyboard.press("Escape");
    await page.locator("#editRoomDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    await openDialog();
    await page.mouse.click(6, 6);
    expect(await page.locator("#editRoomDialog").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator("#editRoomDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    await openDialog();
    await closeDialog();

    // Joining & approval still saves.
    await openDialog();
    await page.locator("#editRoomTabJoining").click();
    await page.locator("#editRoomJoinPolicy").check();
    await submit();
    expect((await roomState()).joinPolicy).toBe("approval");

    // Members & roles still save the admin checklist and successor.
    await openDialog();
    await page.locator("#editRoomTabMembers").click();
    await page.waitForFunction(() => Boolean(document.querySelector('#editRoomAdminIds input[value="__Test_Admin"]')));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "edit-room-desktop-members-1280.png") });
    await page.locator('#editRoomAdminIds input[value="__Test_Admin"]').check();
    await page.locator("#editRoomSuccessor").selectOption("__Test_Admin");
    await submit();
    const memberState = await roomState();
    expect(memberState.adminIds).toContain("__Test_Admin");
    expect(memberState.successorId).toBe("__Test_Admin");

    // A delegated human administrator gets three tabs: Ownership is hidden, the note is shown.
    await waitForRoomState(peerPage, (room) => room?.adminIds?.includes("__Test_Admin"));
    let peerPatch: any = null;
    await peerPage.route(`**/rooms/${roomId}`, async (route: any) => {
      if (route.request().method() === "PATCH") peerPatch = route.request().postDataJSON();
      await route.continue();
    });
    await openDialog(peerPage);
    expect(await peerPage.locator('#editRoomDialog [role="tab"]:visible').count()).toBe(3);
    expect(await peerPage.locator("#editRoomTabOwnership").isVisible()).toBe(false);
    expect(await peerPage.locator("#editRoomPanelOwnership").isVisible()).toBe(false);
    expect(await peerPage.locator("#editRoomTabDetails").getAttribute("aria-selected")).toBe("true");
    await peerPage.locator("#editRoomTabMembers").click();
    expect(await peerPage.locator("#editRoomOwnerOnlyNote").isVisible()).toBe(true);
    expect(await peerPage.locator("#editRoomOwnerOnly").isVisible()).toBe(false);
    // Arrow navigation wraps past the hidden Ownership tab.
    await peerPage.locator("#editRoomTabMembers").focus();
    await peerPage.keyboard.press("ArrowRight");
    expect(await peerPage.locator("#editRoomTabDetails").getAttribute("aria-selected")).toBe("true");
    // A delegate's mobile tab row uses three columns, not an empty fourth slot.
    await peerPage.setViewportSize({ width: 390, height: 740 });
    const peerMobile = await peerPage.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#editRoomDialog")!;
      const nav = dialog.querySelector<HTMLElement>(".edit-room-nav")!;
      const box = dialog.getBoundingClientRect();
      const tabs = Array.from(dialog.querySelectorAll<HTMLElement>('[role="tab"]'))
        .filter((tab) => !tab.hidden)
        .map((tab) => { const rect = tab.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; });
      return {
        columns: getComputedStyle(nav).gridTemplateColumns.split(" ").length,
        overflowX: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        tabs,
        dialogRight: box.right,
      };
    });
    expect(peerMobile.columns).toBe(3);
    expect(peerMobile.overflowX).toBe(0);
    for (const tab of peerMobile.tabs) expect(tab.right).toBeLessThanOrEqual(peerMobile.dialogRight + 0.5);
    await peerPage.setViewportSize({ width: 1280, height: 850 });
    await peerPage.waitForFunction(() => Boolean(document.querySelector('#editRoomAdminIds input[value="__Test_NewOwner"]')));
    await peerPage.locator("#editRoomDescription").fill("Delegated admin edit.");
    await submit(peerPage);
    expect(peerPatch).not.toBeNull();
    expect("adminSessionID" in peerPatch).toBe(false);
    expect("ownerId" in peerPatch).toBe(false);
    expect(peerPatch.adminIds).toContain("__Test_Admin");
    const afterPeer = await roomState(peerPage);
    expect(afterPeer.ownerId).toBe("__Test_Owner");
    expect(afterPeer.adminSessionID).toBeNull();
    expect(afterPeer.description).toBe("Delegated admin edit.");

    // The owner still saves the administrator agent.
    await openDialog();
    await page.locator("#editRoomTabOwnership").click();
    await page.waitForFunction((id: string) => Array.from(document.querySelectorAll<HTMLOptionElement>("#editRoomAdmin option")).some((option) => option.value === id), agentSession);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "edit-room-desktop-ownership-1280.png") });
    await page.locator("#editRoomAdmin").selectOption(agentSession);
    await submit();
    await waitForRoomState(page, (room) => room?.adminSessionID === agentSession);

    // Mobile: four tabs fit, panels scroll internally, and the footer stays put.
    await page.setViewportSize({ width: 390, height: 740 });
    await openDialog();
    const mobile = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#editRoomDialog")!;
      const nav = dialog.querySelector<HTMLElement>(".edit-room-nav")!;
      const content = dialog.querySelector<HTMLElement>(".edit-room-content")!;
      const footer = dialog.querySelector<HTMLElement>(".edit-room-footer")!;
      const save = dialog.querySelector<HTMLElement>('#editRoomForm button[type="submit"]')!;
      const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
      return {
        dialog: rect(dialog), footer: rect(footer), save: rect(save),
        tabs: Array.from(dialog.querySelectorAll<HTMLElement>('[role="tab"]')).map((tab) => ({ id: tab.id, hidden: tab.hidden, ...rect(tab) })),
        columns: getComputedStyle(nav).gridTemplateColumns.split(" ").length,
        panelOverflowX: content.scrollWidth - content.clientWidth,
        pageOverflowX: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        panelOverflowY: getComputedStyle(content).overflowY,
      };
    });
    const visibleTabs = mobile.tabs.filter((tab: { hidden: boolean }) => !tab.hidden);
    expect(visibleTabs.length).toBe(4);
    expect(mobile.columns).toBe(4);
    for (const tab of visibleTabs) {
      expect(tab.width).toBeGreaterThan(60);
      expect(tab.left).toBeGreaterThanOrEqual(mobile.dialog.left);
      expect(tab.right).toBeLessThanOrEqual(mobile.dialog.right);
    }
    expect(mobile.panelOverflowX).toBe(0);
    expect(mobile.pageOverflowX).toBe(0);
    expect(mobile.panelOverflowY).toBe("auto");
    expect(mobile.footer.bottom).toBeLessThanOrEqual(mobile.dialog.bottom);
    expect(mobile.save.bottom).toBeLessThanOrEqual(mobile.footer.bottom);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "edit-room-mobile-390.png") });
    // Tabs stay keyboard-operable at the mobile width.
    await page.locator("#editRoomTabDetails").focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.locator("#editRoomTabJoining").getAttribute("aria-selected")).toBe("true");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("editRoomTabJoining");
    await page.locator("#editRoomTabMembers").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "edit-room-mobile-members-390.png") });
    const scrolledFooter = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>("#editRoomDialog .edit-room-content")!;
      content.scrollTop = content.scrollHeight;
      const footer = document.querySelector<HTMLElement>("#editRoomDialog .edit-room-footer")!.getBoundingClientRect();
      return { top: footer.top, bottom: footer.bottom, viewport: innerHeight, scrollTop: content.scrollTop };
    });
    expect(scrolledFooter.bottom).toBeLessThanOrEqual(scrolledFooter.viewport);
    expect(scrolledFooter.scrollTop).toBeGreaterThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 850 });
    await closeDialog();

    // The owner still hands the room to a person.
    await openDialog();
    await page.locator("#editRoomTabOwnership").click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLOptionElement>("#editRoomOwner option")).some((option) => option.value === "__Test_NewOwner"));
    await page.locator("#editRoomOwner").selectOption("__Test_NewOwner");
    await submit();
    await waitForRoomState(page, (room) => room?.ownerId === "__Test_NewOwner");
    expect(errors).toEqual([]);

    await peerContext.close(); await context.close();
  } finally {
    await peerContext?.close(); await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 120000);

async function waitForRoomState(target: any, check: (room: any) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const room = await target.evaluate(async (url: string) => {
      const { app } = await import(url);
      return app.state.room ? { ...app.state.room } : null;
    }, "/assets/chat/state.js");
    if (check(room)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Room state did not settle");
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