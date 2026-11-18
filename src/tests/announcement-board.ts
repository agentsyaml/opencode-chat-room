import { expect } from "bun:test";
import path from "node:path";

export async function announcementBoardWorks(page: any, artifacts: string) {
  const name = "__Test_AnnouncementBoard", content = "Plain text only: <img src=x onerror=alert(1)>";
  await page.locator("#btnAnnouncements").click();
  await page.locator("#announcementPanel").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "No announcements yet.");
  await openAnnouncement(page);
  // The editor is a writing surface, not a four-line dialog.
  const layout = await page.locator("#announcementDialog").evaluate((node: HTMLElement) => {
    const box = node.getBoundingClientRect(), area = document.querySelector<HTMLElement>("#announcementContent")!.getBoundingClientRect();
    return { width: box.width, left: box.left, right: box.right, areaHeight: area.height, viewport: innerWidth, scrollY: document.scrollingElement!.scrollTop };
  });
  expect(layout.width).toBeGreaterThan(700);
  expect(layout.areaHeight).toBeGreaterThan(240);
  expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.right).toBeLessThanOrEqual(layout.viewport);
  expect(layout.scrollY).toBe(0);
  await page.locator("#announcementName").fill(name);
  await page.locator("#announcementContent").fill(content);
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.", null, { timeout: 5000 }).catch(async () => {
    throw new Error(`Announcement save status: ${await page.locator("#announcementStatus").textContent()}`);
  });
  await openAnnouncement(page);
  await page.locator("#announcementName").fill(name);
  await page.locator("#announcementContent").fill("Should not overwrite");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementDialogStatus")?.textContent?.includes("already exists"));
  await closeAnnouncement(page);
  await openAnnouncement(page, name);
  if (!await page.locator("#announcementPanel").isVisible()) throw new Error(`Announcement panel closed: ${await page.locator("#announcementStatus").textContent()}`);
  expect(await page.locator("#announcementContent").inputValue()).toBe(content);
  await page.screenshot({ path: path.join(artifacts, "chat-announcement-dialog.png"), fullPage: true });
  await page.locator("#announcementContent").fill("Edited safely");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  await page.locator("#announcementDialog").waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(artifacts, "chat-announcement-board.png"), fullPage: true });
  await announcementRaces(page, name);
  await announcementRoomActivation(page);
  await closeAnnouncement(page);
  await page.locator("#btnAnnouncements").click();
}

async function openAnnouncement(page: any, name?: string) {
  if (name) await page.locator("#announcementList button").filter({ hasText: name }).click();
  else await page.locator("#btnNewAnnouncement").click();
  await page.locator("#announcementDialog[open]").waitFor();
}
async function closeAnnouncement(page: any) {
  await page.locator("#btnCloseAnnouncement").click();
  await page.locator("#announcementDialog").waitFor({ state: "hidden" });
}

