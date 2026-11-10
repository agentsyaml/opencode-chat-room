import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSqliteState } from "./sqlite-state";

test("resources stream within limits, sniff safe media, persist, and clean up", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "__Test_rooms-resources-"));
  const oldDir = process.env.CHAT_ROOM_STATE_DIR;
  const oldLimit = process.env.CHAT_ROOM_MAX_FILE_SIZE_MB;
  process.env.CHAT_ROOM_STATE_DIR = root;
  try {
    const { uploadResource, findResource, resourcePath, removeRoomResources, ResourceError, maxResourceBytes } = await import("./resources");
    const { databasePath } = await import("./store");
    delete process.env.CHAT_ROOM_MAX_FILE_SIZE_MB;
    expect(maxResourceBytes()).toBe(500 * 1024 * 1024);
    const roomID = await writeSqliteState(databasePath(), (service) => service.createRoom("__Test_resources", "test").id);
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, 4)); controller.enqueue(bytes.slice(4)); controller.close(); },
    });
    const saved = await uploadResource(roomID, "image.png", body, 20);
    expect(saved).toMatchObject({ roomID, name: "image.png", mimeType: "image/png", size: 9 });
    expect(await readFile(resourcePath(saved))).toEqual(Buffer.from(bytes));
    expect(await findResource(roomID, saved.id)).toEqual(saved);
    expect(await findResource(roomID, "../../secret")).toBeUndefined();
    expect(() => resourcePath({ roomID, id: "../../secret" })).toThrow(ResourceError);
    expect(() => resourcePath({ roomID: "../outside", id: saved.id })).toThrow(ResourceError);

    const unsafe = await uploadResource(roomID, "page.svg", new Blob(["<svg>"]).stream(), 20);
    expect(unsafe.mimeType).toBe("application/octet-stream");
    const empty = await uploadResource(roomID, "empty.dat", new Blob([]).stream(), 20);
    expect(empty).toMatchObject({ size: 0, mimeType: "application/octet-stream" });
    await expect(uploadResource(roomID, "large.bin", new Blob([new Uint8Array(4)]).stream(), 3))
      .rejects.toBeInstanceOf(ResourceError);
    await expect(uploadResource(roomID, "../bad", new Blob(["x"]).stream(), 3)).rejects.toBeInstanceOf(ResourceError);
    await expect(uploadResource(roomID, "bad\u0000name", new Blob(["x"]).stream(), 3)).rejects.toBeInstanceOf(ResourceError);
    await expect(uploadResource("missing-room", "x", new Blob(["x"]).stream(), 3)).rejects.toMatchObject({ status: 404 });
    expect((await readdir(path.join(root, "resources", roomID))).sort()).toEqual([saved.id, unsafe.id, empty.id].sort());

    process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = "2.5";
    expect(maxResourceBytes()).toBe(2.5 * 1024 * 1024);
    process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = "Infinity";
    expect(() => maxResourceBytes()).toThrow();
    await expect(removeRoomResources(roomID)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(resourcePath(saved))).toEqual(Buffer.from(bytes));
    const db = new Database(databasePath());
    try { db.exec("PRAGMA foreign_keys=ON"); db.query("DELETE FROM rooms WHERE id=?").run(roomID); }
    finally { db.close(); }
    await removeRoomResources(roomID);
    expect(await findResource(roomID, saved.id)).toBeUndefined();
    await expect(readFile(resourcePath(saved))).rejects.toThrow();
  } finally {
    if (oldDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR; else process.env.CHAT_ROOM_STATE_DIR = oldDir;
    if (oldLimit === undefined) delete process.env.CHAT_ROOM_MAX_FILE_SIZE_MB; else process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = oldLimit;
    await rm(root, { recursive: true, force: true });
  }
});
