import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { decodeFrame, encodeFrame, headerValue, jsonPayload, type WsFrame } from "../src/feishu-ws-frames.ts";

const ADAPTER_PATH = path.resolve(import.meta.dir, "../src/feishu-adapter.ts");
const INIT_PARAMS = {
  protocolVersions: [1],
  eventSchemas: [1],
  sessionEpoch: "test",
  platform: "feishu",
  accounts: ["main"],
  maxFrameBytes: 1048576,
};
const START_PARAMS = { accounts: ["main"], cursors: {} };

interface FakeResponse {
  status?: number;
  body?: unknown;
}
interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

class FakeFeishu {
  readonly requests: RecordedRequest[] = [];
  wsUrl = "";
  tokenResponse: () => FakeResponse = () => ({
    body: { code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 },
  });
  wsResponse: () => FakeResponse = () => ({
    body: {
      code: 0,
      msg: "ok",
      data: {
        URL: this.wsUrl,
        ClientConfig: { PingInterval: 60, ReconnectCount: -1, ReconnectInterval: 60, ReconnectNonce: 0 },
      },
    },
  });
  sendResponse: () => FakeResponse = () => ({
    body: { code: 0, msg: "ok", data: { message_id: "om_sent" } },
  });
  readonly #server: Server;
  #port = 0;

  constructor() {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const url = request.url ?? "";
    this.requests.push({ method: request.method ?? "", url, body });
    const spec = url.startsWith("/open-apis/auth/")
      ? this.tokenResponse()
      : url.startsWith("/callback/ws/endpoint")
        ? this.wsResponse()
        : this.sendResponse();
    response.writeHead(spec.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(spec.body ?? {}));
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

class FakeWs {
  readonly frames: WsFrame[] = [];
  readonly ackCodes: number[] = [];
  url = "";
  #server?: ReturnType<typeof Bun.serve>;
  #socket?: any;
  start(): void {
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, server) => {
        if ((server.upgrade as (req: Request) => boolean)(request)) return undefined;
        return new Response("not a websocket");
      },
      websocket: {
        open: (socket) => {
          this.#socket = socket;
        },
        message: (_socket, data) => {
          this.#onFrame(data);
        },
      },
    });
    this.url = `ws://127.0.0.1:${this.#server.port}/ws/v2?service_id=7&device_id=test`;
  }

  async close(): Promise<void> {
    try {
      this.#socket?.close();
    } catch {
      // Socket may already be gone.
    }
    this.#server?.stop(true);
  }
  sendEvent(payload: unknown, headers: Array<{ key: string; value: string }> = []): void {
    this.#socket.send(encodeFrame({
      SeqID: 1,
      LogID: 2,
      service: 7,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "m-1" },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
        ...headers,
      ],
      payload: jsonPayload(payload),
    }));
  }
  #onFrame(data: Uint8Array | ArrayBuffer | string): void {
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    const frame = decodeFrame(bytes);
    this.frames.push(frame);
    const type = headerValue(frame, "type");
    if (type === "ping") {
      this.#socket.send(encodeFrame({
        SeqID: frame.SeqID,
        LogID: frame.LogID,
        service: frame.service,
        method: 0,
        headers: [{ key: "type", value: "pong" }],
        payload: jsonPayload({ PingInterval: 60, ReconnectCount: -1, ReconnectInterval: 60, ReconnectNonce: 0 }),
      }));
      return;
    }
    if (type === "event" && frame.payload) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(frame.payload)) as { code?: number };
        if (typeof parsed.code === "number") this.ackCodes.push(parsed.code);
      } catch {
        // A malformed ack is a test failure the caller can see via ackCodes.
      }
    }
  }
}

interface HostFrame {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string };
}
interface IngestSpec {
  result?: unknown;
  error?: { code: number; message: string };
}

class Child {
  readonly child: ChildProcessWithoutNullStreams;
  readonly requests: HostFrame[] = [];
  readonly statuses: Array<{ inbound?: string; detail?: string }> = [];
  readonly ingestResults: IngestSpec[] = [];
  readonly #responses = new Map<string, HostFrame>();
  readonly #waiters = new Map<string, (frame: HostFrame) => void>();
  readonly #stderr: string[] = [];
  #buffer = "";
  #sequence = 0;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [ADAPTER_PATH], {
      env: { ...process.env, CHANNELD_ACCOUNT_ID: "main", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.#ingest(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.#stderr.push(chunk));
  }