async function announcementRaces(page: any, first: string) {
  const second = "__Test_AnnouncementOther", name = "#announcementName", content = "#announcementContent";
  const row = (value: string) => page.locator("#announcementList button").filter({ hasText: value });
  await openAnnouncement(page);
  await page.locator(name).fill(second); await page.locator(content).fill("Second announcement");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  await page.locator("#announcementDialog").waitFor({ state: "hidden" });
  page.on("dialog", (dialog: any) => dialog.accept());
  await openAnnouncement(page, first);
  const roomId = await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js");
  const update = async (value: string) => page.evaluate(async ({ url, id, name, content }: any) => {
    const { app } = await import(url);
    await app.api(`/rooms/${encodeURIComponent(id)}/announcements/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ sessionID: app.LS.sessionID, content }) });
  }, { url: "/assets/chat/state.js", id: roomId, name: first, content: value });
  await closeAnnouncement(page);
  await update("Updated by agent"); await page.locator("#btnRefreshAnnouncements").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "");
  await openAnnouncement(page, first);
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#announcementContent")?.value === "Updated by agent");
  await page.locator("#announcementContent").fill("Unsaved local edit");
  await closeAnnouncement(page);
  await update("Updated again externally"); await page.locator("#btnRefreshAnnouncements").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "");
  await openAnnouncement(page, first);
  expect(await page.locator("#announcementContent").inputValue()).toBe("Unsaved local edit");
  await page.locator(content).fill("Saved A snapshot");
  const put = await holdMutation(page, first, "PUT");
  await page.locator("#btnSaveAnnouncement").click(); await put.started;
  await closeAnnouncement(page);
  await openAnnouncement(page, second); await page.locator(content).fill("B remains selected");
  put.release(); await put.done;
  expect(await row(second).getAttribute("aria-current")).toBe("true");
  expect(await page.locator(content).inputValue()).toBe("B remains selected");
  expect(await page.locator(content).evaluate((node: HTMLElement) => document.activeElement === node)).toBe(true);
  await page.unroute(put.pattern);
  await page.locator(content).fill("B submitted snapshot");
  const putB = await holdMutation(page, second, "PUT");
  await page.locator("#btnSaveAnnouncement").click(); await putB.started;
  await page.locator(content).fill("Typed after save click");
  putB.release(); await putB.done;
  expect(await page.locator(content).inputValue()).toBe("Typed after save click");
  await page.unroute(putB.pattern);
  const del = await holdMutation(page, first, "DELETE");
  await closeAnnouncement(page);
  await openAnnouncement(page, first); await page.locator("#btnDeleteAnnouncement").click(); await del.started;
  await closeAnnouncement(page);
  await openAnnouncement(page, second); await page.locator(content).fill("B survives delete");
  del.release(); await del.done;
  expect(await row(second).getAttribute("aria-current")).toBe("true");
  expect(await page.locator(content).inputValue()).toBe("B survives delete");
  await page.unroute(del.pattern);
  await closeAnnouncement(page);
  await openAnnouncement(page);
  await page.locator(name).fill("__Test_FailedDraft"); await page.locator(content).fill("Keep failed draft");
  await page.route(`**/rooms/*/announcements/__Test_FailedDraft`, (route: any) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Mock save failure" }) }));
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementDialogStatus")?.textContent?.includes("Your draft is still here"));
  expect(await page.locator(name).inputValue()).toBe("__Test_FailedDraft");
  expect(await page.locator(content).inputValue()).toBe("Keep failed draft");
  await closeAnnouncement(page);
  await page.locator("#btnAnnouncements").click(); await page.locator("#btnAnnouncements").click();
  await page.waitForFunction(() => document.querySelectorAll("#announcementList button").length === 1);
  await openAnnouncement(page);
  expect(await page.locator(name).inputValue()).toBe("__Test_FailedDraft");
  expect(await page.locator(content).inputValue()).toBe("Keep failed draft");
  await page.unroute(`**/rooms/*/announcements/__Test_FailedDraft`);
  await closeAnnouncement(page);
  await openAnnouncement(page, second); await page.locator("#btnDeleteAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement deleted.");
  await page.locator("#announcementDialog").waitFor({ state: "hidden" });
  expect(await page.locator("#announcementList button").count()).toBe(0);
}

async function holdMutation(page: any, name: string, method: string) {
  const pattern = `**/rooms/*/announcements/${encodeURIComponent(name)}`;
  let release!: () => void, start!: () => void, finish!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { start = resolve; });
  const done = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(pattern, async (route: any) => {
    if (route.request().method() !== method) return route.continue();
    start(); await gate;
    const response = await route.fetch(); await route.fulfill({ response }); finish();
  });
  return { pattern, started, done, release };
}

async function announcementRoomActivation(page: any) {
  const sourceID = await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js");
  await openAnnouncement(page);
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  await page.locator("#announcementDialog").waitFor({ state: "hidden" });
  await page.locator("#btnAnnouncements").click();
  const targetName = "__Test_AnnouncementDelayed";
  await page.locator("#btnNewRoom").click(); await page.locator("#inRoomNameChat").fill(targetName);
  await page.locator("#btnCreateChatRoom").click();
  await page.waitForFunction((name: string) => document.querySelector("#roomName")?.textContent === name, targetName);
  const targetID = await page.evaluate((url: string) => import(url).then(({ app }) => app.state.room.id), "/assets/chat/state.js");
  await page.locator("#msgInput").fill("Announcement history anchor"); await page.locator("#btnSend").click();
  await page.locator("#msgList").getByText("Announcement history anchor").waitFor();
  await page.locator("#btnAnnouncements").click();
  await openAnnouncement(page);
  await page.locator("#announcementName").fill("__Test_TargetAnnouncement");
  await page.locator("#announcementContent").fill("Target room content");
  await page.locator("#btnSaveAnnouncement").click();
  await page.waitForFunction(() => document.querySelector("#announcementStatus")?.textContent === "Announcement saved.");
  await page.locator("#announcementDialog").waitFor({ state: "hidden" });
  await page.locator("#btnAnnouncements").click();
  await page.locator(`#roomListChat [data-room-id="${sourceID}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), sourceID);
  await page.locator("#btnAnnouncements").click();
  await openAnnouncement(page, "__Test_FailedDraft");
  expect(await page.locator("#announcementContent").inputValue()).toBe("Keep failed draft");
  await closeAnnouncement(page);
  await page.locator(`#roomListChat [data-room-id="${targetID}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), targetID);
  await page.waitForFunction(() => document.querySelector("#msgList")?.textContent?.includes("Announcement history anchor"));
  if (!await page.locator("#announcementPanel").isVisible()) await page.locator("#btnAnnouncements").click();
  await openAnnouncement(page, "__Test_TargetAnnouncement");
  expect(await page.locator("#announcementContent").inputValue()).toBe("Target room content");
  expect(await page.locator("#msgList").getByText("Announcement history anchor").count()).toBe(1);
  await closeAnnouncement(page);
  await page.locator(`#roomListChat [data-room-id="${sourceID}"]`).click();
  await page.waitForFunction((id: string) => document.querySelector("#btnCopyId")?.getAttribute("title")?.endsWith(id), sourceID);
  if (!await page.locator("#announcementPanel").isVisible()) await page.locator("#btnAnnouncements").click();
  await openAnnouncement(page, "__Test_FailedDraft");
  expect(await page.locator("#announcementContent").inputValue()).toBe("Keep failed draft");
}
