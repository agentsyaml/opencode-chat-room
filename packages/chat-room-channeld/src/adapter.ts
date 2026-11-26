import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AccountConfig } from "./config.ts";
import { AdapterGoneError, createFrameReader, writeFrame } from "./framing.ts";
import { log } from "./log.ts";
import {
  EVENT_SCHEMA_VERSION,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  hostRequestId,
  rpcError,
  rpcRequest,
  rpcResult,
  type Endpoint,
  type IngestEvent,
  type JsonRpcId,
  type MessageRef,
} from "./protocol.ts";

export type SendState = "sent" | "retryable" | "rate_limited" | "permanent" | "unsupported" | "unknown";

export interface SendReceipt {
  state: SendState;
  providerMessage?: MessageRef;
  retryAfterMs?: number;
  detail?: string;
}

export interface AdapterContext {
  onIngest(event: IngestEvent): Promise<{ duplicate: boolean; eventId?: string }>;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onUnavailable?(reason: string): void;
  /** Optional adapter health, e.g. inbound long-connection readiness. */
  onStatus?(status: { inbound?: string; detail?: string }): void;
}

export interface AdapterProcessOptions extends AdapterContext {
  account: AccountConfig;
  initializeTimeoutMs?: number;
  sendTimeoutMs?: number;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const SEND_STATES: readonly SendState[] = [
  "sent",
  "retryable",
  "rate_limited",
  "permanent",
  "unsupported",
  "unknown",
];

const STDERR_TAIL_LIMIT = 4096;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;

export class AdapterProcess {
  readonly #account: AccountConfig;
  readonly #onIngest: AdapterContext["onIngest"];
  readonly #onExit: AdapterContext["onExit"];
  readonly #onUnavailable: AdapterContext["onUnavailable"];
  readonly #onStatus: AdapterContext["onStatus"];
  readonly #initializeTimeoutMs: number;
  readonly #sendTimeoutMs: number;
  readonly #pending = new Map<string, PendingCall>();
  readonly #stderrDecoder = new StringDecoder("utf8");
  #child?: ChildProcessWithoutNullStreams;
  #sequence = 0;
  #stderrTail = "";
  #started = false;
  #stopping = false;
  #gone = false;
  #pollutionError?: Error;

  constructor(options: AdapterProcessOptions) {
    this.#account = options.account;
    this.#onIngest = options.onIngest;
    this.#onExit = options.onExit;
    this.#onUnavailable = options.onUnavailable;
    this.#onStatus = options.onStatus;
    this.#initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.#sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  }

  get accountId(): string {
    return this.#account.id;
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error(`adapter ${this.#account.id} already started`);
    const [command, ...args] = this.#account.adapter.command;
    if (!command) throw new Error(`adapter ${this.#account.id} has an empty command`);
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.#account.env,
        // Forced after account env: config validation also rejects these keys.
        CHANNELD_ACCOUNT_ID: this.#account.id,
        CHANNELD_PLATFORM: this.#account.platform,
      },
    });
    this.#child = child;
    this.#attach(child);