  get stderr(): string {
    return this.#stderr.join("");
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as HostFrame;
      if (frame.method && frame.id !== undefined) this.#answer(frame);
      else this.#settle(frame);
      newline = this.#buffer.indexOf("\n");
    }
  }
  #settle(frame: HostFrame): void {
    const waiter = this.#waiters.get(String(frame.id));
    if (waiter) {
      this.#waiters.delete(String(frame.id));
      waiter(frame);
    } else {
      this.#responses.set(String(frame.id), frame);
    }
  }
  #answer(frame: HostFrame): void {
    this.requests.push(frame);
    let result: unknown = {};
    let error: { code: number; message: string } | undefined;
    if (frame.method === "ingest") {
      const spec = this.ingestResults.shift();
      if (spec?.error) error = spec.error;
      else result = spec?.result ?? { committed: true };
    } else if (frame.method === "status") {
      this.statuses.push(frame.params ?? {});
    }
    const reply = error
      ? { jsonrpc: "2.0", id: frame.id, error }
      : { jsonrpc: "2.0", id: frame.id, result };
    this.child.stdin.write(`${JSON.stringify(reply)}\n`);
  }
  request(method: string, params?: unknown, timeoutMs = 5000): Promise<HostFrame> {
    const id = `t-${++this.#sequence}`;
    const settled = this.#responses.get(id);
    if (settled) {
      this.#responses.delete(id);
      return Promise.resolve(settled);
    }
    const response = new Promise<HostFrame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}; stderr: ${this.stderr}`)),
        timeoutMs,
      );
      this.#waiters.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  async waitForIngest(timeoutMs = 5000): Promise<HostFrame> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.requests.find((frame) => frame.method === "ingest");
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ingest; stderr: ${this.stderr}`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Bun.sleep(100);
    if (this.child.exitCode === null) this.child.kill();
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startFake(): Promise<{ http: FakeFeishu; ws: FakeWs }> {
  const http = new FakeFeishu();
  const ws = new FakeWs();
  ws.start();
  http.wsUrl = ws.url;
  await http.start();
  cleanups.push(() => http.close());
  cleanups.push(() => ws.close());
  return { http, ws };
}

function newChild(env: Record<string, string>): Child {
  const child = new Child(env);
  cleanups.push(() => child.close());
  return child;
}

async function boot(
  http: FakeFeishu,
  env: Record<string, string> = {},
): Promise<Child> {
  const child = newChild({
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret_test",
    FEISHU_BASE_URL: http.baseUrl,
    ...env,
  });
  const initialized = await child.request("initialize", INIT_PARAMS);
  expect(initialized.error).toBeUndefined();
  const started = await child.request("start", START_PARAMS);
  expect(started.error).toBeUndefined();
  expect(started.result).toEqual({ ready: true });
  return child;
}

function messageEvent(overrides: {
  eventId?: string;
  messageId?: string;
  chatId?: string;
  senderType?: string;
  messageType?: string;
  content?: string;
  parentId?: string;
  appId?: string;
} = {}): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: overrides.eventId ?? "evt-1",
      event_type: "im.message.receive_v1",
      app_id: overrides.appId ?? "cli_test",
      create_time: String(Date.now()),
    },
    event: {
      sender: {
        sender_type: overrides.senderType ?? "user",
        sender_id: { open_id: "ou_alice" },
      },
      message: {
        message_id: overrides.messageId ?? "om_1",
        chat_id: overrides.chatId ?? "oc_allowed",
        chat_type: "group",
        message_type: overrides.messageType ?? "text",
        content: overrides.content ?? JSON.stringify({ text: "hello from feishu" }),
        ...(overrides.parentId ? { parent_id: overrides.parentId } : {}),
      },
    },
  };
}

async function waitForAck(ws: FakeWs, code: number, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ws.ackCodes.includes(code)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ack ${code}; got ${JSON.stringify(ws.ackCodes)}`);
}

async function waitForAckCount(ws: FakeWs, count: number, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ws.ackCodes.length >= count) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${count} acks; got ${JSON.stringify(ws.ackCodes)}`);
}

const INBOUND_ENV = { FEISHU_INBOUND: "1", FEISHU_INBOUND_CHATS: "oc_allowed" };

