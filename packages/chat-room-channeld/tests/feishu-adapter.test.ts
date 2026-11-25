import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const ADAPTER_PATH = path.resolve(import.meta.dir, "../src/feishu-adapter.ts");
const DIST_PATH = path.resolve(import.meta.dir, "../dist/feishu-adapter.js");
const TARGET = { platform: "feishu", accountId: "main", roomId: "oc_chat" };
interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
  destroy?: boolean;
}
interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

class FakeFeishu {
  readonly requests: RecordedRequest[] = [];
  tokenResponse: (call: number) => FakeResponse = () => tokenOk();
  sendResponse: (call: number) => FakeResponse = () => ({ body: { code: 0, msg: "ok", data: { message_id: "om_default" } } });
  readonly #server: Server;
  #port = 0;
  #tokenCalls = 0;
  #sendCalls = 0;
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
  tokenRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.url.startsWith("/open-apis/auth/"));
  }
  sendRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.url.startsWith("/open-apis/im/v1/messages"));
  }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    this.requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
    const isToken = (request.url ?? "").startsWith("/open-apis/auth/");
    const spec = isToken ? this.tokenResponse(this.#tokenCalls++) : this.sendResponse(this.#sendCalls++);
    if (spec.delayMs) await Bun.sleep(spec.delayMs);
    if (spec.destroy) {
      request.socket.destroy();
      return;
    }
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(spec.status ?? 200, { "content-type": "application/json", ...spec.headers });
    response.end(typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {}));
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

function tokenOk(token = "t-1", expire = 7200): FakeResponse {
  return { body: { code: 0, msg: "ok", tenant_access_token: token, expire } };
}

interface AdapterFrame {
  id?: string | number;
  result?: any;
  error?: { code: number; message: string };
}