    try {
      const initialized = await this.#call(
        "initialize",
        {
          protocolVersions: [PROTOCOL_VERSION],
          eventSchemas: [EVENT_SCHEMA_VERSION],
          sessionEpoch: `${Date.now().toString(36)}-${process.pid}`,
          platform: this.#account.platform,
          accounts: [this.#account.id],
          maxFrameBytes: MAX_FRAME_BYTES,
        },
        this.#initializeTimeoutMs,
      );
      this.#assertReportedPlatform("initialize", initialized);
      const started = await this.#call(
        "start",
        { accounts: [this.#account.id], cursors: {} },
        this.#initializeTimeoutMs,
      );
      this.#assertReportedPlatform("start", started);
    } catch (error) {
      const tail = this.#stderrTail.trim();
      const message = this.#pollutionError?.message
        ?? (error instanceof Error ? error.message : String(error));
      this.#stopping = true;
      this.#killNow();
      throw new Error(
        `adapter ${this.#account.id} failed to start: ${message}${tail ? `\nstderr:\n${tail}` : ""}`,
      );
    }

    this.#started = true;
    log.info("adapter started", { account: this.#account.id });
  }

  /**
   * Send one delivery. Platform outcomes are returned; protocol failures and
   * timeouts become state "unknown" and never throw.
   */
  async send(
    deliveryId: string,
    attemptId: string,
    idempotencyKey: string,
    target: Endpoint,
    payload: unknown,
  ): Promise<SendReceipt> {
    if (!this.#started || !this.#child) {
      return { state: "unknown", detail: "adapter is not running" };
    }
    try {
      const result = await this.#call(
        "send",
        { deliveryId, attemptId, idempotencyKey, target, payload },
        this.#sendTimeoutMs,
      );
      const raw = (result ?? {}) as Partial<SendReceipt>;
      if (!raw.state || !SEND_STATES.includes(raw.state)) {
        return { state: "unknown", detail: `adapter returned invalid state: ${String(raw.state)}` };
      }
      return {
        state: raw.state,
        providerMessage: raw.providerMessage,
        retryAfterMs: raw.retryAfterMs,
        detail: raw.detail,
      };
    } catch (error) {
      return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#started = false;
    const child = this.#child;
    this.#rejectPending(new AdapterGoneError(`adapter ${this.#account.id} stopped`));
    if (!child) {
      this.#cleanup();
      return;
    }
    try {
      try {
        await this.#call("shutdown", {}, 1000);
      } catch {
        // Shutdown is best effort; the exit escalation below is authoritative.
      }
      try {
        child.stdin.end();
      } catch {
        // stdin may already be closed.
      }
      if (await this.#waitForExit(2000)) return;
      child.kill("SIGTERM");
      if (await this.#waitForExit(1000)) return;
      child.kill("SIGKILL");
      await this.#waitForExit(1000);
    } catch (error) {
      try {
        log.warn(
          `adapter stop failed: ${error instanceof Error ? error.message : String(error)}`,
          { account: this.#account.id },
        );
      } catch {
        // Stop must never throw.
      }
    } finally {
      this.#cleanup();
    }
  }

  /** A result may declare its platform; a mismatch makes this account unusable. */
  #assertReportedPlatform(method: string, result: unknown): void {
    if (!result || typeof result !== "object") return;
    const reported = (result as { platform?: unknown }).platform;
    if (reported === undefined) return;
    if (typeof reported !== "string" || !reported.trim()) {
      throw new Error(`${method} returned an invalid platform`);
    }
    if (reported !== this.#account.platform) {
      throw new Error(
        `${method} reported platform "${reported}" but account ${this.#account.id} is configured for "${this.#account.platform}"`,
      );
    }
  }

  #attach(child: ChildProcessWithoutNullStreams): void {
    child.stdin.on("error", (error: Error) => this.#handleStdioError("stdin", error));
    child.stdout.on("error", (error: Error) => this.#handleStdioError("stdout", error));
    child.stderr.on("error", (error: Error) => this.#handleStdioError("stderr", error));

    const read = createFrameReader(
      (message) => {
        // Never await dispatch here: an ingest buffered behind a send must not
        // block the send result frame that follows it in the same chunk.
        void this.#dispatch(message).catch((error: unknown) => {
          this.#markGone(
            `adapter ${this.#account.id} dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
      (error) => this.#handleStdoutPollution(error),
    );
    child.stdout.on("data", (chunk: Buffer) => read(chunk));

    child.stderr.on("data", (chunk: Buffer) => {
      const text = this.#stderrDecoder.write(chunk);
      this.#stderrTail = `${this.#stderrTail}${text}`.slice(-STDERR_TAIL_LIMIT);
      for (const line of text.split("\n")) {
        if (line.trim()) log.info(line, { account: this.#account.id });
      }
    });

    child.on("error", (error) => {
      this.#markGone(`adapter process error: ${error.message}`);
    });

    child.once("exit", (code, signal) => {
      this.#detachStreams(child);
      this.#child = undefined;
      this.#rejectPending(new Error(`adapter exited (code=${code} signal=${signal})`));
      if (!this.#stopping && !this.#gone && this.#started) {
        log.error(`adapter exited code=${code ?? "null"} signal=${signal ?? "none"}`, {
          account: this.#account.id,
        });
        this.#onExit(code, signal);
      }
      this.#started = false;
    });
  }

  #handleStdioError(streamName: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#markGone(`adapter ${this.#account.id} ${streamName} error: ${message}`);
  }

  async #dispatch(message: Record<string, unknown>): Promise<void> {
    const id = message.id as JsonRpcId | undefined;
    if (id !== undefined && typeof message.method === "string") {
      await this.#handleRequest(id, message.method, message.params);
      return;
    }
    if (id === undefined) {
      log.warn("adapter frame has no id", { account: this.#account.id });
      return;
    }
    const pending = this.#pending.get(String(id));
    if (!pending) {
      log.warn(`adapter response for unknown id ${String(id)}`, { account: this.#account.id });
      return;
    }
    this.#pending.delete(String(id));
    clearTimeout(pending.timer);
    const rpcFailure = message.error as { message?: string } | undefined;
    if (rpcFailure) {
      pending.reject(new Error(rpcFailure.message ?? "adapter JSON-RPC error"));
      return;
    }
    pending.resolve(message.result);
  }

  async #handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const child = this.#child;
    if (!child) return;
    try {
      if (method === "ingest") {
        const result = await this.#onIngest(params as IngestEvent);
        await writeFrame(
          child.stdin,
          rpcResult(id, result.duplicate ? { duplicate: true } : { committed: true }),
        );
      } else if (method === "status") {
        const input = (params ?? {}) as { inbound?: unknown; detail?: unknown };
        try {
          this.#onStatus?.({
            inbound: typeof input.inbound === "string" ? input.inbound : undefined,
            detail: typeof input.detail === "string" ? input.detail : undefined,
          });
        } catch {
          // Status is advisory; a consumer failure must not break the adapter.
        }
        await writeFrame(child.stdin, rpcResult(id, { ok: true }));
      } else if (method === "ping") {
        await writeFrame(child.stdin, rpcResult(id, { pong: true }));
      } else {
        await writeFrame(
          child.stdin,
          rpcError(id, RPC_METHOD_NOT_FOUND, `method not found: ${method}`),
        );
      }
    } catch (error) {
      if (error instanceof AdapterGoneError) {
        this.#markGone(error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string } | null)?.code;
      if (code !== "ingest_buffer_overflow") {
        try {
          log.error(`adapter request ${method} failed: ${message}`, { account: this.#account.id });
        } catch {
          // Keep the request path alive.
        }
      }
      try {
        await writeFrame(child.stdin, rpcError(id, RPC_INTERNAL_ERROR, message));
      } catch (writeError) {
        if (writeError instanceof AdapterGoneError) this.#markGone(writeError.message);
      }
    }
  }

  #handleStdoutPollution(error: Error): void {
    if (this.#pollutionError) return;
    const message = `adapter ${this.#account.id} wrote non-protocol output to stdout; adapter stdout may contain protocol frames only, logs must go to stderr`;
    this.#pollutionError = new Error(message);
    try {
      log.error(message, { account: this.#account.id });
    } catch {
      // Keep the pollution error path alive if stderr is unavailable.
    }
    this.#markGone(message, false);
  }

  #markGone(reason: string, logReason = true): void {
    if (this.#gone) return;
    this.#gone = true;
    this.#stopping = true;
    this.#started = false;
    if (logReason) {
      try {
        log.warn(reason, { account: this.#account.id });
      } catch {
        // Never throw from an adapter-gone path.
      }
    }
    try {
      this.#onUnavailable?.(reason);
    } catch (error) {
      try {
        log.error(
          `adapter unavailable handler failed: ${error instanceof Error ? error.message : String(error)}`,
          { account: this.#account.id },
        );
      } catch {
        // Ignore logging failures.
      }
    }
    this.#rejectPending(new AdapterGoneError(reason));
    try {
      this.#child?.kill("SIGKILL");
    } catch {
      // The child may already be gone.
    }
  }

  #call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.#gone) {
        reject(new AdapterGoneError(`adapter ${this.#account.id} is gone`));
        return;
      }
      if (this.#pollutionError) {
        reject(this.#pollutionError);
        return;
      }
      const child = this.#child;
      if (!child || child.stdin.destroyed || child.stdin.writableEnded) {
        const error = new AdapterGoneError(`adapter ${this.#account.id} is not running`);
        reject(error);
        if (!this.#stopping) this.#markGone(error.message);
        return;
      }
      const id = hostRequestId(++this.#sequence);
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });

      const failedWrite = (error: unknown): void => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
        if (error instanceof AdapterGoneError && !this.#stopping) this.#markGone(error.message);
      };
      try {
        void writeFrame(child.stdin, rpcRequest(id, method, params)).catch(failedWrite);
      } catch (error) {
        failedWrite(error);
      }
    });
  }

  #waitForExit(ms: number): Promise<boolean> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, ms);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #detachStreams(child: ChildProcessWithoutNullStreams): void {
    for (const stream of [child.stdin, child.stdout, child.stderr] as NodeJS.EventEmitter[]) {
      stream.removeAllListeners();
      // Late pipe errors must never become an unhandled 'error' event.
      stream.on("error", () => {});
    }
    child.removeAllListeners();
    child.on("error", () => {});
  }

  #killNow(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#started = false;
    this.#rejectPending(new Error("adapter failed to start"));
    if (child) {
      this.#detachStreams(child);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  #cleanup(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#started = false;
    this.#rejectPending(new Error("adapter stopped"));
    if (!child) return;
    this.#detachStreams(child);
  }
}