describe("feishu inbound long connection", () => {
  test("an allowlisted human message becomes one ingest event and is acknowledged", async () => {
    const { http, ws } = await startFake();
    const child = await boot(http, INBOUND_ENV);
    await Bun.sleep(50);
    expect(ws.frames.some((frame) => headerValue(frame, "type") === "ping")).toBe(true);

    ws.sendEvent(messageEvent({ parentId: "om_parent" }));
    const ingest = await child.waitForIngest();
    expect(ingest.params).toMatchObject({
      kind: "message.created",
      source: { platform: "feishu", accountId: "main", roomId: "oc_allowed" },
      actor: { platform: "feishu", identityNamespace: "open_id", nativeUserId: "ou_alice" },
      providerEventId: "evt-1",
      sourceDedupKey: "feishu:main:evt-1",
      content: { text: "hello from feishu" },
      message: { nativeMessageId: "om_1" },
      parent: { nativeMessageId: "om_parent" },
    });
    await waitForAck(ws, 200);
  });

  test("a failed ingest is retried and acknowledged instead of being deduped away", async () => {
    const { http, ws } = await startFake();
    const child = await boot(http, INBOUND_ENV);
    child.ingestResults.push({ error: { code: -32603, message: "host commit failed" } });
    child.ingestResults.push({ result: { committed: true } });

    ws.sendEvent(messageEvent());
    await waitForAck(ws, 500);
    // Feishu redelivers the same event after the non-200 ack.
    ws.sendEvent(messageEvent());
    await waitForAck(ws, 200);

    expect(child.requests.filter((frame) => frame.method === "ingest")).toHaveLength(2);
    expect(ws.ackCodes).toEqual([500, 200]);
    expect(child.stderr).not.toContain("duplicate skipped");
  });

  test("bot, other-chat, and unsupported messages are acknowledged without ingest", async () => {
    const { http, ws } = await startFake();
    const child = await boot(http, INBOUND_ENV);

    ws.sendEvent(messageEvent({ eventId: "evt-app", messageId: "om_app", senderType: "app" }));
    await waitForAckCount(ws, 1);
    ws.sendEvent(messageEvent({ eventId: "evt-other", messageId: "om_other", chatId: "oc_other" }));
    await waitForAckCount(ws, 2);
    ws.sendEvent(messageEvent({
      eventId: "evt-image",
      messageId: "om_image",
      messageType: "image",
      content: JSON.stringify({ image_key: "img_1" }),
    }));
    await waitForAckCount(ws, 3);
    ws.sendEvent(messageEvent({ eventId: "evt-appmismatch", messageId: "om_mismatch", appId: "cli_other" }));
    await waitForAckCount(ws, 4);

    expect(child.requests.filter((frame) => frame.method === "ingest")).toHaveLength(0);
    expect(ws.ackCodes).toEqual([200, 200, 200, 200]);
  });

  test("inbound start failure keeps outbound send working and reports a sanitized status", async () => {
    const { http, ws } = await startFake();
    http.wsResponse = () => ({ body: { code: 1000040346, msg: "app_id is invalid" } });
    const child = await boot(http, INBOUND_ENV);

    expect(child.statuses.some((status) => status.inbound === "failed")).toBe(true);
    expect(child.child.exitCode).toBeNull();

    const sent = await child.request("send", {
      deliveryId: "d1",
      attemptId: "a1",
      idempotencyKey: "outbound-key",
      target: { platform: "feishu", accountId: "main", roomId: "oc_chat" },
      payload: { text: "outbound still works" },
    });
    expect(sent.result).toEqual({
      state: "sent",
      providerMessage: {
        endpoint: { platform: "feishu", accountId: "main", roomId: "oc_chat" },
        nativeMessageId: "om_sent",
      },
    });
    expect(child.stderr).toContain("inbound disabled; outbound stays active");
    expect(child.stderr).not.toContain("secret_test");
    expect(child.stderr).not.toContain("t-1");
    expect(ws.ackCodes).toHaveLength(0);
  });

  test("inbound requires an explicit chat allowlist", async () => {
    const { http } = await startFake();
    const child = newChild({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
      FEISHU_BASE_URL: http.baseUrl,
      FEISHU_INBOUND: "1",
    });
    const initialized = await child.request("initialize", INIT_PARAMS);
    expect(initialized.result).toBeUndefined();
    expect(initialized.error?.message).toContain("FEISHU_INBOUND_CHATS");
  });

  test("inbound stays off by default and outbound is unchanged", async () => {
    const { http } = await startFake();
    const child = await boot(http);
    const initialized = await child.request("initialize", INIT_PARAMS);
    expect(initialized.result.accounts.main.ingress).toBeUndefined();
    expect(http.requests.some((request) => request.url.startsWith("/callback/ws/endpoint"))).toBe(false);
    expect(child.requests).toHaveLength(0);
  });
});