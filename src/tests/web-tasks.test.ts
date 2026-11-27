/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { installTaskRoutes, type TaskApi } from "./web-tasks-mock.ts";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-tasks-token";
const roomName = "__Test_TasksRoom";
const ownerName = "__Test_TasksOwner";
const agentName = "__Test_TasksAgent";

test.skipIf(!browserModule)("room tasks pane, fields, steps, permissions, and clear completed", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-tasks-"));
  const screenshotDir = process.env.CHAT_UI_SCREENSHOT_DIR || stateDir;
  await mkdir(screenshotDir, { recursive: true });
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], { cwd: process.cwd(), env: isolatedEnv(stateDir, port), stdio: "ignore" });
  let browser: any, agentContext: any;
  const pageErrors: string[] = [], nativeDialogs: string[] = [];
  const api: TaskApi = { tasks: [], names: new Map(), admins: new Set(), clock: Date.now(), clearUrls: [], limit: 10, exposeLimit: true, createCalls: 0 };
  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("dialog", (dialog: any) => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    await installTaskRoutes(page, api);
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await page.goto(`${origin}/chat`);
    await page.locator("#inName").fill(ownerName);
    await page.locator("#inRoomName").fill(roomName);
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    const roomId = await page.evaluate(() => sessionStorage.getItem("chat.roomId") || "");
    const ownerSession = await page.evaluate(async (url: string) => (await import(url)).app.LS.sessionID, "/assets/chat/state.js");
    api.names.set(ownerSession, ownerName);
    api.admins.add(ownerSession);

    const agentSession = randomUUID();
    api.names.set(agentSession, agentName);
    const joined = await fetch(`${origin}/rooms/${roomId}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: agentSession, participantId: agentName, participantName: agentName }),
    });
    expect(joined.status).toBe(201);
    await page.waitForFunction(async ({ url, name }: { url: string; name: string }) => {
      const { app } = await import(url);
      return app.state.room?.participants?.some((person: { name: string }) => person.name === name);
    }, { url: "/assets/chat/state.js", name: agentName });

    // Tasks sits next to Files in the Options menu and opens a side pane at this width.
    await page.locator("#btnRoomOptions").click();
    const menuLabels = await page.locator("#roomOptions .menu-action span").allTextContents();
    expect(menuLabels[menuLabels.indexOf("Tasks") - 1]).toBe("Files");
    expect(menuLabels.indexOf("Tasks")).toBe(menuLabels.indexOf("Files") + 1);
    await page.locator("#btnTasks").click();
    await page.locator("#tasksDialog[open]").waitFor();
    await page.locator("#tasksEmpty").filter({ hasText: "No tasks yet" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tasksHeading");
    const wide = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("#chatView")!;
      const pane = document.querySelector<HTMLElement>("#tasksDialog")!;
      const viewBox = view.getBoundingClientRect(), paneBox = pane.getBoundingClientRect();
      return {
        hasTasks: view.classList.contains("has-tasks"),
        columns: getComputedStyle(view).gridTemplateColumns.split(" ").length,
        position: getComputedStyle(pane).position,
        column: getComputedStyle(pane).gridColumnStart,
        paneWidth: paneBox.width, paneLeft: paneBox.left, paneRight: paneBox.right,
        viewRight: viewBox.right,
        chatWidth: document.querySelector<HTMLElement>("#msgScroll")!.getBoundingClientRect().width,
      };
    });
    expect(wide.hasTasks).toBe(true);
    expect(wide.columns).toBe(4);
    expect(wide.position).toBe("relative");
    expect(wide.column).toBe("4");
    expect(wide.paneWidth).toBeGreaterThanOrEqual(379);
    expect(wide.paneWidth).toBeLessThanOrEqual(461);
    expect(Math.abs(wide.paneRight - wide.viewRight)).toBeLessThanOrEqual(2);
    expect(wide.chatWidth).toBeGreaterThan(300);
    // The shared separator is the only width control; the room rail stays fixed.
    const handle = page.locator("#sidePaneHandle");
    await handle.waitFor({ state: "visible" });
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("#roomRail")!.getBoundingClientRect().width)).toBe(252);
    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 - 120, handleBox.y + handleBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction((expected: number) => Math.abs(document.querySelector("#tasksDialog")!.getBoundingClientRect().width - expected) <= 2, wide.paneWidth + 120);
    const resized = await page.evaluate(() => ({
      rail: document.querySelector<HTMLElement>("#roomRail")!.getBoundingClientRect().width,
      pane: document.querySelector<HTMLElement>("#tasksDialog")!.getBoundingClientRect().width,
      chat: document.querySelector<HTMLElement>("#msgScroll")!.getBoundingClientRect().width,
    }));
    expect(resized.rail).toBe(252);
    expect(resized.chat).toBeLessThan(wide.chatWidth - 100);
    expect(Number(await page.evaluate(() => localStorage.getItem("chat.sidePaneWidth")))).toBe(Math.round(resized.pane));
    // Double-click restores the default width so the rest of the run uses it.
    await handle.dblclick();
    await page.waitForFunction((expected: number) => Math.abs(document.querySelector("#tasksDialog")!.getBoundingClientRect().width - expected) <= 2, wide.paneWidth);
    // At 1500x900 the board widens while the chat keeps a 700px column; 1440 stays compact.
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.waitForTimeout(120);
    const large = await page.evaluate(() => { const width = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().width; return { pane: width("#tasksDialog"), chat: width("#msgScroll"), rail: width("#roomRail"), overflow: document.documentElement.scrollWidth - innerWidth }; });
    expect(large).toMatchObject({ rail: 252, overflow: 0 });
    expect(large.pane).toBeGreaterThanOrEqual(500);
    expect(large.chat).toBeGreaterThanOrEqual(700);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(120);
    const medium = await page.evaluate(() => { const width = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().width; return { pane: width("#tasksDialog"), chat: width("#msgScroll") }; });
    expect(medium.pane).toBeGreaterThanOrEqual(430);
    expect(medium.pane).toBeLessThanOrEqual(434);
    expect(medium.chat).toBeGreaterThanOrEqual(700);
    // 1920x1080 spends the extra width on the pane: the app grows to 2200,
    // the task pane defaults to 920 and the chat keeps its 700px column.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(120);
    const huge = await page.evaluate(() => { const width = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().width; return { app: width("#app"), pane: width("#tasksDialog"), chat: width("#msgScroll"), rail: width("#roomRail"), overflow: document.documentElement.scrollWidth - innerWidth }; });
    expect(huge).toMatchObject({ rail: 252, overflow: 0 });
    expect(huge.app).toBeGreaterThan(1440);
    expect(huge.app).toBeLessThanOrEqual(2200);
    expect(huge.pane).toBeGreaterThanOrEqual(918);
    expect(huge.pane).toBeLessThanOrEqual(922);
    expect(huge.chat).toBeGreaterThanOrEqual(700);
    // Double-click reset returns to the new wide default, not the 1440 one.
    await handle.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector("#tasksDialog")!.getBoundingClientRect().width > 780);
    await handle.dblclick();
    await page.waitForFunction(() => Math.abs(document.querySelector("#tasksDialog")!.getBoundingClientRect().width - 920) <= 2);
    expect(await page.evaluate(() => localStorage.getItem("chat.sidePaneWidth"))).toBeNull();
    await page.setViewportSize({ width: 1280, height: 850 });
    // The pane is not modal: the conversation stays usable beside it.
    await page.locator("#msgInput").click();
    await page.keyboard.type("Message while tasks open");
    await page.keyboard.press("Enter");
    await page.locator("#msgList").getByText("Message while tasks open").waitFor();
    expect(await page.evaluate(() => document.querySelector("#chatView")!.classList.contains("has-tasks"))).toBe(true);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "web-tasks-wide-empty-1280.png") });

    // Add a task with every field; participants come from current room members.
    await page.locator("#taskCreateDetails summary").click();
    await page.locator("#taskAssignee option").filter({ hasText: agentName }).waitFor({ state: "attached" });
    expect(await page.locator("#taskAssignee option").allTextContents()).toEqual(expect.arrayContaining(["Unassigned", agentName]));
    await page.locator("#taskTitle").fill("Review launch checklist");
    await page.locator("#taskDescription").fill("Check links, screenshots, and rollback steps.");
    await page.locator("#taskDueDate").fill("2026-12-31");
    await page.locator("#taskAssignee").selectOption({ label: agentName });
    await page.locator("#taskCreateParticipants .task-person").filter({ hasText: agentName }).locator("input").check();
    await page.locator("#taskConclusion").fill("Ready for release.");
    await page.locator("#btnAddCreateStep").click();
    await page.locator("#btnAddCreateStep").click();
    await page.locator("#btnAddCreateStep").click();
    await page.locator("#taskCreateSteps .task-step-remove").nth(2).click();
    expect(await page.locator("#taskCreateSteps .task-step-row").count()).toBe(2);
    await page.locator("#taskCreateSteps .task-step-text").nth(0).fill("Draft the checklist");
    await page.locator("#taskCreateSteps .task-step-text").nth(1).fill("Publish the notes");
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "web-tasks-wide-create-1280.png") });
    await page.locator("#btnCreateTask").click();
    let row = page.locator("#taskGroups .task-row").filter({ hasText: "Review launch checklist" });
    await row.waitFor();
    expect(await row.locator(".task-status").textContent()).toBe("To do");
    expect(await row.locator(".task-description").textContent()).toBe("Check links, screenshots, and rollback steps.");
    expect(await row.locator(".task-assignee").textContent()).toContain(`Assignee: ${agentName}`);
    expect(await row.locator(".task-creator").textContent()).toBe(`Created by ${ownerName}`);
    expect(await row.locator(".task-participants").textContent()).toBe(`Participants: ${agentName}`);
    expect(await row.locator(".task-due").textContent()).toContain("Dec 31, 2026");
    expect(await row.locator(".task-progress-head").textContent()).toBe("0 of 2 steps done");
    expect(await row.locator(".task-step").count()).toBe(2);
    expect(await row.locator(".task-step-toggle").first().isEnabled()).toBe(true);
    expect(await row.locator(".task-conclusion").textContent()).toContain("Ready for release.");
    expect(await row.locator(".task-updated").textContent()).toMatch(/\d/);
    expect(await page.locator("#tasksSummary").textContent()).toBe("1 task");
    expect(await row.locator('[data-task-action="edit"]').count()).toBe(1);
    expect(await row.locator('[data-task-action="delete"]').count()).toBe(1);

    // A second task exercises the in-app delete confirmation only.
    await page.locator("#taskCreateDetails summary").click();
    await page.locator("#taskTitle").fill("Temporary item");
    await page.locator("#btnCreateTask").click();
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 2);
    const temporary = page.locator("#taskGroups .task-row").filter({ hasText: "Temporary item" });
    await temporary.locator('[data-task-action="delete"]').click();
    await page.locator("#confirmDialog[open]").waitFor();
    expect(await page.locator("#confirmMessage").textContent()).toContain("Temporary item");
    await page.locator("#btnAcceptConfirm").click();
    await page.locator("#confirmDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 1);

    // Status changes regroup the row, and the filter narrows the board.
    row = page.locator("#taskGroups .task-row").filter({ hasText: "Review launch checklist" });
    await row.locator(".task-status-select").selectOption("doing");
    await page.locator('#taskGroups .task-row[data-status="doing"]').waitFor();
    expect(await page.locator(".task-group-title").last().textContent()).toContain("Doing");
    await page.locator("#taskFilter").selectOption("doing");
    expect(await page.locator("#taskGroups .task-row").count()).toBe(1);
    await page.locator("#taskFilter").selectOption("todo");
    await page.locator("#tasksEmpty").filter({ hasText: "No tasks with this status." }).waitFor();
    expect(await page.locator("#taskGroups .task-row").count()).toBe(0);
    await page.locator("#taskFilter").selectOption("all");

    // Adding stays inline in the pane; it never opens the edit modal.
    await page.locator("#taskCreateDetails summary").click();
    await page.locator("#taskCreateForm").waitFor({ state: "visible" });
    expect(await page.locator("#taskEditDialog").isVisible()).toBe(false);
    await page.locator("#taskCreateDetails summary").click();

    // Edit opens a labelled modal prefilled with every field; the title takes focus.
    await page.locator('#taskGroups [data-task-action="edit"]').click();
    await page.locator("#taskEditDialog[open]").waitFor();
    await page.locator(".task-edit-form").waitFor();
    expect(await page.locator("#tasksDialog").getAttribute("open")).not.toBeNull();
    expect(await page.locator("#taskGroups .task-edit-form").count()).toBe(0);
    expect(await page.locator("#taskEditDialog").getAttribute("aria-labelledby")).toBe("taskEditHeading");
    expect(await page.locator("#taskEditHeading").textContent()).toBe("Edit task");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("task-edit-title"))).toBe(true);
    expect(await page.locator(".task-edit-title").inputValue()).toBe("Review launch checklist");
    expect(await page.locator(".task-edit-description").inputValue()).toBe("Check links, screenshots, and rollback steps.");
    expect(await page.locator(".task-edit-due").inputValue()).toBe("2026-12-31");
    expect(await page.locator(".task-edit-assignee").inputValue()).toBe(agentName);
    expect(await page.locator(".task-edit-participants-field .task-person input:checked").count()).toBe(1);
    expect(await page.locator(".task-edit-conclusion").inputValue()).toBe("Ready for release.");
    expect(await page.locator(".task-edit-steps-field .task-step-text").nth(0).inputValue()).toBe("Draft the checklist");
    expect(await page.locator(".task-edit-steps-field .task-step-text").nth(1).inputValue()).toBe("Publish the notes");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(120);
    const lightFieldColors = await fieldGroupColors(page, ".task-edit-participants-field", ".task-edit-steps-field", ".task-edit-description");
    expect(lightFieldColors.participantsBorder).toBe(lightFieldColors.inputBorder);
    expect(lightFieldColors.stepsBorder).toBe(lightFieldColors.inputBorder);
    expect(lightFieldColors.participantsBackground).toBe(lightFieldColors.inputBackground);
    expect(lightFieldColors.stepsBackground).toBe(lightFieldColors.inputBackground);
    expect(lightFieldColors.participantsWidth).toBe("1px");
    expect(lightFieldColors.stepsWidth).toBe("1px");
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.setTheme("dark");
    }, "/assets/chat/state.js");
    await page.waitForTimeout(300);
    const darkFieldColors = await fieldGroupColors(page, ".task-edit-participants-field", ".task-edit-steps-field", ".task-edit-description");
    expect(darkFieldColors.participantsBorder).toBe(darkFieldColors.inputBorder);
    expect(darkFieldColors.stepsBorder).toBe(darkFieldColors.inputBorder);
    expect(darkFieldColors.participantsBackground).toBe(darkFieldColors.inputBackground);
    expect(darkFieldColors.stepsBackground).toBe(darkFieldColors.inputBackground);
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.setTheme("light");
    }, "/assets/chat/state.js");
    await page.waitForTimeout(300);
    // A refresh cannot discard the open draft while the modal owns it.
    expect(await page.locator("#btnRefreshTasks").isDisabled()).toBe(true);
    expect(await page.locator(".task-edit-title").inputValue()).toBe("Review launch checklist");
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "web-tasks-edit-modal-1280.png") });

    // Cancel and Escape discard the draft and return focus to the row's edit button.
    await page.locator(".task-edit-title").fill("Cancelled title");
    await page.locator(".task-edit-actions .btn.ghost").click();
    await page.locator("#taskEditDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-task-action") === "edit");
    expect(await page.locator(".task-edit-form").count()).toBe(0);
    expect(await page.locator("#taskGroups .task-title").textContent()).toBe("Review launch checklist");
    expect(await page.locator("#btnRefreshTasks").isEnabled()).toBe(true);
    await page.locator('#taskGroups [data-task-action="edit"]').click();
    await page.locator("#taskEditDialog[open]").waitFor();
    expect(await page.locator(".task-edit-title").inputValue()).toBe("Review launch checklist");
    await page.locator(".task-edit-title").fill("Escape title");
    await page.keyboard.press("Escape");
    await page.locator("#taskEditDialog").waitFor({ state: "hidden" });
    expect(await page.locator("#tasksDialog").getAttribute("open")).not.toBeNull();
    expect(await page.locator("#taskGroups .task-title").textContent()).toBe("Review launch checklist");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-task-action") === "edit");
    // A backdrop click keeps the editor open; Escape is the cancel path that keeps the old card.
    await page.locator('#taskGroups [data-task-action="edit"]').click();
    await page.locator("#taskEditDialog[open]").waitFor();
    await page.locator(".task-edit-title").fill("Backdrop title");
    await page.mouse.click(4, 4);
    expect(await page.locator("#taskEditDialog").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator("#taskEditDialog").waitFor({ state: "hidden" });
    expect(await page.locator("#taskGroups .task-title").textContent()).toBe("Review launch checklist");

    // Saving updates the one card and keeps the pane and room state.
    await page.locator('#taskGroups [data-task-action="edit"]').click();
    await page.locator("#taskEditDialog[open]").waitFor();
    await page.locator(".task-edit-title").fill("Review launch checklist v2");
    await page.locator(".task-edit-description").fill("Updated acceptance notes.");
    await page.locator(".task-edit-due").fill("2027-01-15");
    await page.locator(".task-edit-conclusion").fill("Signed off after review.");
    await page.locator(".task-edit-participants-field .task-person").filter({ hasText: ownerName }).locator("input").check();
    await page.locator(".task-edit-steps-field .task-add-step").click();
    await page.locator(".task-edit-steps-field .task-step-text").nth(2).fill("Announce the release");
    await page.locator(".task-edit-steps-field .task-step-done").nth(2).check();
    await page.locator('.task-edit-actions button[type="submit"]').click();
    await page.locator("#taskEditDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-task-action") === "edit");
    expect(await page.locator("#taskGroups .task-row").count()).toBe(1);
    expect(await page.locator("#tasksDialog").getAttribute("open")).not.toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem("chat.roomId"))).toBe(roomId);
    row = page.locator("#taskGroups .task-row").filter({ hasText: "Review launch checklist v2" });
    await row.waitFor();
    expect(await row.locator(".task-description").textContent()).toBe("Updated acceptance notes.");
    expect(await row.locator(".task-assignee").textContent()).toContain(`Assignee: ${agentName}`);
    expect(await row.locator(".task-participants").textContent()).toContain(agentName);
    expect(await row.locator(".task-participants").textContent()).toContain(ownerName);
    expect(await row.locator(".task-due").textContent()).toContain("Jan 15, 2027");
    expect(await row.locator(".task-progress-head").textContent()).toBe("1 of 3 steps done");
    expect(await row.locator(".task-conclusion").textContent()).toContain("Signed off after review.");

    // Crossing the pane breakpoint keeps the list, switching between pane and modal.
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForFunction(() => !document.querySelector("#tasksDialog")!.classList.contains("is-pane"));
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#tasksDialog")!).position)).toBe("fixed");
    expect(await page.locator("#taskGroups .task-row").count()).toBe(1);
    expect(await page.evaluate(() => document.querySelector("#chatView")!.classList.contains("has-tasks"))).toBe(false);
    expect(await handle.isVisible()).toBe(false);
    // Editing from the modal board opens the same edit dialog above it.
    await page.locator('#taskGroups [data-task-action="edit"]').click();
    await page.locator("#taskEditDialog[open]").waitFor();
    expect(await page.locator("#tasksDialog").getAttribute("open")).not.toBeNull();
    expect(await page.locator(".task-edit-title").inputValue()).toBe("Review launch checklist v2");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("task-edit-title"))).toBe(true);
    await page.locator(".task-edit-title").fill("Modal board draft");
    // A breakpoint change while editing waits for the modal and keeps the draft.
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.waitForTimeout(120);
    expect(await page.locator("#taskEditDialog").isVisible()).toBe(true);
    expect(await page.locator(".task-edit-title").inputValue()).toBe("Modal board draft");
    await page.keyboard.press("Escape");
    await page.locator("#taskEditDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#chatView")!.classList.contains("has-tasks"));
    expect(await page.locator("#tasksDialog").getAttribute("open")).not.toBeNull();
    expect(await page.locator("#taskGroups .task-title").textContent()).toBe("Review launch checklist v2");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-task-action") === "edit");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#tasksDialog")!).position)).toBe("relative");
    expect(await page.locator("#taskGroups .task-row").count()).toBe(1);
    expect(await handle.isVisible()).toBe(true);

    // Markdown preview wins the third column; closing it brings the open task pane back.
    const resource = await uploadMarkdown(origin, roomId, ownerSession, "TASKS-NOTES.md", "# Notes\n\nTask context.");
    await page.evaluate(async ({ url, id, sessionID, text }: any) => {
      const { app } = await import(url);
      await app.api(`/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ sessionID, text }) });
    }, { url: "/assets/chat/state.js", id: roomId, sessionID: ownerSession, text: `[[resource:${resource.id}]]` });
    const card = page.locator(`.chat-resource[data-resource-id="${resource.id}"]`);
    await card.getByText("TASKS-NOTES.md").waitFor();
    await card.getByRole("button", { name: "Preview: TASKS-NOTES.md" }).click();
    await page.locator("#docPreview[open]").waitFor();
    await page.waitForFunction(() => document.querySelector("#chatView")!.classList.contains("has-doc"));
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#tasksDialog")!).display)).toBe("none");
    // One separator still serves the visible preview while Tasks waits underneath.
    expect(await page.locator("#sidePaneHandle").count()).toBe(1);
    expect(await handle.isVisible()).toBe(true);
    // Opening Tasks while the preview owns the column must take the column back.
    await openTasks(page);
    await page.locator("#docPreview").waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector("#chatView")!.classList.contains("has-doc"));
    await page.locator("#tasksDialog[open]").waitFor({ state: "visible" });
    expect(await page.locator("#taskGroups .task-row").count()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tasksHeading");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(screenshotDir, "web-tasks-wide-list-1280.png") });

    // The side pane stays open across room switches and reloads the new room's tasks.
    await page.evaluate(async (url: string) => {
      const { app } = await import(url);
      app.openCreateRoomDialog();
      document.querySelector<HTMLInputElement>("#inRoomNameChat")!.value = "__Test_TasksRoomTwo";
      await app.createRoom();
    }, "/assets/chat/state.js");
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 0);
    expect(await page.evaluate(() => document.querySelector("#tasksDialog")?.hasAttribute("open"))).toBe(true);
    await page.evaluate(async ({ url, id }: any) => {
      const { app } = await import(url);
      app.activateRoom(id);
    }, { url: "/assets/chat/state.js", id: roomId });
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 1);
    expect(await page.evaluate(() => document.querySelector("#tasksDialog")?.hasAttribute("open"))).toBe(true);
    // A switch during an in-flight load must not leave the pane stuck busy.
    expect(await page.locator("#btnRefreshTasks").isEnabled()).toBe(true);
    expect(await page.locator("#tasksDialog").getAttribute("aria-busy")).toBe("false");

    // The pane close button and Escape restore focus to Options.
    await page.locator("#btnCloseTasks").click();
    await page.locator("#tasksDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    await openTasks(page);
    await page.locator("#tasksHeading").focus();
    await page.keyboard.press("Escape");
    await page.locator("#tasksDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");

    // Alt+Esc is the dedicated pane close: same focus return, no plain-Escape regression.
    await openTasks(page);
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 1);
    await page.keyboard.press("Alt+Escape");
    await page.locator("#tasksDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    // A modal editor above the pane keeps Alt+Esc for itself.
    await openTasks(page);
    await page.locator('#taskGroups [data-task-action="edit"]').click();
    await page.locator("#taskEditDialog[open]").waitFor();
    await page.keyboard.press("Alt+Escape");
    await page.waitForTimeout(100);
    expect(await page.locator("#taskEditDialog").isVisible()).toBe(true);
    expect(await page.locator("#tasksDialog").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator("#taskEditDialog").waitFor({ state: "hidden" });
    expect(await page.locator("#tasksDialog").isVisible()).toBe(true);
    // IME composition must not close the pane either.
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", altKey: true, isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(100);
    expect(await page.locator("#tasksDialog").isVisible()).toBe(true);
    await page.keyboard.press("Alt+Escape");
    await page.locator("#tasksDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    // The narrow fallback modal uses the same shortcut.
    await page.setViewportSize({ width: 900, height: 700 });
    await openTasks(page);
    await page.waitForFunction(() => !document.querySelector("#tasksDialog")!.classList.contains("is-pane"));
    await page.keyboard.press("Alt+Escape");
    await page.locator("#tasksDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    await page.setViewportSize({ width: 1280, height: 850 });

    // The Alt+Space palette offers Tasks and closes without stealing dialog focus.
    await page.locator("#msgInput").click();
    await page.keyboard.press("Alt+Space");
    await page.locator("#paletteDialog[open]").waitFor();
    await page.locator("#paletteInput").fill("/");
    expect(await page.locator("#paletteList .palette-command .palette-label").allTextContents()).toContain("Tasks");
    await page.locator("#paletteList .palette-command").filter({ hasText: "Tasks" }).click();
    await page.locator("#tasksDialog[open]").waitFor();
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 1);
    await page.keyboard.press("Escape");
    await page.locator("#tasksDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => ["btnRoomOptions", "msgInput"].includes(document.activeElement?.id || ""));

    // 390px and 320px keep the page, modal, form, and every row inside the viewport.
    for (const [width, height] of [[390, 740], [320, 700]] as const) {
      await page.setViewportSize({ width, height });
      await openTasks(page);
      const modal = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>("#tasksDialog")!;
        const box = pane.getBoundingClientRect();
        return {
          position: getComputedStyle(pane).position,
          hasTasks: document.querySelector("#chatView")!.classList.contains("has-tasks"),
          top: box.top, bottom: box.bottom,
        };
      });
      expect(modal.position).toBe("fixed");
      expect(modal.hasTasks).toBe(false);
      expect(modal.top).toBeGreaterThanOrEqual(0);
      expect(modal.bottom).toBeLessThanOrEqual(height + 0.5);
      await page.locator("#taskCreateDetails summary").click();
      await page.locator("#btnAddCreateStep").click();
      await page.waitForTimeout(250);
      const mobileFieldColors = await fieldGroupColors(page, ".task-create-participants", ".task-create-steps", "#taskDescription");
      expect(mobileFieldColors.participantsBorder).toBe(mobileFieldColors.inputBorder);
      expect(mobileFieldColors.stepsBorder).toBe(mobileFieldColors.inputBorder);
      expect(mobileFieldColors.participantsBackground).toBe(mobileFieldColors.inputBackground);
      expect(mobileFieldColors.stepsBackground).toBe(mobileFieldColors.inputBackground);
      if (width === 390) {
        await page.evaluate(async (url: string) => {
          const { app } = await import(url);
          app.setTheme("dark");
        }, "/assets/chat/state.js");
        await page.waitForTimeout(300);
        const darkCreateColors = await fieldGroupColors(page, ".task-create-participants", ".task-create-steps", "#taskDescription");
        expect(darkCreateColors.participantsBorder).toBe(darkCreateColors.inputBorder);
        expect(darkCreateColors.stepsBorder).toBe(darkCreateColors.inputBorder);
        expect(darkCreateColors.participantsBackground).toBe(darkCreateColors.inputBackground);
        expect(darkCreateColors.stepsBackground).toBe(darkCreateColors.inputBackground);
        await page.evaluate(async (url: string) => {
          const { app } = await import(url);
          app.setTheme("light");
        }, "/assets/chat/state.js");
        await page.waitForTimeout(300);
      }
      const metrics = await overflowMetrics(page);
      expect(metrics.pageOverflow).toBe(0);
      expect(metrics.dialogOverflow).toBe(0);
      expect(metrics.scrollOverflow).toBe(0);
      expect(metrics.formOverflow).toBe(0);
      expect(metrics.dialog.left).toBeGreaterThanOrEqual(0);
      expect(metrics.dialog.right).toBeLessThanOrEqual(width);
      for (const rect of metrics.rows) {
        expect(rect.left).toBeGreaterThanOrEqual(metrics.dialog.left - 0.5);
        expect(rect.right).toBeLessThanOrEqual(metrics.dialog.right + 0.5);
      }
      await page.screenshot({ path: path.join(screenshotDir, `web-tasks-mobile-${width}.png`) });
      await page.keyboard.press("Escape");
      await page.locator("#tasksDialog").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");
    }
    await page.setViewportSize({ width: 1280, height: 850 });

    // A non-admin assignee sees only the status control; the creator sees edit and delete.
    agentContext = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "light" });
    const agentPage = await agentContext.newPage();
    agentPage.setDefaultTimeout(15000);
    agentPage.on("pageerror", (error: Error) => pageErrors.push(error.message));
    agentPage.on("dialog", (dialog: any) => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    await installTaskRoutes(agentPage, api);
    await agentPage.addInitScript((identity: { token: string; sessionID: string; name: string; roomId: string }) => {
      localStorage.setItem("chat.token", identity.token);
      localStorage.setItem("chat.browserIdentity", JSON.stringify({ sessionID: identity.sessionID, name: identity.name }));
      sessionStorage.setItem("chat.roomId", identity.roomId);
      sessionStorage.setItem("chat.joinedRoomIds", JSON.stringify([identity.roomId]));
    }, { token, sessionID: agentSession, name: agentName, roomId });
    await agentPage.goto(`${origin}/chat`);
    await agentPage.locator("#chatView").waitFor({ state: "visible" });
    await agentPage.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, roomName);
    await openTasks(agentPage);
    await agentPage.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 1);
    const agentRow = agentPage.locator("#taskGroups .task-row").filter({ hasText: "Review launch checklist v2" });
    expect(await agentRow.locator(".task-assignee").textContent()).toContain(`Assignee: ${agentName}`);
    expect(await agentRow.locator(".task-status-select").count()).toBe(1);
    expect(await agentRow.locator('[data-task-action="edit"]').count()).toBe(0);
    expect(await agentRow.locator('[data-task-action="delete"]').count()).toBe(0);
    // The assignee may tick steps without gaining edit rights over their text.
    expect(await agentRow.locator(".task-step-toggle").count()).toBe(3);
    expect(await agentRow.locator(".task-step-toggle").first().isEnabled()).toBe(true);
    await agentRow.locator(".task-step-toggle").first().check();
    await agentPage.locator("#taskGroups .task-progress-head").filter({ hasText: "2 of 3 steps done" }).waitFor();
    await agentPage.locator("#taskCreateDetails summary").click();
    await agentPage.locator("#taskTitle").fill("Agent-owned follow-up");
    await agentPage.locator("#btnCreateTask").click();
    await agentPage.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 2);
    const ownRow = agentPage.locator("#taskGroups .task-row").filter({ hasText: "Agent-owned follow-up" });
    expect(await ownRow.locator('[data-task-action="edit"]').count()).toBe(1);
    expect(await ownRow.locator('[data-task-action="delete"]').count()).toBe(1);
    await ownRow.locator(".task-status-select").selectOption("done");
    await agentPage.locator('#taskGroups .task-row[data-status="done"]').waitFor();
    await agentPage.waitForTimeout(250);
    await agentPage.screenshot({ path: path.join(screenshotDir, "web-tasks-agent-actions-1280.png") });
    await agentPage.keyboard.press("Escape");
    await agentPage.locator("#tasksDialog").waitFor({ state: "hidden" });
    await agentPage.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");

    // The creator/admin clears only completed tasks, then the list and summary refresh.
    await openTasks(page);
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 2);
    const refreshed = page.locator("#taskGroups .task-row").filter({ hasText: "Review launch checklist v2" });
    await refreshed.locator(".task-progress-head").filter({ hasText: "2 of 3 steps done" }).waitFor();
    await page.locator("#btnTasksMenu").click();
    await page.locator("#tasksMenu").waitFor({ state: "visible" });
    expect(await page.locator("#btnClearCompleted").isEnabled()).toBe(true);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(screenshotDir, "web-tasks-clear-menu-1280.png") });
    await page.locator("#btnClearCompleted").click();
    await page.locator("#confirmDialog[open]").waitFor();
    expect(await page.locator("#confirmMessage").textContent()).toBe("Clear 1 completed task? This cannot be undone.");
    await page.locator("#btnAcceptConfirm").click();
    await page.locator("#confirmDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 1);
    expect(await page.locator("#taskGroups .task-row .task-title").textContent()).toBe("Review launch checklist v2");
    expect(await page.locator("#tasksSummary").textContent()).toBe("1 task");
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>("#btnClearCompleted")!.disabled);
    expect(api.clearUrls).toEqual([`/rooms/${roomId}/tasks`]);
    expect(await page.locator("#btnCreateTask").isEnabled()).toBe(true);

    // The room task limit is visible and blocks new tasks without hiding or locking existing rows.
    const limitRow = page.locator("#taskGroups .task-row").filter({ hasText: "Review launch checklist v2" });
    await limitRow.locator(".task-status-select").selectOption("done");
    await page.locator('#taskGroups .task-row[data-status="done"]').waitFor();
    api.limit = 1;
    api.exposeLimit = false;
    await page.locator("#btnRefreshTasks").click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#btnCreateTask")!.disabled);
    expect(await page.locator("#tasksLimitNotice").isVisible()).toBe(false);
    await page.locator("#taskCreateDetails summary").click();
    await page.locator("#taskTitle").fill("Over the limit");
    const beforeLimitPost = api.createCalls;
    await page.locator("#btnCreateTask").click();
    await page.locator("#tasksErrorText").filter({ hasText: "Task limit reached" }).waitFor();
    expect(api.createCalls).toBe(beforeLimitPost + 1);
    expect(await page.locator("#taskGroups .task-row").count()).toBe(1);

    api.exposeLimit = true;
    await page.locator("#btnRefreshTasks").click();
    await page.locator("#tasksLimitNotice").waitFor({ state: "visible" });
    expect(await page.locator("#tasksLimitNotice").textContent()).toContain("task limit (1)");
    expect(await page.locator("#btnCreateTask").isDisabled()).toBe(true);
    expect(await limitRow.locator('[data-task-action="edit"]').isEnabled()).toBe(true);
    expect(await limitRow.locator('[data-task-action="delete"]').isEnabled()).toBe(true);
    await page.locator("#btnTasksMenu").click();
    expect(await page.locator("#btnClearCompleted").isEnabled()).toBe(true);
    await page.keyboard.press("Escape");
    await limitRow.locator('[data-task-action="edit"]').click();
    await page.locator("#taskEditDialog[open]").waitFor();
    expect(await page.locator(".task-edit-title").inputValue()).toBe("Review launch checklist v2");
    await page.locator(".task-edit-actions .btn.ghost").click();
    await page.locator("#taskEditDialog").waitFor({ state: "hidden" });
    const beforeDisabledClick = api.createCalls;
    await page.evaluate(() => (document.querySelector("#btnCreateTask") as HTMLButtonElement | null)?.click());
    await page.waitForTimeout(100);
    expect(api.createCalls).toBe(beforeDisabledClick);
    await limitRow.locator('[data-task-action="delete"]').click();
    await page.locator("#confirmDialog[open]").waitFor();
    await page.locator("#btnAcceptConfirm").click();
    await page.waitForFunction(() => document.querySelectorAll("#taskGroups .task-row").length === 0);
    await page.locator("#tasksLimitNotice").waitFor({ state: "hidden" });
    expect(await page.locator("#btnCreateTask").isEnabled()).toBe(true);

    await page.locator("#tasksHeading").focus();
    await page.keyboard.press("Escape");
    await page.locator("#tasksDialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.id === "btnRoomOptions");

    // A participant who left after creating a task stays visible and checked.
    const departed = await page.evaluate(async ({ formPath, statePath }: { formPath: string; statePath: string }) => {
      const { fillPeople } = await import(formPath);
      const { app } = await import(statePath);
      const box = document.createElement("div");
      fillPeople(app, box, ["Departed participant"]);
      const input = box.querySelector<HTMLInputElement>('input[value="Departed participant"]');
      return { present: Boolean(input), checked: input?.checked === true };
    }, { formPath: "/assets/chat/task-form.js", statePath: "/assets/chat/state.js" });
    expect(departed).toEqual({ present: true, checked: true });

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

async function openTasks(page: any) {
  await page.locator("#btnRoomOptions").click();
  await page.locator("#btnTasks").click();
  await page.locator("#tasksDialog[open]").waitFor();
}

async function uploadMarkdown(origin: string, roomID: string, sessionID: string, name: string, content: string) {
  const response = await fetch(`${origin}/rooms/${encodeURIComponent(roomID)}/resources`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Session-ID": sessionID,
      "X-File-Name": encodeURIComponent(name),
      "Content-Type": "application/octet-stream",
    },
    body: content,
  });
  expect(response.status).toBe(201);
  return (await response.json()).resource as { id: string; name: string };
}

