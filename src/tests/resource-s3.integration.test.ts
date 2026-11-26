// Real S3 resource test against a disposable RustFS container.
// Run with: RESOURCE_S3_INTEGRATION=1 bun test src/tests/resource-s3.integration.test.ts
import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CreateBucketCommand, DeleteBucketCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, S3Client,
} from "@aws-sdk/client-s3";

const enabled = process.env.RESOURCE_S3_INTEGRATION === "1";

test.skipIf(!enabled)("S3 resources upload, range, cache, fail closed, and return to local", async () => {
  const suffix = randomUUID().slice(0, 8);
  const token = `s3-integration-${suffix}`;
  const accessKeyId = `access-${suffix}`, secretAccessKey = `secret-${randomUUID()}`;
  const bucket = `chat-room-${suffix}`, container = `chat-room-rustfs-${suffix}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "__Test_resource-s3-"));
  const stateDir = path.join(root, "state"), dataDir = path.join(root, "rustfs-data");
  await mkdir(dataDir, { recursive: true });
  const s3Port = await unusedPort(), s3Endpoint = `http://127.0.0.1:${s3Port}`;
  let chatServer: ChildProcess | undefined, stderr = "";
  const client = new S3Client({ endpoint: s3Endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  try {
    const started = spawnSync("docker", ["run", "-d", "--name", container, "-p", `127.0.0.1:${s3Port}:9000`, "-v", `${dataDir}:/data`,
      "-e", `RUSTFS_ACCESS_KEY=${accessKeyId}`, "-e", `RUSTFS_SECRET_KEY=${secretAccessKey}`, "rustfs/rustfs:latest"], { encoding: "utf8" });
    if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);
    await waitForHttp(`${s3Endpoint}/`, 120);
    await client.send(new CreateBucketCommand({ Bucket: bucket }));

    const serverPort = await unusedPort(), origin = `http://127.0.0.1:${serverPort}`;
    chatServer = startChat(serverPort, stateDir, root, s3Env({ CHAT_ROOM_STORAGE: "s3", CHAT_ROOM_S3_BUCKET: bucket, CHAT_ROOM_S3_ACCESS_KEY_ID: accessKeyId, CHAT_ROOM_S3_SECRET_ACCESS_KEY: secretAccessKey, CHAT_ROOM_S3_ENDPOINT: s3Endpoint }), token, (text) => { stderr += text; });
    await waitForServer(origin, chatServer, () => stderr);
    const roomID = await createRoom(origin, token);
    const bytes = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 251));

    const uploaded = await upload(origin, token, roomID, "probe.bin", bytes);
    expect(uploaded.status).toBe(201);
    const resource = (await uploaded.json()).resource as { id: string; size: number; mimeType: string };
    expect(resource.size).toBe(bytes.length);
    const cachePath = path.join(stateDir, "resources", roomID, resource.id);
    expect((await stat(cachePath)).size).toBe(bytes.length);
    const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `chat-room/${roomID}/${resource.id}` }));
    expect(object.ContentLength).toBe(bytes.length);

    const full = await fetch(`${origin}/rooms/${roomID}/resources/${resource.id}/content`, { headers: auth(token) });
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
    const ranged = await fetch(`${origin}/rooms/${roomID}/resources/${resource.id}/content`, { headers: { ...auth(token), Range: "bytes=100-199" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 100-199/${bytes.length}`);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(100, 200));
    const invalid = await fetch(`${origin}/rooms/${roomID}/resources/${resource.id}/content`, { headers: { ...auth(token), Range: `bytes=${bytes.length}-` } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(`bytes */${bytes.length}`);

    const removed = await fetch(`${origin}/rooms/${roomID}/resources/${resource.id}`, { method: "DELETE", headers: { ...auth(token), "Content-Type": "application/json", "X-Session-ID": "member" } });
    expect(removed.status).toBe(200);
    await expect(client.send(new HeadObjectCommand({ Bucket: bucket, Key: `chat-room/${roomID}/${resource.id}` }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    await expect(stat(cachePath)).rejects.toThrow();
    expect((await fetch(`${origin}/rooms/${roomID}/resources/${resource.id}`, { headers: auth(token) })).status).toBe(404);

    // Cached reads keep working while S3 is down; uploads fail closed with no DB row.
    const cached = await upload(origin, token, roomID, "cached.bin", bytes);
    expect(cached.status).toBe(201);
    const cachedResource = (await cached.json()).resource as { id: string };
    docker(["stop", container]);
    const fromCache = await fetch(`${origin}/rooms/${roomID}/resources/${cachedResource.id}/content`, { headers: auth(token) });
    expect(fromCache.status).toBe(200);
    expect(Buffer.from(await fromCache.arrayBuffer())).toEqual(bytes);
    expect((await upload(origin, token, roomID, "failed.bin", bytes)).status).toBe(500);
    const listed = await (await fetch(`${origin}/rooms/${roomID}/resources?limit=500&offset=0`, { headers: { ...auth(token), "X-Session-ID": "member" } })).json() as { total: number };
    expect(listed.total).toBe(1);

    docker(["start", container]);
    await waitForHttp(`${s3Endpoint}/`, 120);
    const recovered = await upload(origin, token, roomID, "recovered.bin", bytes);
    expect(recovered.status).toBe(201);
    const recoveredResource = (await recovered.json()).resource as { id: string };
    docker(["stop", container]);

    // A local server reads the cached object after switching storage back to local.
    await stopServer(chatServer); chatServer = undefined;
    const localPort = await unusedPort(), localOrigin = `http://127.0.0.1:${localPort}`;
    chatServer = startChat(localPort, stateDir, root, { CHAT_ROOM_STORAGE: "local" }, token, (text) => { stderr += text; });
    await waitForServer(localOrigin, chatServer, () => stderr);
    const localRead = await fetch(`${localOrigin}/rooms/${roomID}/resources/${recoveredResource.id}/content`, { headers: auth(token) });
    expect(localRead.status).toBe(200);
    expect(Buffer.from(await localRead.arrayBuffer())).toEqual(bytes);
  } finally {
    if (chatServer) await stopServer(chatServer).catch(() => {});
    // Restart a stopped container so the bucket can be emptied explicitly.
    const inspected = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" });
    if (inspected.status === 0 && inspected.stdout.trim() !== "true") {
      spawnSync("docker", ["start", container], { stdio: "ignore" });
      await waitForHttp(`${s3Endpoint}/`, 40).catch(() => {});
    }
    await client.send(new ListObjectsV2Command({ Bucket: bucket })).then(async (page) => {
      const objects = (page.Contents ?? []).map((entry) => ({ Key: entry.Key! }));
      if (objects.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } })).catch(() => {});
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    }).catch(() => {});
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

