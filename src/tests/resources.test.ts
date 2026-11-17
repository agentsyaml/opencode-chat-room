import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSqliteState } from "../state/sqlite-state.ts";

test("concurrent uploads with one client ID commit once and never overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "__Test_rooms-resources-race-"));
  const oldDir = process.env.CHAT_ROOM_STATE_DIR;
  process.env.CHAT_ROOM_STATE_DIR = root;
  try {
    const { uploadResource, findResource, resourcePath } = await import("../rooms/resources.ts");
    const { databasePath } = await import("../state/store.ts");
    const roomID = await writeSqliteState(databasePath(), (service) => service.createRoom("__Test_race", "test").id);
    const id = crypto.randomUUID(), owner = { sessionID: "owner", name: "Owner" }, other = { sessionID: "other", name: "Other" };
    const body = (name: string) => new Blob([name === "owner.bin" ? "OWNER" : "OTHER"]).stream();
    const settled = await Promise.allSettled([
      uploadResource(roomID, "owner.bin", body("owner.bin"), 20, owner, id),
      uploadResource(roomID, "other.bin", body("other.bin"), 20, other, id),
    ]);
    const fulfilled = settled.find((item) => item.status === "fulfilled"), rejected = settled.find((item) => item.status === "rejected");
    expect(fulfilled?.status).toBe("fulfilled"); expect(rejected?.status).toBe("rejected");
    if (fulfilled?.status !== "fulfilled" || rejected?.status !== "rejected") throw new Error("unreachable");
    expect(rejected.reason).toMatchObject({ status: 409 });
    const winner = fulfilled.value;
    expect(await readdir(path.join(root, "resources", roomID))).toEqual([id]);
    expect(await readFile(resourcePath(winner))).toEqual(Buffer.from(winner.name === "owner.bin" ? "OWNER" : "OTHER"));
    expect(await findResource(roomID, id)).toEqual(winner);
    const replay = await uploadResource(roomID, winner.name, body(winner.name), 20, winner.name === "owner.bin" ? owner : other, id);
    expect(replay.id).toBe(id);
    const sharedID = crypto.randomUUID();
    const shared = await Promise.all([
      uploadResource(roomID, "same.bin", body("same.bin"), 20, owner, sharedID),
      uploadResource(roomID, "same.bin", body("same.bin"), 20, owner, sharedID),
    ]);
    expect(shared.map((entry) => entry.id)).toEqual([sharedID, sharedID]);
    const orphanID = crypto.randomUUID();
    await writeFile(resourcePath({ roomID, id: orphanID }), "ORPHAN");
    await expect(uploadResource(roomID, "new.bin", body("new.bin"), 20, owner, orphanID)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(resourcePath({ roomID, id: orphanID }), "utf8")).toBe("ORPHAN");
    const lateID = crypto.randomUUID();
    const lateRoom = await writeSqliteState(databasePath(), (service) => service.createRoom("__Test_late", "test").id);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lateBody = new ReadableStream<Uint8Array>({
      async pull(controller) { await gate; controller.enqueue(new TextEncoder().encode("LATE")); controller.close(); },
    });
    const pending = uploadResource(lateRoom, "late.bin", lateBody, 20, owner, lateID).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const db = new Database(databasePath()); db.exec("PRAGMA foreign_keys=ON"); db.query("DELETE FROM rooms WHERE id=?").run(lateRoom); db.close();
    release();
    expect(await pending).toMatchObject({ status: 404 });
    expect(await readdir(path.join(root, "resources", lateRoom))).toEqual([]);
  } finally {
    if (oldDir === undefined) delete process.env.CHAT_ROOM_STATE_DIR; else process.env.CHAT_ROOM_STATE_DIR = oldDir;
    await rm(root, { recursive: true, force: true });
  }
});
  test("resources stream within limits, sniff safe media, persist, and clean up", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "__Test_rooms-resources-"));
  const oldDir = process.env.CHAT_ROOM_STATE_DIR;
  const oldLimit = process.env.CHAT_ROOM_MAX_FILE_SIZE_MB;
  process.env.CHAT_ROOM_STATE_DIR = root;
  try {
    const { uploadResource, findResource, resourcePath, removeRoomResources, ResourceError, maxResourceBytes } = await import("../rooms/resources.ts");
    const { databasePath } = await import("../state/store.ts");
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