async function overflowMetrics(page: any) {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>("#tasksDialog")!;
    const scroll = dialog.querySelector<HTMLElement>(".tasks-scroll")!;
    const form = dialog.querySelector<HTMLElement>("#taskCreateForm")!;
    const box = dialog.getBoundingClientRect();
    return {
      pageOverflow: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
      dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
      scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
      formOverflow: form.scrollWidth - form.clientWidth,
      dialog: { left: box.left, right: box.right },
      rows: Array.from(dialog.querySelectorAll<HTMLElement>(".task-row")).map((row) => {
        const rect = row.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    };
  });
}

async function fieldGroupColors(page: any, participants: string, steps: string, input: string) {
  return page.evaluate((selectors: { participants: string; steps: string; input: string }) => {
    const style = (selector: string) => getComputedStyle(document.querySelector<HTMLElement>(selector)!);
    const inputStyle = style(selectors.input);
    const participantsStyle = style(selectors.participants);
    const stepsStyle = style(selectors.steps);
    return {
      inputBorder: inputStyle.borderTopColor, inputBackground: inputStyle.backgroundColor,
      participantsBorder: participantsStyle.borderTopColor, participantsBackground: participantsStyle.backgroundColor,
      stepsBorder: stepsStyle.borderTopColor, stepsBackground: stepsStyle.backgroundColor,
      participantsWidth: participantsStyle.borderTopWidth, stepsWidth: stepsStyle.borderTopWidth,
    };
  }, { participants, steps, input });
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