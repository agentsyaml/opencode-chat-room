import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFrameReader, writeFrame } from "./framing.ts";
import {
  EVENT_SCHEMA_VERSION,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RPC_METHOD_NOT_FOUND,
  adapterRequestId,
  rpcError,
  rpcRequest,
  rpcResult,
  type Endpoint,
  type IngestEvent,
} from "./protocol.ts";

interface SendParams {
  attemptId: string;
  target: Endpoint;
}

interface MockOptions {
  accountId: string;
}

async function handleRequest(
  message: Record<string, unknown>,
  options: MockOptions,
  state: { started: boolean; emitted: boolean; sequence: number },
): Promise<void> {
  const rawId = message.id;
  if (rawId === undefined) {
    const failure = message.error as { message?: string } | undefined;
    if (failure) console.error(`mock adapter ${options.accountId}: request failed: ${failure.message ?? "error"}`);
    return;
  }
  if (typeof rawId !== "string" && typeof rawId !== "number") {
    console.error(`mock adapter ${options.accountId}: request id must be a string or number`);
    return;
  }
  const id = rawId;
  const method = message.method;
  if (typeof method !== "string") return;

  if (method === "initialize") {
    const accounts = {
      [options.accountId]: {
        ingress: "durable_outbox",
        ack: "after_host_commit",
        send: { text: true, reply: "none", idempotency: "persistent_delivery_key" },
      },
    };
    await writeFrame(
      process.stdout,
      rpcResult(id, {
        version: PROTOCOL_VERSION,
        eventSchema: EVENT_SCHEMA_VERSION,
        maxFrameBytes: MAX_FRAME_BYTES,
        accounts,
      }),
    );
    return;
  }

  if (method === "start") {
    state.started = true;
    await writeFrame(process.stdout, rpcResult(id, { ready: true }));
    if (process.env.CHANNELD_MOCK_EMIT === "1" && !state.emitted) {
      state.emitted = true;
      setTimeout(() => {
        void emitIngest(options, state);
      }, 50);
    }
    return;
  }

  if (method === "send") {
    const params = (message.params ?? {}) as SendParams;
    const target = params.target;
    const nativeMessageId = `mock-${params.attemptId}`;
    console.error(
      `mock adapter ${options.accountId}: send attempt=${params.attemptId} target=${target?.platform}/${target?.roomId}`,
    );
    const result = rpcResult(id, {
      state: "sent",
      providerMessage: { endpoint: target, nativeMessageId },
    });
    if (process.env.CHANNELD_MOCK_ECHO !== "1" || !target) {
      await writeFrame(process.stdout, result);
      return;
    }
    const echo = rpcRequest(adapterRequestId(++state.sequence), "ingest", {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: `mock-echo-${nativeMessageId}`,
      kind: "message.created",
      source: {
        platform: target.platform,
        accountId: target.accountId,
        roomId: target.roomId,
      },
      actor: { platform: target.platform, identityNamespace: "mock", nativeUserId: "mock-user" },
      providerEventId: nativeMessageId,
      sourceDedupKey: `mock-echo:${target.platform}/${target.accountId}/${target.roomId}:${nativeMessageId}`,
      message: { endpoint: target, nativeMessageId },
      receivedAt: new Date().toISOString(),
      content: { text: "mock echo" },
    } satisfies IngestEvent);
    const delay = Number(process.env.CHANNELD_MOCK_ECHO_DELAY_MS ?? 0);
    if (delay > 0) {
      await writeFrame(process.stdout, echo);
      await new Promise((resolve) => setTimeout(resolve, delay));
      await writeFrame(process.stdout, result);
      return;
    }
    await writeLines([result, echo]);
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

function writeLines(values: unknown[]): Promise<void> {
  const text = `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function emitIngest(
  options: MockOptions,
  state: { started: boolean; sequence: number },
): Promise<void> {
  if (!state.started) return;
  const source: Endpoint = { platform: "mock", accountId: options.accountId, roomId: "in" };
  const event: IngestEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `mock-event-${options.accountId}`,
    kind: "message.created",
    source,
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "mock-user" },
    providerEventId: `mock-provider-${options.accountId}`,
    sourceDedupKey: `mock:${options.accountId}:hello-from-mock`,
    message: { endpoint: source, nativeMessageId: `mock-native-${options.accountId}` },
    receivedAt: new Date().toISOString(),
    content: { text: "hello from mock" },
  };
  try {
    await writeFrame(process.stdout, rpcRequest(adapterRequestId(++state.sequence), "ingest", event));
    console.error(`mock adapter ${options.accountId}: ingest emitted`);
  } catch (error) {
    console.error(
      `mock adapter ${options.accountId}: ingest failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function runMockAdapter(): Promise<void> {
  const options: MockOptions = { accountId: process.env.CHANNELD_ACCOUNT_ID ?? "mock" };
  const state = { started: false, emitted: false, sequence: 0 };
  const read = createFrameReader(
    (message) => {
      void handleRequest(message, options, state).catch((error: unknown) => {
        console.error(
          `mock adapter ${options.accountId}: handler failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    (error) => console.error(`mock adapter ${options.accountId}: frame error: ${error.message}`),
  );
  process.stdin.on("data", (chunk: Buffer) => read(chunk));
  console.error(`mock adapter ${options.accountId}: ready on stdio`);
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
  runMockAdapter().catch((error: unknown) => {
    console.error(`mock adapter failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}