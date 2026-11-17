import os from "node:os";

/** Resolved connection and delivery settings for the plugin. */
export interface RoomConfig {
  /** Central server origin, without a trailing slash. */
  url: string;
  /** Shared bearer token; empty when the server runs open. */
  token: string;
  /** Participant name used when creating or joining a room. */
  participant: string;
  /** Minimum gap between background inbox checks per agent. */
  deliveryIntervalMs: number;
  /** Per-request budget, including the inbox long-poll. */
  requestTimeoutMs: number;
}

/** Raw cordis configuration; every field falls back to an environment value or default. */
export type RoomConfigInput = Partial<RoomConfig>;

const DEFAULT_URL = "http://127.0.0.1:4399";

function positive(value: unknown, fallback: number, name: string, minimum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`dsh-chat-room: ${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

/** Validate configuration once at load so a bad url or interval fails loudly. */
export function resolveConfig(input: RoomConfigInput = {}): RoomConfig {
  const url = String(input.url ?? process.env.CHAT_ROOM_SERVER_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(url)) throw new TypeError("dsh-chat-room: url must be an http(s) origin");
  const token = String(input.token ?? process.env.CHAT_ROOM_SERVER_TOKEN ?? "");
  const participant = String(input.participant ?? os.userInfo().username).trim().slice(0, 64);
  if (!participant) throw new TypeError("dsh-chat-room: participant must not be empty");
  return {
    url,
    token,
    participant,
    deliveryIntervalMs: positive(input.deliveryIntervalMs, 5000, "deliveryIntervalMs", 1000),
    requestTimeoutMs: positive(input.requestTimeoutMs, 15000, "requestTimeoutMs", 1000),
  };
}