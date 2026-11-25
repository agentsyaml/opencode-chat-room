// Channel D integration: opt-in forwarding from a room message to an external
// IM endpoint through the channeld relay host. The host keeps its own SQLite
// file, so disabling the feature (or deleting channeld.sqlite) is a full rollback.
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ServerSettings } from "../src/config/file-config.ts";
import { databasePath, writeState } from "../src/state/store.ts";
import { openStateDatabase } from "../src/state/sqlite-state.ts";
import {
  parseConfig,
  type ChannelConfig,
  type RuleTarget,
} from "../packages/chat-room-channeld/src/config.ts";
import { createHost, type ChannelHost, type SpawnAdapter } from "../packages/chat-room-channeld/src/host.ts";
import { EVENT_SCHEMA_VERSION, type Endpoint, type IngestEvent } from "../packages/chat-room-channeld/src/protocol.ts";
import { matchRules, targetKey } from "../packages/chat-room-channeld/src/rules.ts";
import {
  isTerminalDeliveryState,
  readChannelStats,
  type DeliveryRow,
  type ReceiptRow,
} from "../packages/chat-room-channeld/src/state.ts";
import { jsonObject } from "./json-body.ts";

export type ChannelsRuntime = {
  host: ChannelHost;
  config: ChannelConfig;
};

export type ChannelDeps = {
  spawnAdapter?: SpawnAdapter;
  deliveryIntervalMs?: number;
};

// The center accepts an optional receipt because an account disabled mid-send
// records a terminal `unknown` without one; the message must not invent one.
export type DeliveryResultCallback = (
  event: IngestEvent | undefined,
  delivery: DeliveryRow,
  receipt: ReceiptRow | undefined,
) => void;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SESSION = 128;
const MAX_REQUEST_ID = 200;

/** Load a channeld YAML config, with the center owning the state file path. */
function loadChannelConfig(file: string, stateFile: string): ChannelConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`channeld config: cannot read ${file}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new Error(`channeld config: ${file} is not valid YAML/JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`channeld config: ${file} must contain a mapping`);
  }
  // Override any YAML stateFile: a stale path must never point at the room database.
  return parseConfig({ ...(raw as Record<string, unknown>), stateFile });
}

function resolveChannelStateFile(stateDir: string, configured: string | undefined): string {
  const file = configured
    ? (path.isAbsolute(configured) ? configured : path.resolve(stateDir, configured))
    : path.join(stateDir, "channeld.sqlite");
  if (path.resolve(file) === path.join(stateDir, "chat-room.sqlite")) {
    throw new Error("chatroom config: server.channeld.stateFile must not be the room database");
  }
  return file;
}

function deliverySystemMessage(delivery: DeliveryRow, receipt: ReceiptRow | undefined): string {
  if (delivery.state === "sent") return `Forwarded to ${delivery.target}`;
  const raw = receipt?.detail || delivery.lastError || receipt?.state || delivery.state;
  // Keep the system row inside the 5000-char message limit even for a huge adapter detail.
  const reason = String(raw).replace(/[\r\n;]+/g, " ").trim().slice(0, 500) || delivery.state;
  return `Forward to ${delivery.target} failed: ${reason}`;
}

/**
 * Build the terminal-delivery publisher. One system message per delivery, and
 * only for a forward event that came from this center.
 */