interface Waiter {
  resolve: (frame: AdapterFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class Child {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #stderr: string[] = [];
  readonly #queue: AdapterFrame[] = [];
  readonly #waiters: Waiter[] = [];
  #buffer = "";
  #sequence = 0;

  constructor(env: Record<string, string>, binary = process.execPath, script = ADAPTER_PATH) {
    this.child = spawn(binary, [script], {
      env: { ...process.env, CHANNELD_ACCOUNT_ID: "main", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.#ingest(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.#stderr.push(chunk));
    this.child.once("exit", () => {
      const error = new Error(`adapter exited; stderr: ${this.stderr}`);
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
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
      if (line) {
        const frame = JSON.parse(line) as AdapterFrame;
        const waiter = this.#waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else {
          this.#queue.push(frame);
        }
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  next(timeoutMs = 5000): Promise<AdapterFrame> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for adapter frame; stderr: ${this.stderr}`)),
        timeoutMs,
      );
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  request(method: string, params?: unknown): Promise<AdapterFrame> {
    const id = `t-${++this.#sequence}`;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return this.next();
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    await Promise.race([exited, Bun.sleep(1000)]);
    if (this.child.exitCode === null) this.child.kill();
  }
}
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startFake(): Promise<FakeFeishu> {
  const fake = new FakeFeishu();
  await fake.start();
  cleanups.push(() => fake.close());
  return fake;
}

function newChild(env: Record<string, string>): Child {
  const child = new Child(env);
  cleanups.push(() => child.close());
  return child;
}

const INIT_PARAMS = {
  protocolVersions: [1],
  eventSchemas: [1],
  sessionEpoch: "test",
  platform: "feishu",
  accounts: ["main"],
  maxFrameBytes: 1048576,
};
const START_PARAMS = { accounts: ["main"], cursors: {} };

async function boot(fake: FakeFeishu, env: Record<string, string> = {}): Promise<Child> {
  const child = newChild({
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret_test",
    FEISHU_BASE_URL: fake.baseUrl,
    ...env,
  });
  const initialized = await child.request("initialize", INIT_PARAMS);
  expect(initialized.error).toBeUndefined();
  const started = await child.request("start", START_PARAMS);
  expect(started.error).toBeUndefined();
  return child;
}

function send(child: Child, idempotencyKey: string, text = "hello"): Promise<AdapterFrame> {
  return child.request("send", {
    deliveryId: "d1",
    attemptId: "a1",
    idempotencyKey,
    target: TARGET,
    payload: { text },
  });
}

describe("feishu adapter", () => {
  test("initialize advertises the account and start validates the tenant token", async () => {
    const fake = await startFake();
    const child = newChild({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
      FEISHU_BASE_URL: fake.baseUrl,
    });

    const initialized = await child.request("initialize", INIT_PARAMS);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result.version).toBe(1);
    expect(initialized.result.eventSchema).toBe(1);
    expect(initialized.result.maxFrameBytes).toBe(1048576);
    expect(initialized.result.accounts.main.send).toEqual({
      text: true,
      format: ["text", "markdown"],
      reply: "none",
      idempotency: "persistent_delivery_key",
    });
    expect(fake.tokenRequests()).toHaveLength(0);

    const started = await child.request("start", START_PARAMS);
    expect(started.result).toEqual({ ready: true });
    const tokenRequests = fake.tokenRequests();
    expect(tokenRequests).toHaveLength(1);
    expect(JSON.parse(tokenRequests[0]!.body)).toEqual({
      app_id: "cli_test",
      app_secret: "secret_test",
    });
    expect(child.stderr).not.toContain("secret_test");
  });

  test("send posts a Markdown card and returns the native message id", async () => {
    const fake = await startFake();
    fake.sendResponse = () => ({ body: { code: 0, msg: "ok", data: { message_id: "om_1" } } });
    const child = await boot(fake);
    const uuid = createHash("sha256").update("key-1").digest("hex").slice(0, 32);

    const sent = await send(child, "key-1", "hello world");
    expect(sent.result).toEqual({
      state: "sent",
      providerMessage: { endpoint: TARGET, nativeMessageId: "om_1" },
    });

    const requests = fake.sendRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(requests[0]!.headers.authorization).toBe("Bearer t-1");
    expect(requests[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
    const posted = JSON.parse(requests[0]!.body) as {
      receive_id: string;
      msg_type: string;
      content: string;
      uuid: string;
    };
    expect(posted).toMatchObject({ receive_id: "oc_chat", msg_type: "interactive", uuid });
    expect(JSON.parse(posted.content)).toEqual({
      config: { wide_screen_mode: true },
      elements: [{ tag: "div", text: { tag: "lark_md", content: "hello world" } }],
    });
    expect(child.stderr).not.toContain("hello world");
    expect(child.stderr).not.toContain("secret_test");
    expect(child.stderr).not.toContain("t-1");
    expect(child.stderr).not.toContain(uuid);
  });

  test("uuid is stable per idempotency key and differs for another key", async () => {
    const fake = await startFake();
    fake.sendResponse = (call) => ({ body: { code: 0, data: { message_id: `om_${call}` } } });
    const child = await boot(fake);

    await send(child, "same-key", "one");
    await send(child, "same-key", "two");
    await send(child, "other-key", "three");
    const bodies = fake.sendRequests().map((request) => JSON.parse(request.body) as { uuid: string });
    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.uuid).toBe(bodies[1]!.uuid);
    expect(bodies[0]!.uuid).not.toBe(bodies[2]!.uuid);
    expect(bodies[0]!.uuid).toMatch(/^[0-9a-f]{32}$/);
    expect(bodies[0]!.uuid).toBe(createHash("sha256").update("same-key").digest("hex").slice(0, 32));
  });

  test("rate limit codes and HTTP 429 return rate_limited with Retry-After", async () => {
    const fake = await startFake();
    const specs: FakeResponse[] = [
      { body: { code: 230020, msg: "too many" }, headers: { "retry-after": "2" } },
      { status: 429, body: "slow down", headers: { "retry-after": "5" } },
      { body: { code: 99991400, msg: "limit" } },
      { status: 429, body: "slow down" },
      {
        body: { code: 230020, msg: "too many" },
        headers: { "retry-after": new Date(Date.now() + 5000).toUTCString() },
      },
    ];
    fake.sendResponse = (call) => specs[call] ?? specs[0]!;
    const child = await boot(fake);

    const first = await send(child, "k1");
    expect(first.result.state).toBe("rate_limited");
    expect(first.result.retryAfterMs).toBe(2000);

    const second = await send(child, "k2");
    expect(second.result.state).toBe("rate_limited");
    expect(second.result.retryAfterMs).toBe(5000);

    const third = await send(child, "k3");
    expect(third.result.state).toBe("rate_limited");
    expect(third.result.retryAfterMs).toBe(1000);

    const fourth = await send(child, "k4");
    expect(fourth.result.state).toBe("rate_limited");
    expect(fourth.result.retryAfterMs).toBe(1000);

    const fifth = await send(child, "k5");
    expect(fifth.result.state).toBe("rate_limited");
    expect(fifth.result.retryAfterMs).toBeGreaterThan(3000);
    expect(fifth.result.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  test("an invalid tenant token refreshes once and retries the send", async () => {
    const fake = await startFake();
    fake.tokenResponse = (call) => tokenOk(call === 0 ? "t-1" : "t-2");
    fake.sendResponse = (call) =>
      call === 0
        ? { body: { code: 99991663, msg: "invalid tenant token" } }
        : { body: { code: 0, msg: "ok", data: { message_id: "om_after_refresh" } } };
    const child = await boot(fake);

    const sent = await send(child, "refresh-key");
    expect(sent.result).toEqual({
      state: "sent",
      providerMessage: { endpoint: TARGET, nativeMessageId: "om_after_refresh" },
    });
    expect(fake.tokenRequests()).toHaveLength(2);
    expect(fake.sendRequests()).toHaveLength(2);
    expect(fake.sendRequests()[1]!.headers.authorization).toBe("Bearer t-2");
  });

  test("a tenant token rejected twice is permanent with the code only", async () => {
    const fake = await startFake();
    fake.tokenResponse = () => tokenOk("t-rejected");
    fake.sendResponse = () => ({ body: { code: 99991663, msg: "invalid tenant token" } });
    const child = await boot(fake);

    const sent = await send(child, "rejected-key");
    expect(sent.result.state).toBe("permanent");
    expect(sent.result.detail).toContain("99991663");
    expect(sent.result.detail).not.toContain("invalid tenant token");
    expect(fake.tokenRequests()).toHaveLength(2);
    expect(fake.sendRequests()).toHaveLength(2);
    expect(child.stderr).not.toContain("t-rejected");
  });

  test("5xx and connection resets are retryable, malformed responses are unknown", async () => {
    const fake = await startFake();
    const specs: FakeResponse[] = [
      { status: 500, body: { code: 0 } },
      { destroy: true },
      { body: "not json" },
    ];
    fake.sendResponse = (call) => specs[call] ?? specs[0]!;
    const child = await boot(fake);

    const serverError = await send(child, "f1");
    expect(serverError.result.state).toBe("retryable");
    expect(serverError.result.detail).toContain("500");

    const reset = await send(child, "f2");
    expect(reset.result.state).toBe("retryable");
    expect(reset.result.detail).toContain("network error");

    const malformed = await send(child, "f3");
    expect(malformed.result.state).toBe("unknown");
  });

  test("client error statuses are permanent even without a JSON body", async () => {
    const fake = await startFake();
    const statuses = [400, 401, 403, 404];
    fake.sendResponse = (call) => ({ status: statuses[call] ?? 400, body: "not json" });
    const child = await boot(fake);

    for (const status of statuses) {
      const response = await send(child, `http-${status}`);
      expect(response.result.state).toBe("permanent");
      expect(response.result.detail).toBe(`feishu http ${status}`);
    }
    fake.sendResponse = () => ({
      status: 400,
      body: { code: 230020, msg: "too many" },
      headers: { "retry-after": "3" },
    });
    const limited = await send(child, "http-230020");
    expect(limited.result).toMatchObject({ state: "rate_limited", retryAfterMs: 3000 });

    fake.sendResponse = () => ({ status: 403, body: { code: 230027, msg: "no permission" } });
    const denied = await send(child, "http-230027");
    expect(denied.result).toMatchObject({ state: "permanent", detail: "feishu code 230027: no permission" });
  });

  test("a request timeout is unknown and never retryable", async () => {
    const fake = await startFake();
    fake.sendResponse = () => ({ delayMs: 500, body: { code: 0, data: { message_id: "late" } } });
    const child = await boot(fake, { FEISHU_HTTP_TIMEOUT_MS: "100" });

    const timedOut = await send(child, "timeout-key");
    expect(timedOut.result.state).toBe("unknown");
    expect(timedOut.result.detail).toContain("timed out");
  });

  test("permission errors are permanent with code and message", async () => {
    const fake = await startFake();
    const codes = [230002, 230025, 230027, 230034, 230035];
    fake.sendResponse = (call) => {
      const code = codes[call] ?? codes[0]!;
      return { status: 400, body: { code, msg: `denied-${code}` } };
    };
    const child = await boot(fake);

    for (let index = 0; index < codes.length; index += 1) {
      const sent = await send(child, `perm-${index}`);
      expect(sent.result.state).toBe("permanent");
      expect(sent.result.detail).toContain(String(codes[index]));
      expect(sent.result.detail).toContain(`denied-${codes[index]}`);
    }
  });

  test("missing credentials fail initialize", async () => {
    const child = newChild({ FEISHU_APP_ID: "", FEISHU_APP_SECRET: "" });

    const initialized = await child.request("initialize", INIT_PARAMS);
    expect(initialized.result).toBeUndefined();
    expect(initialized.error?.message).toContain("FEISHU_APP_ID");
    expect(initialized.error?.message).toContain("FEISHU_APP_SECRET");
  });

  test("invalid credentials fail start with code and message only", async () => {
    const fake = await startFake();
    fake.tokenResponse = () => ({ status: 400, body: { code: 10003, msg: "invalid param" } });
    const child = newChild({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
      FEISHU_BASE_URL: fake.baseUrl,
    });

    const initialized = await child.request("initialize", INIT_PARAMS);
    expect(initialized.error).toBeUndefined();
    const started = await child.request("start", START_PARAMS);
    expect(started.result).toBeUndefined();
    expect(started.error?.message).toContain("10003");
    expect(started.error?.message).toContain("invalid param");
    expect(started.error?.message).not.toContain("secret_test");
    expect(child.stderr).not.toContain("secret_test");
  });

  test.skipIf(!existsSync(DIST_PATH))("built dist runs the stdio handshake under node", async () => {
    const fake = await startFake();
    fake.sendResponse = () => ({ body: { code: 0, msg: "ok", data: { message_id: "om_dist" } } });
    const child = new Child(
      { FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret_test", FEISHU_BASE_URL: fake.baseUrl },
      "node",
      DIST_PATH,
    );
    cleanups.push(() => child.close());

    expect((await child.request("initialize", INIT_PARAMS)).error).toBeUndefined();
    expect((await child.request("start", START_PARAMS)).result).toEqual({ ready: true });
    const sent = await send(child, "dist-key");
    expect(sent.result).toMatchObject({ state: "sent", providerMessage: { nativeMessageId: "om_dist" } });
  });
});