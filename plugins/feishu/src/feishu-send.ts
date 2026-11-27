import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CardVersion } from "./feishu-card.ts";
import { buildCard } from "./feishu-card.ts";
import type { AttachmentRef, Endpoint } from "../../../packages/chat-room-channeld/src/protocol.ts";

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_MS = 1000;
const TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;
const FALLBACK_TOKEN_TTL_SECONDS = 7200;
const TOKEN_INVALID_CODE = 99991663;
const RATE_LIMIT_CODES = new Set([230020, 99991400]);

export type SendState = "sent" | "retryable" | "rate_limited" | "permanent" | "unsupported" | "unknown";

export interface SendReceipt {
  state: SendState;
  providerMessage?: { endpoint: Endpoint; nativeMessageId: string };
  retryAfterMs?: number;
  detail?: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  timeoutMs: number;
  cardVersion: CardVersion;
  inbound: boolean;
  inboundChats: ReadonlySet<string>;
}

interface SendTarget {
  roomId?: unknown;
  room?: unknown;
}

export interface SendParams {
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

export class FeishuApiError extends Error {
  readonly code: number;
  readonly msg: string;
  readonly scope: "token" | "send";

  constructor(code: number, msg: string, scope: "token" | "send") {
    super(`feishu ${scope} code ${code}: ${msg}`);
    this.name = "FeishuApiError";
    this.code = code;
    this.msg = msg;
    this.scope = scope;
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

export async function ensureToken(config: FeishuConfig, state: TokenState, force = false): Promise<string> {
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
// Feishu platform limits; declared to the host as adapter capabilities.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const RESOURCE_MARKER = /\s*\[\[resource:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]\]\s*/gi;

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

/** A Feishu parent reference is usable only for this account's own chat. */
function replyParentId(payload: unknown, accountId: string): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.parent)) return undefined;
  const parent = payload.parent;
  if (!isRecord(parent.endpoint)) return undefined;
  if (parent.endpoint.platform !== "feishu") return undefined;
  if (typeof parent.endpoint.accountId === "string" && parent.endpoint.accountId !== accountId) {
    return undefined;
  }
  return typeof parent.nativeMessageId === "string" && parent.nativeMessageId
    ? parent.nativeMessageId
    : undefined;
}

function postMessage(
  config: FeishuConfig,
  token: string,
  body: string,
  replyTo?: string,
): Promise<RawResponse> {
  const pathname = replyTo
    ? `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`
    : "/open-apis/im/v1/messages?receive_id_type=chat_id";
  return fetchJson(
    `${config.baseUrl}${pathname}`,
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

/** One forced token refresh covers both sending and attachment uploads. */
async function withToken(
  config: FeishuConfig,
  state: TokenState,
  request: (token: string) => Promise<RawResponse>,
): Promise<RawResponse> {
  let raw = await request(await ensureToken(config, state));
  if (raw.status !== 429 && raw.status < 500 && apiCode(raw) === TOKEN_INVALID_CODE) {
    raw = await request(await ensureToken(config, state, true));
  }
  return raw;
}

async function sendPart(
  config: FeishuConfig,
  state: TokenState,
  chatId: string,
  endpoint: Endpoint,
  parentId: string | undefined,
  messageType: "interactive" | "image" | "file",
  content: unknown,
  idempotencyKey: string,
): Promise<SendReceipt> {
  const message = {
    msg_type: messageType,
    content: JSON.stringify(content),
    uuid: deterministicUuid(idempotencyKey),
  };
  const body = JSON.stringify(parentId ? message : { receive_id: chatId, ...message });
  try {
    const raw = await withToken(config, state, (token) => postMessage(config, token, body, parentId));
    // A token that is still rejected after a forced refresh will not fix itself.
    if (isApiFailure(raw) && apiCode(raw) === TOKEN_INVALID_CODE) {
      return { state: "permanent", detail: `feishu code ${TOKEN_INVALID_CODE}` };
    }
    return mapSendResponse(raw, endpoint);
  } catch (error) {
    return failureReceipt(error);
  }
}

function mapUploadResponse(raw: RawResponse, field: "image_key" | "file_key"): { key?: string; receipt?: SendReceipt } {
  if (raw.status === 429) {
    return { receipt: { state: "rate_limited", retryAfterMs: parseRetryAfter(raw.headers.get("retry-after")) } };
  }
  if (raw.status >= 500) return { receipt: { state: "retryable", detail: `feishu http ${raw.status}` } };
  const code = apiCode(raw);
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    return { receipt: { state: "rate_limited", retryAfterMs: parseRetryAfter(raw.headers.get("retry-after")), detail: `feishu code ${code}` } };
  }
  if (CLIENT_ERROR_STATUSES.has(raw.status)) {
    return { receipt: { state: "permanent", detail: apiResponseDetail(raw.body, raw.status) } };
  }
  if (!isRecord(raw.body) || typeof raw.body.code !== "number") {
    return { receipt: { state: "unknown", detail: "feishu upload response was malformed" } };
  }
  if (raw.body.code !== 0) {
    const msg = typeof raw.body.msg === "string" ? raw.body.msg : "";
    return { receipt: { state: "permanent", detail: msg ? `feishu code ${raw.body.code}: ${msg}` : `feishu code ${raw.body.code}` } };
  }
  const data = isRecord(raw.body.data) ? raw.body.data : undefined;
  const key = data && typeof data[field] === "string" ? data[field] : undefined;
  return key ? { key } : { receipt: { state: "unknown", detail: "feishu upload response was malformed" } };
}

async function uploadAttachment(
  config: FeishuConfig,
  state: TokenState,
  attachment: AttachmentRef,
): Promise<{ key?: string; receipt?: SendReceipt }> {
  if (attachment.error) return { receipt: { state: "permanent", detail: attachment.error } };
  if (!attachment.path) return { receipt: { state: "permanent", detail: `attachment ${attachment.name} has no local file` } };
  const image = attachment.kind === "image";
  const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(attachment.path);
  } catch {
    return { receipt: { state: "permanent", detail: `attachment ${attachment.name} could not be read` } };
  }
  if (bytes.length > limit) {
    return { receipt: { state: "permanent", detail: `attachment ${attachment.name} exceeds ${image ? "10 MiB" : "30 MiB"}` } };
  }
  const form = new FormData();
  if (image) {
    form.set("image_type", "message");
  } else {
    form.set("file_type", "stream");
    form.set("file_name", attachment.name || path.basename(attachment.path));
  }
  form.set(image ? "image" : "file", new Blob([new Uint8Array(bytes)]), attachment.name || path.basename(attachment.path));
  try {
    const raw = await withToken(config, state, (token) => fetchJson(
      `${config.baseUrl}${image ? "/open-apis/im/v1/images" : "/open-apis/im/v1/files"}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form },
      config.timeoutMs,
    ));
    if (isApiFailure(raw) && apiCode(raw) === TOKEN_INVALID_CODE) {
      return { receipt: { state: "permanent", detail: `feishu code ${TOKEN_INVALID_CODE}` } };
    }
    return mapUploadResponse(raw, image ? "image_key" : "file_key");
  } catch (error) {
    return { receipt: failureReceipt(error) };
  }
}

function partialFailure(receipt: SendReceipt, sent: string[]): SendReceipt {
  if (sent.length === 0) return receipt;
  return { ...receipt, detail: `${receipt.detail ?? receipt.state} (already sent: ${sent.join(", ")})` };
}

export async function sendMessage(
  config: FeishuConfig,
  state: TokenState,
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
  const attachments = isRecord(params.payload) && Array.isArray(params.payload.attachments)
    ? params.payload.attachments.filter((item): item is AttachmentRef => isRecord(item) && typeof item.kind === "string" && typeof item.name === "string")
    : [];
  if (text === undefined && attachments.length === 0) {
    return { state: "permanent", detail: "send payload.text must be a string" };
  }
  if (typeof params.idempotencyKey !== "string" || params.idempotencyKey.length === 0) {
    return { state: "permanent", detail: "send requires an idempotency key" };
  }

  const endpoint = target as unknown as Endpoint;
  const parentId = replyParentId(params.payload, state.accountId);
  const key = params.idempotencyKey;
  // Resource markers are rendered natively as attachments below; leaving them
  // in the card would show internal ids to the external room.
  const clean = (text ?? "").replace(RESOURCE_MARKER, " ").trim();
  let receipt: SendReceipt | undefined;
  const sent: string[] = [];
  if (clean || attachments.length === 0) {
    // Card 2.0 renders block Markdown; card 1.0 keeps the 0.8.0 lark_md payload.
    receipt = await sendPart(
      config, state, chatId, endpoint, parentId, "interactive",
      buildCard(config.cardVersion, clean),
      attachments.length ? `${key}:text` : key,
    );
    if (receipt.state !== "sent") return receipt;
    sent.push("text");
  }
  for (const [index, attachment] of attachments.entries()) {
    const uploaded = await uploadAttachment(config, state, attachment);
    if (uploaded.receipt) return partialFailure(uploaded.receipt, sent);
    receipt = await sendPart(
      config, state, chatId, endpoint, parentId,
      attachment.kind === "image" ? "image" : "file",
      attachment.kind === "image" ? { image_key: uploaded.key } : { file_key: uploaded.key },
      `${key}:attachment:${index}`,
    );
    if (receipt.state !== "sent") return partialFailure(receipt, sent);
    sent.push(`attachment ${index + 1}`);
  }
  return receipt ?? { state: "permanent", detail: "send produced no message" };
}

export function startupFailureDetail(error: unknown): string {
  if (error instanceof FeishuTimeoutError) return error.message;
  if (error instanceof FeishuApiError) return error.message;
  if (error instanceof Error && error.message === "feishu token response was malformed") return error.message;
  const code = errorCode(error);
  return code ? `feishu token request failed (${code})` : "feishu token request failed";
}

export interface TokenState {
  accountId: string;
  token?: string;
  tokenExpiresAt: number;
}