export function createDeliveryResultHandler(): DeliveryResultCallback {
  const notified = new Set<string>();
  return (event, delivery, receipt) => {
    if (!isTerminalDeliveryState(delivery.state)) return;
    if (notified.has(delivery.deliveryId)) return;
    const source = event?.source;
    if (
      event?.kind !== "message.forward_requested"
      || source?.platform !== "chatroom"
      || source.accountId !== "center"
    ) return;
    notified.add(delivery.deliveryId);
    const text = deliverySystemMessage(delivery, receipt);
    void writeState((svc) => {
      svc.addEvent(source.roomId, text);
    }).catch((error: unknown) => {
      console.warn(`[chat-room] could not write the channeld result message: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}

/**
 * Start the relay host when `server.channeld.enabled` is on. A missing or
 * invalid config fails startup; an adapter start failure only disables channels.
 */
export async function startChannels(
  settings: ServerSettings,
  deps: ChannelDeps = {},
): Promise<ChannelsRuntime | undefined> {
  if (!settings.channeld?.enabled) return undefined;
  const configPath = settings.channeld.config;
  if (!configPath) {
    throw new Error(
      "chatroom config: server.channeld is enabled but no config file is set (server.channeld.config or CHAT_ROOM_CHANNELD_CONFIG)",
    );
  }
  const stateDir = path.dirname(databasePath());
  const stateFile = resolveChannelStateFile(stateDir, settings.channeld.stateFile);
  const config = loadChannelConfig(configPath, stateFile);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const host = createHost(config, {
    spawnAdapter: deps.spawnAdapter,
    deliveryIntervalMs: deps.deliveryIntervalMs,
    onDeliveryResult: createDeliveryResultHandler(),
  });
  try {
    await host.start();
  } catch (error) {
    console.warn(`[chat-room] channeld disabled: ${error instanceof Error ? error.message : String(error)}`);
    // A partially started host may still own adapters or the state file.
    await stopChannels({ host, config });
    return undefined;
  }
  return { host, config };
}

export async function stopChannels(runtime: ChannelsRuntime | undefined): Promise<void> {
  if (!runtime) return;
  try {
    await runtime.host.stop();
  } catch (error) {
    console.warn(`[chat-room] channeld stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseTarget(value: unknown): RuleTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.platform !== "string" || !IDENTIFIER.test(raw.platform)
    || typeof raw.account !== "string" || !IDENTIFIER.test(raw.account)
    || typeof raw.room !== "string" || !IDENTIFIER.test(raw.room)
  ) return undefined;
  return { platform: raw.platform, account: raw.account, room: raw.room };
}

type ForwardableMessage = { text: string; createdAt: number };

/** A malformed percent escape must not become a 500. */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Registry + participant join: a stale registry row after a kick is not a member. */
async function memberName(roomId: string, sessionID: string): Promise<string | undefined> {
  const db = await openStateDatabase(databasePath());
  const row = db.query(
    `SELECT g.name FROM registry g
     JOIN rooms r ON r.id = g.room_id
     JOIN participants p ON p.room_id = g.room_id
       AND p.id = CASE WHEN r.kind = 'direct' THEN g.session_id ELSE g.name END
     WHERE g.room_id = ? AND g.session_id = ?`,
  ).get(roomId, sessionID) as { name: string } | null;
  return row?.name;
}

/** Member + live message check; undefined covers missing, recalled, and non-member. */
async function readForwardableMessage(
  roomId: string,
  messageId: string,
  sessionID: string,
): Promise<ForwardableMessage | undefined> {
  if (!await memberName(roomId, sessionID)) return undefined;
  const db = await openStateDatabase(databasePath());
  const row = db.query("SELECT text, created_at, recalled_at FROM messages WHERE room_id = ? AND id = ?")
    .get(roomId, messageId) as { text: string; created_at: number; recalled_at: number | null } | null;
  if (!row || row.recalled_at !== null) return undefined;
  return { text: row.text, createdAt: Number(row.created_at) };
}

async function isRoomMember(roomId: string, sessionID: string): Promise<boolean> {
  return Boolean(await memberName(roomId, sessionID));
}

/** Targets of rules whose source is this room's forward requests and whose account is ready. */
function forwardTargets(runtime: ChannelsRuntime, roomId: string): RuleTarget[] {
  const probe: IngestEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: "forward-targets",
    kind: "message.forward_requested",
    source: { platform: "chatroom", accountId: "center", roomId },
    actor: { platform: "chatroom", identityNamespace: "session", nativeUserId: "" },
    sourceDedupKey: "forward-targets",
    receivedAt: new Date(0).toISOString(),
  };
  const config = runtime.config;
  const seen = new Set<string>();
  const targets: RuleTarget[] = [];
  for (const rule of matchRules(config, probe)) {
    for (const target of rule.to) {
      if (runtime.host.targetStatus(target.platform, target.account) !== "ready") continue;
      const key = `${target.platform}/${target.account}/${target.room}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
  }
  return targets;
}

/**
 * POST /rooms/:roomId/forward and GET /rooms/:roomId/forward-targets.
 * No runtime means the feature is off: the route stays absent.
 */
export async function channelRoutes(
  req: Request,
  url: URL,
  runtime: ChannelsRuntime | undefined,
): Promise<Response | undefined> {
  if (!runtime) return undefined;

  if (url.pathname === "/channeld/status") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    try {
      return json(readChannelStats(runtime.config.stateFile));
    } catch {
      return json({ error: "channel state unavailable" }, 503);
    }
  }

  const forward = url.pathname.match(/^\/rooms\/([^/]+)\/forward$/);
  if (forward) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const roomId = decodeSegment(forward[1]!);
    if (!roomId) return json({ error: "message not found" }, 404);
    const body = await jsonObject<Record<string, unknown>>(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const sessionID = typeof body.sessionID === "string" ? body.sessionID.trim() : "";
    const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
    if (!sessionID || sessionID.length > MAX_SESSION || !messageId || messageId.length > MAX_SESSION) {
      return json({ error: "sessionID and messageId are required" }, 400);
    }
    const target = parseTarget(body.target);
    if (!target) return json({ error: "target must contain platform, account, and room identifiers" }, 400);
    const requestId = body.requestId === undefined
      ? undefined
      : typeof body.requestId === "string" && body.requestId.trim() && body.requestId.trim().length <= MAX_REQUEST_ID
        ? body.requestId.trim()
        : null;
    if (requestId === null) return json({ error: `requestId must be a non-empty string (max ${MAX_REQUEST_ID})` }, 400);

    const message = await readForwardableMessage(roomId, messageId, sessionID);
    if (!message) return json({ error: "message not found" }, 404);
    if (runtime.host.targetStatus(target.platform, target.account) !== "ready") {
      return json({ error: "forward target is unavailable" }, 409);
    }

    const source: Endpoint = { platform: "chatroom", accountId: "center", roomId };
    const requestedTarget: Endpoint = { platform: target.platform, accountId: target.account, roomId: target.room };
    const event: IngestEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: `fwd-${randomUUID()}`,
      kind: "message.forward_requested",
      source,
      actor: { platform: "chatroom", identityNamespace: "session", nativeUserId: sessionID },
      ...(requestId ? { providerEventId: requestId } : {}),
      // The same message and target always reuse this key, so a retry is one event.
      sourceDedupKey: `forward:${messageId}:${targetKey(requestedTarget)}`,
      selectedMessage: { endpoint: source, nativeMessageId: messageId, text: message.text },
      requestedTarget,
      occurredAt: new Date(message.createdAt).toISOString(),
      receivedAt: new Date().toISOString(),
      content: { text: message.text },
    };
    const result = await runtime.host.ingest(event);
    return json({ eventId: result.eventId ?? event.eventId }, 202);
  }

  const targets = url.pathname.match(/^\/rooms\/([^/]+)\/forward-targets$/);
  if (!targets) return undefined;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const roomId = decodeSegment(targets[1]!);
  if (!roomId) return json({ error: "room not found" }, 404);
  const sessionID = (url.searchParams.get("sessionID") ?? "").trim();
  if (!sessionID || sessionID.length > MAX_SESSION) return json({ error: "sessionID is required" }, 400);
  if (!await isRoomMember(roomId, sessionID)) return json({ error: "room not found" }, 404);
  return json({ targets: forwardTargets(runtime, roomId) });
}