import path from "node:path";
import { pathToFileURL } from "node:url";
import { cardVersionFromEnv, type CardVersion } from "./feishu-card.ts";
import { parseInboundEvent } from "./feishu-inbound.ts";
import { FeishuLiveConnection } from "./feishu-live.ts";
import {
  ensureToken,
  FeishuApiError,
  sendMessage,
  startupFailureDetail,
  type FeishuConfig,
  type SendParams,
  type SendReceipt,
  type TokenState,
} from "./feishu-send.ts";
import { createFrameReader, writeFrame } from "./framing.ts";
import {
  EVENT_SCHEMA_VERSION,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  adapterRequestId,
  rpcError,
  rpcRequest,
  rpcResult,
  type IngestEvent,
} from "./protocol.ts";

export { deterministicUuid } from "./feishu-send.ts";

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_TIMEOUT_MS = 10_000;

interface AdapterState extends TokenState {
  config?: FeishuConfig;
  started: boolean;
  inbound?: FeishuLiveConnection;
  pending: Map<string, (result: { duplicate?: boolean; error?: string }) => void>;
  sequence: number;
}

function logLine(accountId: string, message: string): void {
  console.error(`feishu adapter ${accountId}: ${message}`);
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
  let cardVersion: CardVersion;
  try {
    cardVersion = cardVersionFromEnv(env.FEISHU_CARD_VERSION);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const inbound = env.FEISHU_INBOUND === "1";
  const inboundChats = new Set(
    (env.FEISHU_INBOUND_CHATS ?? "").split(/[,\s]+/).map((item) => item.trim()).filter(Boolean),
  );
  if (inbound && inboundChats.size === 0) {
    return {
      error: "FEISHU_INBOUND=1 requires FEISHU_INBOUND_CHATS (comma-separated group chat ids)",
    };
  }
  return { appId, appSecret, baseUrl, timeoutMs, cardVersion, inbound, inboundChats };
}


const INGEST_TIMEOUT_MS = 5000;

/** Emit one ingest request and wait for the host commit; false means no ack. */
function emitIngest(state: AdapterState, event: IngestEvent): Promise<boolean> {
  const id = adapterRequestId(++state.sequence);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      logLine(state.accountId, "inbound ingest timed out");
      resolve(false);
    }, INGEST_TIMEOUT_MS);
    state.pending.set(id, (result) => {
      clearTimeout(timer);
      if (result.error) logLine(state.accountId, `inbound ingest failed: ${result.error}`);
      resolve(!result.error);
    });
    void writeFrame(process.stdout, rpcRequest(id, "ingest", event)).catch(() => {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve(false);
    });
  });
}

async function startInbound(config: FeishuConfig, state: AdapterState): Promise<void> {
  const live = new FeishuLiveConnection({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    log: (message) => logLine(state.accountId, message),
    onEvent: async (payload) => {
      const parsed = parseInboundEvent(payload, {
        accountId: state.accountId,
        appId: config.appId,
        chats: config.inboundChats,
      });
      if (!parsed.event) {
        if (parsed.ignored) logLine(state.accountId, `inbound ignored: ${parsed.ignored}`);
        return true;
      }
      return emitIngest(state, parsed.event);
    },
  });
  await live.start();
  state.inbound = live;
  await notifyInbound(state, "ready");
}

/** Report inbound health without blocking the adapter's outbound path. */
async function notifyInbound(state: AdapterState, inbound: "ready" | "failed", detail?: string): Promise<void> {
  const id = adapterRequestId(++state.sequence);
  const params = detail === undefined ? { inbound } : { inbound, detail };
  try {
    await writeFrame(process.stdout, rpcRequest(id, "status", params));
  } catch {
    // A status frame must never fail the adapter.
  }
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
  if (typeof method !== "string") {
    // Response to an adapter-initiated ingest request.
    const resolver = state.pending.get(String(id));
    if (resolver) {
      state.pending.delete(String(id));
      const failure = message.error as { message?: string } | undefined;
      resolver(failure ? { error: failure.message ?? "host ingest failed" } : {});
    }
    return;
  }

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
            send: {
              text: true,
              format: ["text", "markdown"],
              reply: "native",
              idempotency: "persistent_delivery_key",
              card: ["1.0", "2.0"],
            },
            ...(config.inbound ? { ingress: "durable_outbox" } : {}),
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
    if (state.config.inbound) {
      try {
        await startInbound(state.config, state);
      } catch (error) {
        // Inbound is opt-in but must never take the working outbound path down.
        const detail = error instanceof FeishuApiError
          ? startupFailureDetail(error)
          : error instanceof Error ? error.message : String(error);
        const hint = `${detail} (requires long-connection event subscription for im.message.receive_v1 and the bot in an allowlisted group)`;
        logLine(state.accountId, `inbound disabled; outbound stays active: ${hint}`);
        await notifyInbound(state, "failed", detail);
      }
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
    await state.inbound?.stop();
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
    pending: new Map(),
    sequence: 0,
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
  const finish = (): void => {
    void state.inbound?.stop();
  };
  process.stdin.once("end", finish);
  process.stdin.once("close", finish);
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