import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFrameReader, writeFrame } from "./framing.ts";
import {
  EVENT_SCHEMA_VERSION,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  rpcError,
  rpcResult,
  type Endpoint,
} from "./protocol.ts";

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_MS = 1000;
const TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;
const FALLBACK_TOKEN_TTL_SECONDS = 7200;
const TOKEN_INVALID_CODE = 99991663;
const RATE_LIMIT_CODES = new Set([230020, 99991400]);

type SendState = "sent" | "retryable" | "rate_limited" | "permanent" | "unsupported" | "unknown";

interface SendReceipt {
  state: SendState;
  providerMessage?: { endpoint: Endpoint; nativeMessageId: string };
  retryAfterMs?: number;
  detail?: string;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  timeoutMs: number;
}

interface AdapterState {
  accountId: string;
  config?: FeishuConfig;
  token?: string;
  tokenExpiresAt: number;
  started: boolean;
}

interface SendTarget {
  roomId?: unknown;
  room?: unknown;
}

interface SendParams {
  idempotencyKey?: unknown;
  target?: SendTarget;
  payload?: unknown;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body?: unknown;
}

class FeishuTimeoutError extends Error {
  constructor() {
    super("feishu request timed out");
    this.name = "FeishuTimeoutError";
  }
}

class FeishuApiError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
    readonly scope: "token" | "send",
  ) {
    super(`feishu ${scope} code ${code}: ${msg}`);
    this.name = "FeishuApiError";
  }
}

function logLine(accountId: string, message: string): void {
  console.error(`feishu adapter ${accountId}: ${message}`);
}

