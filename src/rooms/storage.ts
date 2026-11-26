// Resource object storage. Local disk is the default; S3 is opt-in and never
// falls back silently to local files after a failed S3 operation.
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { databasePath } from "../state/store.ts";

export type ResourceStorage = {
  ready(): Promise<void>;
  put(key: string, filePath: string, contentType: string): Promise<void>;
  open(key: string, start?: number, end?: number): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | undefined>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
};

export type S3StorageConfig = {
  kind: "s3";
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
  prefix: string;
  localCache: boolean;
};

export type StorageConfig = { kind: "local" } | S3StorageConfig;

export class StorageConflictError extends Error {
  constructor(message = "storage key already exists") { super(message); this.name = "StorageConflictError"; }
}

type S3ClientLike = { send(command: any): Promise<any> };
type StorageDependencies = { client?: S3ClientLike; localRoot?: () => string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function defaultLocalRoot(): string {
  return path.join(path.dirname(databasePath()), "resources");
}

export function resourceStorageKey(roomID: string, id: string): string {
  if (!uuid.test(roomID) || !uuid.test(id)) throw new Error("invalid resource storage key");
  return `${roomID}/${id}`;
}

function assertKeySegments(key: string): string[] {
  const segments = key.split("/");
  if (!segments.length || segments.some((segment) => !uuid.test(segment))) throw new Error("invalid resource storage key");
  return segments;
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const kind = (env.CHAT_ROOM_STORAGE ?? "local").trim().toLowerCase();
  if (kind === "local") return { kind: "local" };
  if (kind !== "s3") throw new Error('CHAT_ROOM_STORAGE must be "local" or "s3"');
  const required = ["CHAT_ROOM_S3_BUCKET", "CHAT_ROOM_S3_ACCESS_KEY_ID", "CHAT_ROOM_S3_SECRET_ACCESS_KEY"] as const;
  for (const name of required) {
    if (!env[name]?.trim()) throw new Error(`${name} is required when CHAT_ROOM_STORAGE=s3`);
  }
  const endpoint = env.CHAT_ROOM_S3_ENDPOINT?.trim() || undefined;
  const prefix = (env.CHAT_ROOM_S3_PREFIX?.trim() || "chat-room").replace(/^\/+|\/+$/g, "") || "chat-room";
  const cacheFlag = (env.CHAT_ROOM_S3_LOCAL_CACHE ?? "").trim().toLowerCase();
  return {
    kind: "s3",
    bucket: env.CHAT_ROOM_S3_BUCKET!.trim(),
    accessKeyId: env.CHAT_ROOM_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.CHAT_ROOM_S3_SECRET_ACCESS_KEY!,
    endpoint,
    region: env.CHAT_ROOM_S3_REGION?.trim() || "us-east-1",
    forcePathStyle: parseBoolean(env.CHAT_ROOM_S3_FORCE_PATH_STYLE, "CHAT_ROOM_S3_FORCE_PATH_STYLE") ?? Boolean(endpoint),
    prefix,
    localCache: !["0", "false", "off"].includes(cacheFlag),
  };
}

function asWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function errorCode(error: unknown): string {
  const value = error as { name?: unknown; Code?: unknown };
  return typeof value?.Code === "string" ? value.Code : typeof value?.name === "string" ? value.name : "";
}

function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404 || errorCode(error) === "NoSuchKey" || errorCode(error) === "NotFound";
}

function isPreconditionFailed(error: unknown): boolean {
  return statusOf(error) === 412 || errorCode(error) === "PreconditionFailed" ||
    (statusOf(error) === 409 && errorCode(error) === "ConditionalRequestConflict");
}

// Some S3-compatible stores reject conditional PutObject. Only these errors
// retry without If-None-Match after a HeadObject precheck.
function isConditionalUnsupported(error: unknown): boolean {
  return statusOf(error) === 501 || errorCode(error) === "NotImplemented" ||
    (statusOf(error) === 400 && /if-none-match/i.test(String((error as Error)?.message ?? "")));
}

