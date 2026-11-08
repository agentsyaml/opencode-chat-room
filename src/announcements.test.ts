import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const directory = mkdtempSync(path.join(tmpdir(), "chat-room-announcements-"));
const previousDirectory = process.env.CHAT_ROOM_STATE_DIR;
process.env.CHAT_ROOM_STATE_DIR = directory;
const store = await import("./store");
const board = await import("./announcements");
const roomID = await store.writeState((service) => service.createRoom("__Test_board", "owner").id);
const otherRoom = await store.writeState((service) => service.createRoom("__Test_board_other", "owner").id);

afterAll(() => {
  if (previousDirectory === undefined) delete process.env.CHAT_ROOM_STATE_DIR;
  else process.env.CHAT_ROOM_STATE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

test("announcement persistence, upsert, Unicode limits, and room cascade", async () => {
  expect(board.validateAnnouncement("  ", "ok")).toBeTruthy();
  expect(board.validateAnnouncement("title", 4)).toBeTruthy();
  expect(board.validateAnnouncement("title", undefined, true)).toBeTruthy();
  expect(board.validateAnnouncement("title", null, true)).toBeTruthy();
  expect(board.validateAnnouncement("title", "😀".repeat(5000))).toBeUndefined();
  expect(board.validateAnnouncement("title", "😀".repeat(5001))).toBeTruthy();
  expect(board.validateAnnouncement("x".repeat(64), "")).toBeUndefined();
  expect(board.validateAnnouncement("x".repeat(65), "")).toBeTruthy();
  await board.putAnnouncement(roomID, "  roadmap ", "first");
  await board.putAnnouncement(roomID, "roadmap", "updated");
  await board.putAnnouncement(roomID, "Roadmap", "case-sensitive");
  await board.putAnnouncement(roomID, "empty", "");
  await board.putAnnouncement(otherRoom, "roadmap", "other room");
  expect(await board.listAnnouncements(roomID)).toHaveLength(3);
  expect(await board.getAnnouncement(roomID, "roadmap")).toMatchObject({ name: "roadmap", content: "updated", roomID });
  expect(await board.getAnnouncement(roomID, "Roadmap")).toMatchObject({ content: "case-sensitive" });
  expect(await board.getAnnouncement(roomID, "empty")).toMatchObject({ content: "" });
  await store.writeState((service) => service.sendMessage(roomID, "owner", "ordinary write", "owner"));
  expect(await board.getAnnouncement(roomID, "roadmap")).toMatchObject({ content: "updated" });
  const reopened = new Database(store.databasePath());
  expect(reopened.query("SELECT content FROM announcements WHERE room_id=? AND name='roadmap'").get(roomID)).toEqual({ content: "updated" });
  reopened.close();
  await store.writeState((service) => service.deleteRoom(roomID));
  expect(await board.listAnnouncements(roomID)).toEqual([]);
  expect(await board.getAnnouncement(otherRoom, "roadmap")).toMatchObject({ content: "other room" });
});