function auth(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` }; }

function s3Env(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CHAT_ROOM_S3_") || key === "CHAT_ROOM_STORAGE" || key === "CHAT_ROOM_SERVER_URL" || key === "CHAT_ROOM_WAKE_SERVE_URL") delete env[key];
  }
  return { ...env, ...overrides };
}

function startChat(port: number, stateDir: string, root: string, overrides: NodeJS.ProcessEnv, token: string, onStderr: (text: string) => void): ChildProcess {
  const env = {
    ...s3Env(overrides),
    HOME: path.join(root, "home"), XDG_STATE_HOME: path.join(root, "state-home"), XDG_CONFIG_HOME: path.join(root, "config"),
    CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token, CHAT_ROOM_STATE_DIR: stateDir,
  };
  const child = spawn(process.execPath, ["server/chat-server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (data) => onStderr(String(data)));
  return child;
}

async function createRoom(origin: string, token: string): Promise<string> {
  const response = await fetch(`${origin}/rooms`, {
    method: "POST", headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "__Test_s3_resources", ownerId: "tester", sessionID: "member" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function upload(origin: string, token: string, roomID: string, name: string, body: Buffer) {
  return await fetch(`${origin}/rooms/${roomID}/resources`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/octet-stream", "X-Session-ID": "member", "X-File-Name": encodeURIComponent(name), "X-Resource-ID": randomUUID() },
    body: new Uint8Array(body),
  });
}

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function waitForHttp(url: string, attempts: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await fetch(url); return; } catch { /* Starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`S3 endpoint did not start: ${url}`);
}

async function waitForServer(origin: string, child: ChildProcess, diagnostics: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`chat server exited early: ${diagnostics()}`);
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`chat server did not start: ${diagnostics()}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([exited, timeout]);
  if (child.exitCode === null) child.kill("SIGKILL");
}