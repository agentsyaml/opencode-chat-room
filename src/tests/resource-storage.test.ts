import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { createStorage, storageConfig, type S3StorageConfig } from "../rooms/storage.ts";
import { uploadResource } from "../rooms/resources.ts";

class FakeS3 {
  objects = new Map<string, { body: Buffer; contentType?: string }>();
  failPut: unknown;
  failHead: unknown;
  rejectConditional = false;
  omitContentRange = false;
  async send(command: { constructor: { name: string }; input: any }): Promise<any> {
    const name = command.constructor.name;
    const input = command.input ?? {};
    switch (name) {
      case "HeadBucketCommand": if (this.failHead) throw this.failHead; return {};
      case "PutObjectCommand": {
        if (this.failPut) throw this.failPut;
        if (this.rejectConditional && input.IfNoneMatch) throw s3Error(501, "NotImplemented");
        if (input.IfNoneMatch === "*" && this.objects.has(input.Key)) throw s3Error(412, "PreconditionFailed");
        this.objects.set(input.Key, { body: await drain(input.Body), contentType: input.ContentType });
        return {};
      }
      case "GetObjectCommand": {
        const object = this.objects.get(input.Key);
        if (!object) throw s3Error(404, "NoSuchKey");
        const match = /^bytes=(\d+)-(\d+)$/.exec(String(input.Range ?? ""));
        if (!match) return { Body: Readable.from([object.body]), ContentLength: object.body.length };
        const start = Number(match[1]), end = Number(match[2]), body = object.body.subarray(start, end + 1);
        return { Body: Readable.from([body]), ContentLength: body.length, ...(this.omitContentRange ? {} : { ContentRange: `bytes ${start}-${end}/${object.body.length}` }) };
      }
      case "HeadObjectCommand": {
        const object = this.objects.get(input.Key);
        if (!object) throw s3Error(404, "NotFound");
        return { ContentLength: object.body.length };
      }
      case "DeleteObjectCommand": this.objects.delete(input.Key); return {};
      case "ListObjectsV2Command": {
        const keys = [...this.objects.keys()].filter((key) => key.startsWith(String(input.Prefix ?? ""))).sort();
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      case "DeleteObjectsCommand": {
        for (const entry of input.Delete?.Objects ?? []) this.objects.delete(entry.Key);
        return {};
      }
      default: throw new Error(`unexpected S3 command ${name}`);
    }
  }
}

async function drain(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function s3Error(status: number, name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function s3Config(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
  return {
    kind: "s3", bucket: "test-bucket", accessKeyId: "test-access", secretAccessKey: "test-secret",
    region: "us-east-1", forcePathStyle: true, prefix: "chat-room", localCache: true, ...overrides,
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function tempRoot(label: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), `__Test_resource-storage-${label}-`));
}

test("local storage keeps the existing path, ranges, and prefix cleanup", async () => {
  const root = await tempRoot("local");
  try {
    const storage = createStorage({ kind: "local" }, { localRoot: () => root });
    await storage.ready();
    const roomID = crypto.randomUUID(), id = crypto.randomUUID(), key = `${roomID}/${id}`;
    const upload = path.join(root, "upload.bin");
    await writeFile(upload, "0123456789");
    await storage.put(key, upload, "text/plain");
    expect(await readFile(path.join(root, roomID, id), "utf8")).toBe("0123456789");
    const full = await storage.open(key);
    expect(full?.size).toBe(10);
    expect(await collect(full!.stream)).toBe("0123456789");
    const ranged = await storage.open(key, 2, 4);
    expect(ranged?.size).toBe(10);
    expect(await collect(ranged!.stream)).toBe("234");
    expect(await storage.exists(key)).toBe(true);
    await expect(storage.put(key, upload, "text/plain")).rejects.toMatchObject({ name: "StorageConflictError" });
    await storage.deletePrefix(roomID);
    expect(await storage.exists(key)).toBe(false);
    await expect(readFile(path.join(root, roomID, id))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("S3 storage uploads, streams byte ranges, lists, and deletes", async () => {
  const root = await tempRoot("s3");
  const fake = new FakeS3();
  try {
    const storage = createStorage(s3Config(), { client: fake, localRoot: () => root });
    await storage.ready();
    const roomID = crypto.randomUUID(), id = crypto.randomUUID(), key = `${roomID}/${id}`;
    const upload = path.join(root, "upload.bin");
    await writeFile(upload, "0123456789");
    await storage.put(key, upload, "text/plain");
    expect(fake.objects.get(`chat-room/${roomID}/${id}`)).toMatchObject({ contentType: "text/plain" });
    expect(await collect((await storage.open(key))!.stream)).toBe("0123456789");
    const ranged = await storage.open(key, 3, 6);
    expect(ranged?.size).toBe(10);
    expect(await collect(ranged!.stream)).toBe("3456");
    expect(await storage.exists(key)).toBe(true);
    await storage.delete(key);
    expect(fake.objects.has(`chat-room/${roomID}/${id}`)).toBe(false);
    await expect(readFile(path.join(root, roomID, id))).rejects.toThrow();
    expect(await storage.open(key)).toBeUndefined();
    await storage.put(key, upload, "text/plain");
    const second = `${roomID}/${crypto.randomUUID()}`;
    await storage.put(second, upload, "application/octet-stream");
    await storage.deletePrefix(roomID);
    expect([...fake.objects.keys()]).toEqual([]);
    expect(await storage.exists(key)).toBe(false);
    await expect(readdir(path.join(root, roomID))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("S3 local cache serves reads when the object is gone, and cache off leaves no copy", async () => {
  const root = await tempRoot("cache");
  const fake = new FakeS3();
  try {
    const cached = createStorage(s3Config(), { client: fake, localRoot: () => root });
    const roomID = crypto.randomUUID(), id = crypto.randomUUID(), key = `${roomID}/${id}`;
    const upload = path.join(root, "upload.bin");
    await writeFile(upload, "cached-bytes");
    await cached.put(key, upload, "text/plain");
    expect(await readFile(path.join(root, roomID, id), "utf8")).toBe("cached-bytes");
    fake.objects.clear();
    expect(await collect((await cached.open(key))!.stream)).toBe("cached-bytes");

    const uncached = createStorage(s3Config({ localCache: false }), { client: fake, localRoot: () => root });
    const otherRoom = crypto.randomUUID(), otherID = crypto.randomUUID(), otherKey = `${otherRoom}/${otherID}`;
    await mkdir(path.join(root, otherRoom), { recursive: true });
    await writeFile(path.join(root, otherRoom, otherID), "stale");
    await uncached.put(otherKey, upload, "text/plain");
    await expect(readFile(path.join(root, otherRoom, otherID))).rejects.toThrow();
    const openEnded = await uncached.open(otherKey, 3);
    expect(openEnded?.size).toBe(12);
    expect(await collect(openEnded!.stream)).toBe("hed-bytes");
    fake.objects.clear();
    expect(await uncached.open(otherKey)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stores without conditional PUT fall back to a precheck without overwriting", async () => {
  const root = await tempRoot("conditional");
  const fake = new FakeS3();
  fake.rejectConditional = true;
  try {
    const storage = createStorage(s3Config({ localCache: false }), { client: fake, localRoot: () => root });
    const key = `${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const first = path.join(root, "first.bin"), second = path.join(root, "second.bin");
    await writeFile(first, "first");
    await writeFile(second, "second");
    await storage.put(key, first, "text/plain");
    expect(fake.objects.get(`chat-room/${key}`)?.body.toString()).toBe("first");
    await expect(storage.put(key, second, "text/plain")).rejects.toMatchObject({ name: "StorageConflictError" });
    expect(fake.objects.get(`chat-room/${key}`)?.body.toString()).toBe("first");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a range response without ContentRange asks HeadObject for the total", async () => {
  const root = await tempRoot("no-content-range");
  const fake = new FakeS3();
  fake.omitContentRange = true;
  try {
    const storage = createStorage(s3Config({ localCache: false }), { client: fake, localRoot: () => root });
    const key = `${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const upload = path.join(root, "upload.bin");
    await writeFile(upload, "0123456789");
    await storage.put(key, upload, "text/plain");
    const ranged = await storage.open(key, 1, 3);
    expect(ranged?.size).toBe(10);
    expect(await collect(ranged!.stream)).toBe("123");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing stored object answers 404 without touching the database", async () => {
  const root = await tempRoot("missing");
  const previous = process.env.CHAT_ROOM_STATE_DIR;
  process.env.CHAT_ROOM_STATE_DIR = root;
  try {
    const { databasePath } = await import("../state/store.ts");
    const { putResource, writeSqliteState } = await import("../state/sqlite-state.ts");
    const { resourceRoutes } = await import("../../server/resource-routes.ts");
    const roomID = await writeSqliteState(databasePath(), (service) => service.createRoom("__Test_missing", "test").id);
    const resource = { id: crypto.randomUUID(), roomID, name: "gone.txt", mimeType: "text/plain", size: 5, createdAt: Date.now() };
    await putResource(databasePath(), resource);
    const url = `http://localhost/rooms/${roomID}/resources/${resource.id}/content`;
    const response = await resourceRoutes(new Request(url), new URL(url));
    expect(response?.status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.CHAT_ROOM_STATE_DIR; else process.env.CHAT_ROOM_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("an S3 upload failure leaves no DB row, cache file, or local fallback", async () => {
  const root = await tempRoot("failure");
  const previous = process.env.CHAT_ROOM_STATE_DIR;
  process.env.CHAT_ROOM_STATE_DIR = root;
  const fake = new FakeS3();
  fake.failPut = s3Error(500, "InternalError");
  try {
    const { databasePath } = await import("../state/store.ts");
    const { writeSqliteState } = await import("../state/sqlite-state.ts");
    const { listRoomResources } = await import("../rooms/resources.ts");
    const storage = createStorage(s3Config(), { client: fake, localRoot: () => path.join(root, "resources") });
    const roomID = await writeSqliteState(databasePath(), (service) => service.createRoom("__Test_s3_failure", "test").id);
    await expect(uploadResource(roomID, "file.txt", new Blob(["payload"]).stream(), 100, undefined, undefined, storage)).rejects.toThrow();
    expect((await listRoomResources(roomID)).total).toBe(0);
    expect(await readdir(path.join(root, "resources", roomID))).toEqual([]);
    expect(fake.objects.size).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.CHAT_ROOM_STATE_DIR; else process.env.CHAT_ROOM_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("partial S3 configuration fails startup with the missing variable named", () => {
  expect(() => storageConfig({ CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_BUCKET: "bucket" })).toThrow(/CHAT_ROOM_S3_ACCESS_KEY_ID/);
  expect(() => storageConfig({ CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_ACCESS_KEY_ID: "access" })).toThrow(/CHAT_ROOM_S3_BUCKET/);
  expect(() => storageConfig({ CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_BUCKET: "b", CHAT_ROOM_S3_ACCESS_KEY_ID: "a" })).toThrow(/CHAT_ROOM_S3_SECRET_ACCESS_KEY/);
  expect(() => storageConfig({ CHAT_ROOM_STORAGE: "gcs" })).toThrow(/CHAT_ROOM_STORAGE/);
  expect(storageConfig({ CHAT_ROOM_STORAGE: "local", CHAT_ROOM_S3_BUCKET: "ignored" })).toEqual({ kind: "local" });
  expect(storageConfig({
    CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_BUCKET: "b", CHAT_ROOM_S3_ACCESS_KEY_ID: "a",
    CHAT_ROOM_S3_SECRET_ACCESS_KEY: "s", CHAT_ROOM_S3_ENDPOINT: "http://127.0.0.1:9000",
  })).toMatchObject({ kind: "s3", forcePathStyle: true, region: "us-east-1", prefix: "chat-room", localCache: true });
  for (const value of ["0", "false", "off", "FALSE"]) {
    expect(storageConfig({
      CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_BUCKET: "b", CHAT_ROOM_S3_ACCESS_KEY_ID: "a",
      CHAT_ROOM_S3_SECRET_ACCESS_KEY: "s", CHAT_ROOM_S3_LOCAL_CACHE: value,
    })).toMatchObject({ kind: "s3", localCache: false });
  }
});

test("S3 readiness fails clearly when HeadBucket is denied", async () => {
  const fake = new FakeS3();
  fake.failHead = s3Error(403, "Forbidden");
  const storage = createStorage(s3Config(), { client: fake });
  await expect(storage.ready()).rejects.toThrow(/S3 storage is not ready: HeadBucket failed for bucket "test-bucket"/);
});

test("configuration errors never echo credential values", () => {
  const access = "AKIA-VISIBLE-ACCESS", secret = "super-secret-value";
  let message = "";
  try {
    storageConfig({ CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_BUCKET: "bucket", CHAT_ROOM_S3_ACCESS_KEY_ID: access, CHAT_ROOM_S3_SECRET_ACCESS_KEY: secret, CHAT_ROOM_S3_FORCE_PATH_STYLE: "maybe" });
  } catch (error) { message = (error as Error).message; }
  expect(message).toContain("CHAT_ROOM_S3_FORCE_PATH_STYLE");
  expect(message).not.toContain(access);
  expect(message).not.toContain(secret);
  let missing = "";
  try {
    storageConfig({ CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_BUCKET: "bucket", CHAT_ROOM_S3_ACCESS_KEY_ID: access });
  } catch (error) { missing = (error as Error).message; }
  expect(missing).toContain("CHAT_ROOM_S3_SECRET_ACCESS_KEY");
  expect(missing).not.toContain(access);
});