/** Stable 32-hex SHA-256 prefix used as the Feishu idempotent message uuid. */
export function deterministicUuid(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configFromEnv(env: NodeJS.ProcessEnv): FeishuConfig | { error: string } {
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  const missing: string[] = [];
  if (!appId) missing.push("FEISHU_APP_ID");
  if (!appSecret) missing.push("FEISHU_APP_SECRET");
  if (!appId || !appSecret) {
    return { error: `feishu adapter requires ${missing.join(" and ")}` };
  }
  const timeout = Number(env.FEISHU_HTTP_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
  const baseUrl = (env.FEISHU_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { appId, appSecret, baseUrl, timeoutMs };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<RawResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    // A timeout means the request may already be in Feishu's hands.
    if (timedOut) throw new FeishuTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestToken(config: FeishuConfig): Promise<{ token: string; expiresAt: number }> {
  const raw = await fetchJson(
    `${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    },
    config.timeoutMs,
  );
  const body = raw.body;
  if (!isRecord(body) || typeof body.code !== "number") {
    throw new Error("feishu token response was malformed");
  }
  if (body.code !== 0) {
    throw new FeishuApiError(body.code, typeof body.msg === "string" ? body.msg : "", "token");
  }
  if (typeof body.tenant_access_token !== "string" || body.tenant_access_token.length === 0) {
    throw new Error("feishu token response was malformed");
  }
  const expire =
    typeof body.expire === "number" && body.expire > 0 ? body.expire : FALLBACK_TOKEN_TTL_SECONDS;
  return { token: body.tenant_access_token, expiresAt: Date.now() + expire * 1000 };
}

async function ensureToken(config: FeishuConfig, state: AdapterState, force = false): Promise<string> {
  if (!force && state.token && state.tokenExpiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return state.token;
  }
  const fresh = await requestToken(config);
  state.token = fresh.token;
  state.tokenExpiresAt = fresh.expiresAt;
  logLine(state.accountId, "tenant token acquired");
  return fresh.token;
}

function errorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown } | null)?.code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === "string" ? cause : undefined;
}

function networkFailure(error: unknown): SendReceipt {
  const code = errorCode(error);
  return { state: "retryable", detail: code ? `feishu network error (${code})` : "feishu network error" };
}

function failureReceipt(error: unknown): SendReceipt {
  if (error instanceof FeishuTimeoutError) {
    return { state: "unknown", detail: error.message };
  }
  if (error instanceof FeishuApiError) {
    if (RATE_LIMIT_CODES.has(error.code)) {
      return { state: "rate_limited", retryAfterMs: DEFAULT_RATE_LIMIT_MS, detail: `feishu code ${error.code}` };
    }
    return { state: "permanent", detail: error.message };
  }
  if (error instanceof Error && error.message === "feishu token response was malformed") {
    return { state: "permanent", detail: error.message };
  }
  return networkFailure(error);
}

function parseRetryAfter(value: string | null): number {
  if (!value) return DEFAULT_RATE_LIMIT_MS;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return DEFAULT_RATE_LIMIT_MS;
}

function apiCode(raw: RawResponse): number | undefined {
  return isRecord(raw.body) && typeof raw.body.code === "number" ? raw.body.code : undefined;
}

/** A Feishu business error, as opposed to an HTTP transport failure. */
function isApiFailure(raw: RawResponse): boolean {
  const code = apiCode(raw);
  return raw.status !== 429 && raw.status < 500 && code !== undefined && code !== 0;
}

const CLIENT_ERROR_STATUSES = new Set([400, 401, 403, 404]);

function apiResponseDetail(body: unknown, status: number): string {
  const code = isRecord(body) && typeof body.code === "number" ? body.code : undefined;
  const msg = isRecord(body) && typeof body.msg === "string" ? body.msg : "";
  if (code !== undefined && code !== 0) return msg ? `feishu code ${code}: ${msg}` : `feishu code ${code}`;
  return `feishu http ${status}`;
}

function mapSendResponse(raw: RawResponse, endpoint: Endpoint): SendReceipt {
  if (raw.status === 429) {
    return { state: "rate_limited", retryAfterMs: parseRetryAfter(raw.headers.get("retry-after")) };
  }
  if (raw.status >= 500) {
    return { state: "retryable", detail: `feishu http ${raw.status}` };
  }
  const body = raw.body;
  const code = apiCode(raw);
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    return {
      state: "rate_limited",
      retryAfterMs: parseRetryAfter(raw.headers.get("retry-after")),
      detail: `feishu code ${code}`,
    };
  }
  if (CLIENT_ERROR_STATUSES.has(raw.status)) {
    return { state: "permanent", detail: apiResponseDetail(body, raw.status) };
  }
  if (!isRecord(body) || typeof body.code !== "number") {
    return { state: "unknown", detail: "feishu response was malformed" };
  }
  if (body.code === 0) {
    const data = isRecord(body.data) ? body.data : undefined;
    const messageId = data && typeof data.message_id === "string" ? data.message_id : undefined;
    if (raw.status >= 200 && raw.status < 300 && messageId) {
      return { state: "sent", providerMessage: { endpoint, nativeMessageId: messageId } };
    }
    return { state: "unknown", detail: "feishu response was malformed" };
  }
  const msg = typeof body.msg === "string" ? body.msg : "";
  return { state: "permanent", detail: msg ? `feishu code ${body.code}: ${msg}` : `feishu code ${body.code}` };
}

function postMessage(config: FeishuConfig, token: string, body: string): Promise<RawResponse> {
  return fetchJson(
    `${config.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
    },
    config.timeoutMs,
  );
}

async function sendMessage(
  config: FeishuConfig,
  state: AdapterState,
  params: SendParams,
): Promise<SendReceipt> {
  const target = params.target;
  const chatId = target && typeof target.roomId === "string" && target.roomId
    ? target.roomId
    : target && typeof target.room === "string"
      ? target.room
      : undefined;
  if (!chatId) return { state: "permanent", detail: "send target requires a room" };
  const text = isRecord(params.payload) && typeof params.payload.text === "string"
    ? params.payload.text
    : undefined;
  if (text === undefined) return { state: "permanent", detail: "send payload.text must be a string" };
  if (typeof params.idempotencyKey !== "string" || params.idempotencyKey.length === 0) {
    return { state: "permanent", detail: "send requires an idempotency key" };
  }

  const endpoint = target as unknown as Endpoint;
  // A Feishu interactive card renders Markdown; msg_type "text" would show it literally.
  const card = {
    config: { wide_screen_mode: true },
    elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
  };
  const body = JSON.stringify({
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify(card),
    uuid: deterministicUuid(params.idempotencyKey),
  });

  let token: string;
  let raw: RawResponse;
  try {
    token = await ensureToken(config, state);
    raw = await postMessage(config, token, body);
  } catch (error) {
    return failureReceipt(error);
  }

  if (raw.status !== 429 && raw.status < 500 && apiCode(raw) === TOKEN_INVALID_CODE) {
    try {
      token = await ensureToken(config, state, true);
      raw = await postMessage(config, token, body);
    } catch (error) {
      return failureReceipt(error);
    }
    // A token that is still rejected after a forced refresh will not fix itself.
    if (isApiFailure(raw) && apiCode(raw) === TOKEN_INVALID_CODE) {
      return { state: "permanent", detail: `feishu code ${TOKEN_INVALID_CODE}` };
    }
  }
  return mapSendResponse(raw, endpoint);
}

function startupFailureDetail(error: unknown): string {
  if (error instanceof FeishuTimeoutError) return error.message;
  if (error instanceof FeishuApiError) return error.message;
  if (error instanceof Error && error.message === "feishu token response was malformed") return error.message;
  const code = errorCode(error);
  return code ? `feishu token request failed (${code})` : "feishu token request failed";
}

async function handleRequest(message: Record<string, unknown>, state: AdapterState): Promise<void> {
  const rawId = message.id;
  if (rawId === undefined) {
    const failure = message.error as { message?: string } | undefined;
    if (failure) logLine(state.accountId, `request failed: ${failure.message ?? "error"}`);
    return;
  }
  if (typeof rawId !== "string" && typeof rawId !== "number") {
    logLine(state.accountId, "request id must be a string or number");
    return;
  }
  const id = rawId;
  const method = message.method;
  if (typeof method !== "string") return;

  if (method === "initialize") {
    const config = configFromEnv(process.env);
    if ("error" in config) {
      await writeFrame(process.stdout, rpcError(id, RPC_INTERNAL_ERROR, config.error));
      return;
    }
    state.config = config;
    await writeFrame(
      process.stdout,
      rpcResult(id, {
        version: PROTOCOL_VERSION,
        eventSchema: EVENT_SCHEMA_VERSION,
        maxFrameBytes: MAX_FRAME_BYTES,
        accounts: {
          [state.accountId]: {
            send: { text: true, format: ["text", "markdown"], reply: "none", idempotency: "persistent_delivery_key" },
          },
        },
      }),
    );
    return;
  }

  if (method === "start") {
    if (!state.config) {
      await writeFrame(
        process.stdout,
        rpcError(id, RPC_INTERNAL_ERROR, "feishu adapter requires FEISHU_APP_ID and FEISHU_APP_SECRET"),
      );
      return;
    }
    try {
      await ensureToken(state.config, state);
    } catch (error) {
      const detail = startupFailureDetail(error);
      logLine(state.accountId, `token validation failed: ${detail}`);
      await writeFrame(process.stdout, rpcError(id, RPC_INTERNAL_ERROR, detail));
      return;
    }
    state.started = true;
    await writeFrame(process.stdout, rpcResult(id, { ready: true }));
    logLine(state.accountId, "ready (tenant token validated)");
    return;
  }

  if (method === "send") {
    if (!state.started || !state.config) {
      await writeFrame(
        process.stdout,
        rpcResult(id, { state: "unknown", detail: "adapter is not started" } satisfies SendReceipt),
      );
      return;
    }
    const receipt = await sendMessage(state.config, state, (message.params ?? {}) as SendParams);
    if (receipt.state === "sent" && receipt.providerMessage) {
      logLine(state.accountId, `send succeeded native=${receipt.providerMessage.nativeMessageId}`);
    } else {
      logLine(state.accountId, `send ${receipt.state}${receipt.detail ? `: ${receipt.detail}` : ""}`);
    }
    await writeFrame(process.stdout, rpcResult(id, receipt));
    return;
  }

  if (method === "ping") {
    await writeFrame(process.stdout, rpcResult(id, { pong: true }));
    return;
  }

  if (method === "shutdown") {
    await writeFrame(process.stdout, rpcResult(id, {}));
    process.exit(0);
  }

  await writeFrame(process.stdout, rpcError(id, RPC_METHOD_NOT_FOUND, `method not found: ${method}`));
}

export function runFeishuAdapter(): Promise<void> {
  const state: AdapterState = {
    accountId: process.env.CHANNELD_ACCOUNT_ID ?? "feishu",
    tokenExpiresAt: 0,
    started: false,
  };
  const read = createFrameReader(
    (message) => {
      void handleRequest(message, state).catch((error: unknown) => {
        logLine(state.accountId, `handler failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    (error) => logLine(state.accountId, `frame error: ${error.message}`),
  );
  process.stdin.on("data", (chunk: Buffer) => read(chunk));
  logLine(state.accountId, "ready on stdio");
  return new Promise((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runFeishuAdapter().catch((error: unknown) => {
    console.error(`feishu adapter failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}