function createLocalStorage(localRoot: () => string): ResourceStorage {
  const target = (key: string) => path.join(localRoot(), ...assertKeySegments(key));
  return {
    async ready() { await fs.mkdir(localRoot(), { recursive: true, mode: 0o700 }); },
    async put(key, filePath) {
      const destination = target(key);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      try { await fs.link(filePath, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StorageConflictError();
        throw error;
      }
    },
    async open(key, start, end) {
      const file = target(key);
      let info;
      try { info = await fs.stat(file); }
      catch (error) { if (isMissingFile(error)) return undefined; throw error; }
      const stream = start === undefined ? createReadStream(file) : createReadStream(file, { start, end });
      return { stream: asWebStream(stream), size: info.size };
    },
    async delete(key) { await fs.rm(target(key), { force: true }); },
    async deletePrefix(prefix) { await fs.rm(target(prefix), { recursive: true, force: true }); },
    async exists(key) {
      try { await fs.stat(target(key)); return true; }
      catch (error) { if (isMissingFile(error)) return false; throw error; }
    },
  };
}

let sdkModule: Promise<typeof import("@aws-sdk/client-s3")> | undefined;
const s3Sdk = () => (sdkModule ??= import("@aws-sdk/client-s3"));

function createS3Storage(config: S3StorageConfig, deps: StorageDependencies): ResourceStorage {
  const cacheRoot = deps.localRoot ?? defaultLocalRoot;
  const cachePath = (key: string) => path.join(cacheRoot(), ...assertKeySegments(key));
  const objectKey = (key: string) => `${config.prefix}/${key}`;
  let clientPromise: Promise<S3ClientLike> | undefined;
  const client = () => (clientPromise ??= (async () => {
    if (deps.client) return deps.client;
    const { S3Client: Client } = await s3Sdk();
    return new Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }) as unknown as S3Client;
  })());

  async function removeObject(key: string): Promise<void> {
    const { DeleteObjectCommand } = await s3Sdk();
    await (await client()).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey(key) }));
    await fs.rm(cachePath(key), { force: true });
  }

  async function headSize(key: string): Promise<number | undefined> {
    try {
      const { HeadObjectCommand } = await s3Sdk();
      const output = await (await client()).send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey(key) }));
      return typeof output?.ContentLength === "number" ? output.ContentLength : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async function objectExists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await s3Sdk();
    try {
      await (await client()).send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey(key) }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async function putObject(key: string, filePath: string, contentType: string, conditional: boolean): Promise<void> {
    const { PutObjectCommand } = await s3Sdk();
    const info = await fs.stat(filePath);
    await (await client()).send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey(key),
      Body: createReadStream(filePath),
      ContentLength: info.size,
      ContentType: contentType,
      ...(conditional ? { IfNoneMatch: "*" } : {}),
    }));
  }

  return {
    async ready() {
      try {
        const { HeadBucketCommand } = await s3Sdk();
        await (await client()).send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new Error(`S3 storage is not ready: HeadBucket failed for bucket "${config.bucket}": ${detail}`);
      }
    },
    async put(key, filePath, contentType) {
      try {
        await putObject(key, filePath, contentType, true);
      } catch (error) {
        if (isPreconditionFailed(error)) throw new StorageConflictError();
        if (!isConditionalUnsupported(error)) throw error;
        // shortcut: stores without conditional PUT leave a small precheck/write race.
        if (await objectExists(key)) throw new StorageConflictError();
        await putObject(key, filePath, contentType, false);
      }
      if (!config.localCache) {
        await fs.rm(cachePath(key), { force: true });
        return;
      }
      const cache = cachePath(key);
      try {
        await fs.mkdir(path.dirname(cache), { recursive: true, mode: 0o700 });
        await fs.link(filePath, cache);
      } catch (error) {
        // Keep any pre-existing cache file that won the race; only remove the
        // S3 object this attempt just wrote.
        const { DeleteObjectCommand } = await s3Sdk();
        await (await client()).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey(key) })).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StorageConflictError();
        throw error;
      }
    },
    async open(key, start, end) {
      if (config.localCache) {
        const cache = cachePath(key);
        try {
          const info = await fs.stat(cache);
          const stream = start === undefined ? createReadStream(cache) : createReadStream(cache, { start, end });
          return { stream: asWebStream(stream), size: info.size };
        } catch (error) { if (!isMissingFile(error)) throw error; }
      }
      let range: string | undefined;
      if (start !== undefined) {
        if (!Number.isSafeInteger(start) || start < 0 || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) throw new Error("invalid storage range");
        let last = end;
        if (last === undefined) {
          const total = await headSize(key);
          if (total === undefined) return undefined;
          last = total - 1;
        }
        if (last < start) throw new Error("invalid storage range");
        range = `bytes=${start}-${last}`;
      } else if (end !== undefined) {
        throw new Error("invalid storage range");
      }
      let body: Readable;
      let size: number | undefined;
      try {
        const { GetObjectCommand } = await s3Sdk();
        const output = await (await client()).send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey(key), ...(range ? { Range: range } : {}) }));
        if (!output?.Body) return undefined;
        body = output.Body as Readable;
        size = range ? Number(/^bytes\s+\d+-\d+\/(\d+)$/.exec(String(output.ContentRange ?? ""))?.[1]) : Number(output.ContentLength);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      // Do not guess the total from the range length: ask HeadObject when the
      // range response omits ContentRange.
      if (!Number.isSafeInteger(size) || size === undefined || size < 0) size = await headSize(key);
      if (!Number.isSafeInteger(size) || size === undefined || size < 0) throw new Error("S3 storage did not report the object size");
      return { stream: asWebStream(body), size };
    },
    async delete(key) { await removeObject(key); },
    async deletePrefix(prefix) {
      const { ListObjectsV2Command, DeleteObjectsCommand } = await s3Sdk();
      const listingPrefix = `${config.prefix}/${prefix}/`;
      let token: string | undefined;
      do {
        const page = await (await client()).send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: listingPrefix, ContinuationToken: token }));
        const objects = (page?.Contents ?? []).map((entry: { Key?: string }) => entry.Key).filter((key: unknown): key is string => typeof key === "string");
        for (let index = 0; index < objects.length; index += 1000) {
          const batch = objects.slice(index, index + 1000);
          if (batch.length) await (await client()).send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: batch.map((Key: string) => ({ Key })), Quiet: true } }));
        }
        token = page?.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      await fs.rm(cachePath(prefix), { recursive: true, force: true });
    },
    async exists(key) {
      if (config.localCache) {
        try { await fs.stat(cachePath(key)); return true; }
        catch (error) { if (!isMissingFile(error)) throw error; }
      }
      try {
        const { HeadObjectCommand } = await s3Sdk();
        await (await client()).send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey(key) }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}

export function createStorage(config: StorageConfig, deps: StorageDependencies = {}): ResourceStorage {
  return config.kind === "local" ? createLocalStorage(deps.localRoot ?? defaultLocalRoot) : createS3Storage(config, deps);
}

let singleton: ResourceStorage | undefined;
export function resourceStorage(): ResourceStorage {
  return (singleton ??= createStorage(storageConfig()));
}