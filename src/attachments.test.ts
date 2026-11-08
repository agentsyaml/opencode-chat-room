// Image attachments: bytes are validated, stored per room, and survive the
// SQLite round trip as ids only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stateDir = mkdtempSync(path.join(tmpdir(), "chat-room-images-"));
process.env.CHAT_ROOM_STATE_DIR = stateDir;
process.env.XDG_CONFIG_HOME = path.join(stateDir, "config");

const {
  MAX_IMAGE_BYTES,
  attachmentRoot,
  deleteRoomAttachments,
  extensionFor,
  readAttachment,
  sniffImage,
  storeAttachment,
} = await import("./attachments");
const { writeState, readHistory, databasePath } = await import("./store");
const { readAttachment: readAttachmentRoute, deleteRoomAttachments: deleteRoute } = await import("../server/attachment-routes");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

afterAll(() => {
  delete process.env.CHAT_ROOM_STATE_DIR;
});

describe("image bytes", () => {
  test("the declared type has to match the magic bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg/>"))).toBeNull();
  });

  test("extensions follow the type", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/webp")).toBe("webp");
  });

  test("a mismatched or oversized upload is refused", async () => {
    await expect(storeAttachment("room-a", "image/png", JPEG)).rejects.toThrow();
    await expect(storeAttachment("room-a", "image/gif", PNG)).rejects.toThrow();
    await expect(storeAttachment("room-a", "image/png", new Uint8Array(0))).rejects.toThrow();
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    await expect(storeAttachment("room-a", "image/png", big)).rejects.toThrow();
  });
});

describe("image store", () => {
  test("stored bytes come back unchanged, and only for their room", async () => {
    const ref = await storeAttachment("room-b", "image/png", PNG, "shot.png");
    expect(ref).toMatchObject({ mime: "image/png", bytes: PNG.byteLength, name: "shot.png" });
    const found = await readAttachment("room-b", ref.id);
    expect(found?.mime).toBe("image/png");
    expect([...(found?.data ?? [])]).toEqual([...PNG]);
    expect(await readAttachment("room-c", ref.id)).toBeNull();
    expect(await readAttachment("room-b", "../escape")).toBeNull();
  });

  test("a message keeps its image ids through SQLite", async () => {
    const ref = await storeAttachment("room-d", "image/webp", WEBP);
    const roomID = await writeState((service) => {
      const room = service.createRoom("images", "alice");
      service.joinRoom(room.id, { id: "alice", name: "alice" });
      service.sendMessage(room.id, "alice", "", undefined, false,
        [{ id: ref.id, mime: ref.mime, bytes: ref.bytes }]);
      return room.id;
    });
    const page = await readHistory(roomID);
    expect(page.messages.at(-1)?.attachments).toEqual([
      { id: ref.id, mime: "image/webp", bytes: ref.bytes },
    ]);
  });

  test("deleting a room's images leaves no file behind", async () => {
    const ref = await storeAttachment("room-e", "image/png", PNG);
    const before = readdirSync(path.join(attachmentRoot(), "room-e"));
    expect(before.length).toBe(1);
    await deleteRoomAttachments("room-e", [ref.id]);
    expect(readdirSync(path.join(attachmentRoot(), "room-e"))).toEqual([]);
  });

  test("the route module exposes the same store", async () => {
    const ref = await storeAttachment("room-f", "image/png", PNG);
    expect((await readAttachmentRoute("room-f", ref.id))?.mime).toBe("image/png");
    await deleteRoute("room-f", [ref.id]);
    expect(await readAttachmentRoute("room-f", ref.id)).toBeNull();
  });
});

describe("delivery to a host", () => {
  test("the bytes are written to a temp file and named in the notification", async () => {
    const { materializeMessage, imageNote } = await import("./attachments");
    const realFetch = globalThis.fetch;
    // The HTTP contract is covered in attachment-http.test.ts; here the point is
    // what the plugin does with the response.
    globalThis.fetch = (async () => new Response(PNG, { headers: { "Content-Type": "image/png" } })) as unknown as typeof fetch;
    try {
      const paths = await materializeMessage(
        { id: "message-1", roomId: "room-delivery", attachments: [{ id: "img-1", mime: "image/png", bytes: PNG.byteLength }] },
        { base: "http://x", token: "", roomID: "room-delivery" });
      expect(paths.length).toBe(1);
      expect([...new Uint8Array(readFileSync(paths[0]!))]).toEqual([...PNG]);
      expect(imageNote("message-1")).toContain(paths[0]!);
      expect(imageNote("message-1")).toContain("read this file yourself");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
