import { decodeFrame, encodeFrame, headerValue, jsonPayload, type WsFrame } from "./feishu-ws-frames.ts";

const DEFAULT_PING_MS = 120_000;
const DEFAULT_RECONNECT_MS = 120_000;
const DEFAULT_NONCE_MS = 30_000;
const FRAGMENT_TTL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

export interface LiveSocket {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

type SocketCtor = new (url: string) => LiveSocket;

interface Discovered {
  url: string;
  serviceId: number;
  pingMs: number;
  reconnectMs: number;
  reconnectNonceMs: number;
}

interface Fragment {
  parts: Array<Uint8Array | undefined>;
  received: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface LiveConnectionOptions {
  appId: string;
  appSecret: string;
  baseUrl: string;
  timeoutMs: number;
  /** Test seam: defaults to the platform WebSocket constructor. */
  socketFactory?: (url: string) => LiveSocket;
  /** Complete JSON event payloads; return false to make Feishu retry. */
  onEvent(payload: string): Promise<boolean>;
  log(message: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function discovery(options: LiveConnectionOptions): Promise<Discovered> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let raw: { status: number; body: unknown };
  try {
    const response = await fetch(`${options.baseUrl}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", locale: "zh" },
      body: JSON.stringify({ AppID: options.appId, AppSecret: options.appSecret }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    raw = { status: response.status, body };
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    const detail = typeof code === "string" ? ` (${code})` : "";
    throw new Error(`feishu long connection discovery failed${detail}`);
  } finally {
    clearTimeout(timer);
  }
  if (!isRecord(raw.body) || typeof raw.body.code !== "number") {
    throw new Error(`feishu long connection discovery failed: http ${raw.status}`);
  }
  if (raw.body.code !== 0) {
    const msg = typeof raw.body.msg === "string" && raw.body.msg ? `: ${raw.body.msg}` : "";
    throw new Error(`feishu long connection unavailable: code ${raw.body.code}${msg}`);
  }
  const data = isRecord(raw.body.data) ? raw.body.data : undefined;
  const url = data && typeof data.URL === "string" ? data.URL : "";
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    throw new Error("feishu long connection discovery returned no WebSocket URL");
  }
  const parsed = new URL(url);
  const serviceId = Number(parsed.searchParams.get("service_id"));
  if (!Number.isInteger(serviceId)) {
    throw new Error("feishu long connection URL is missing service_id");
  }
  const config = data && isRecord(data.ClientConfig) ? data.ClientConfig : {};
  const seconds = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : fallback;
  return {
    url,
    serviceId,
    pingMs: seconds(config.PingInterval, DEFAULT_PING_MS),
    reconnectMs: seconds(config.ReconnectInterval, DEFAULT_RECONNECT_MS),
    reconnectNonceMs: seconds(config.ReconnectNonce, DEFAULT_NONCE_MS),
  };
}

/**
 * Feishu event long connection: endpoint discovery, pbbp2 frames, ping/pong,
 * fragment reassembly, acknowledgement after the host commits, and reconnect.
 */
export class FeishuLiveConnection {
  readonly #options: LiveConnectionOptions;
  readonly #fragments = new Map<string, Fragment>();
  #socket?: LiveSocket;
  #discovered?: Discovered;
  #pingTimer?: ReturnType<typeof setTimeout>;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #stopped = false;
  #connecting = false;
  #attempts = 0;

  constructor(options: LiveConnectionOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    this.#discovered = await discovery(this.#options);
    await this.#connect();
    this.#options.log(`inbound long connection ready service=${this.#discovered.serviceId}`);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pingTimer) clearTimeout(this.#pingTimer);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#pingTimer = undefined;
    this.#reconnectTimer = undefined;
    for (const fragment of this.#fragments.values()) clearTimeout(fragment.timer);
    this.#fragments.clear();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Socket may already be closed.
      }
    }
  }

  #connect(): Promise<void> {
    const factory = this.#options.socketFactory;
    const Ctor = factory
      ? undefined
      : (globalThis as { WebSocket?: SocketCtor }).WebSocket;
    if (!factory && !Ctor) {
      return Promise.reject(new Error("feishu long connection requires a WebSocket client"));
    }
    const discovered = this.#discovered;
    if (!discovered) return Promise.reject(new Error("feishu long connection is not discovered"));
    const create = factory ?? ((url: string) => new Ctor!(url));
    return new Promise((resolve, reject) => {
      const socket = create(discovered.url);
      socket.binaryType = "arraybuffer";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // Ignore close failures on a dead handshake.
        }
        reject(new Error("feishu long connection timed out"));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#stopped) {
          try {
            socket.close();
          } catch {
            // Ignore close failures after stop.
          }
          reject(new Error("feishu long connection stopped"));
          return;
        }
        this.#attempts = 0;
        this.#socket = socket;
        this.#attach(socket);
        this.#ping();
        resolve();
      });
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("feishu long connection failed"));
      });
      socket.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("feishu long connection closed during handshake"));
      });
    });
  }

  #attach(socket: LiveSocket): void {
    socket.addEventListener("message", (event: { data?: unknown }) => {
      void this.#onSocketMessage(event.data).catch((error: unknown) => {
        this.#options.log(`inbound frame failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    socket.addEventListener("error", () => {
      this.#options.log("inbound socket error");
    });
    socket.addEventListener("close", () => {
      // A late close from a socket replaced by a reconnect must not clear the
      // current connection's ping timer or schedule a duplicate reconnect.
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (this.#pingTimer) clearTimeout(this.#pingTimer);
      this.#pingTimer = undefined;
      this.#scheduleReconnect();
    });
  }

  async #onSocketMessage(data: unknown): Promise<void> {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof Blob !== "undefined" && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else return;

    const frame = decodeFrame(bytes);
    if (frame.method === 0) {
      this.#onControl(frame);
      return;
    }
    if (frame.method !== 1) return;
    const type = headerValue(frame, "type");
    if (type !== "event") return;
    const payload = this.#assemble(frame);
    if (!payload) return;
    const text = new TextDecoder().decode(payload);
    let ok = false;
    try {
      ok = await this.#options.onEvent(text);
    } catch {
      ok = false;
    }
    this.#ack(frame, ok ? 200 : 500);
  }

  #onControl(frame: WsFrame): void {
    if (headerValue(frame, "type") !== "pong" || !frame.payload) return;
    try {
      const pong = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
      const next = this.#discovered;
      if (!next) return;
      if (typeof pong.PingInterval === "number" && pong.PingInterval > 0) next.pingMs = pong.PingInterval * 1000;
      if (typeof pong.ReconnectInterval === "number" && pong.ReconnectInterval > 0) {
        next.reconnectMs = pong.ReconnectInterval * 1000;
      }
      if (typeof pong.ReconnectNonce === "number" && pong.ReconnectNonce > 0) {
        next.reconnectNonceMs = pong.ReconnectNonce * 1000;
      }
    } catch {
      // A malformed pong only means the old intervals stay in effect.
    }
  }

  #assemble(frame: WsFrame): Uint8Array | undefined {
    const id = headerValue(frame, "message_id");
    const total = Number(headerValue(frame, "sum") ?? "1");
    const seq = Number(headerValue(frame, "seq") ?? "0");
    if (!id || !frame.payload || !Number.isInteger(total) || total <= 1) return frame.payload;
    if (!Number.isInteger(seq) || seq < 0 || seq >= total) return undefined;
    const current = this.#fragments.get(id) ?? {
      parts: Array.from({ length: total }),
      received: 0,
      timer: setTimeout(() => this.#fragments.delete(id), FRAGMENT_TTL_MS),
    };
    if (current.parts.length !== total) return undefined;
    if (!current.parts[seq]) {
      current.parts[seq] = frame.payload;
      current.received += 1;
    }
    this.#fragments.set(id, current);
    if (current.received < total) return undefined;
    clearTimeout(current.timer);
    this.#fragments.delete(id);
    return Uint8Array.from(current.parts.flatMap((part) => [...(part ?? [])]));
  }

  #ack(frame: WsFrame, code: number): void {
    const socket = this.#socket;
    if (!socket) return;
    const ack: WsFrame = {
      ...frame,
      headers: [...(frame.headers ?? []), { key: "biz_rt", value: "0" }],
      payload: jsonPayload({ code }),
    };
    try {
      socket.send(encodeFrame(ack));
    } catch {
      this.#options.log("inbound ack failed");
    }
  }

  #ping(): void {
    if (this.#stopped || !this.#discovered) return;
    const socket = this.#socket;
    if (!socket) return;
    try {
      socket.send(encodeFrame({
        SeqID: 0,
        LogID: 0,
        service: this.#discovered.serviceId,
        method: 0,
        headers: [{ key: "type", value: "ping" }],
      }));
    } catch {
      this.#options.log("inbound ping failed");
    }
    this.#pingTimer = setTimeout(() => this.#ping(), this.#discovered.pingMs);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#connecting) return;
    this.#connecting = true;
    const next = this.#discovered;
    const delay = (next?.reconnectNonceMs ?? DEFAULT_NONCE_MS) * Math.random()
      + (next?.reconnectMs ?? DEFAULT_RECONNECT_MS);
    this.#options.log(`inbound reconnecting in ${Math.round(delay)}ms`);
    this.#reconnectTimer = setTimeout(() => {
      void this.#reconnect();
    }, delay);
  }

  async #reconnect(): Promise<void> {
    this.#connecting = false;
    if (this.#stopped) return;
    this.#attempts += 1;
    try {
      this.#discovered = await discovery(this.#options);
      if (this.#stopped) return;
      await this.#connect();
      this.#options.log(`inbound reconnected attempt=${this.#attempts}`);
    } catch (error) {
      this.#options.log(`inbound reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
      this.#scheduleReconnect();
    }
  }
}