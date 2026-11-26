import type { ChannelConfig, InboundRoute } from "./config.ts";
import type { IngestEvent } from "./protocol.ts";

const MAX_RELAY_TEXT = 4000;

/** Inbound routes that turn one committed external event into a room notification. */
export function matchInboundRoutes(config: ChannelConfig, event: IngestEvent): InboundRoute[] {
  return config.inbound.filter((route) =>
    route.from.platform === event.source.platform
    && route.from.account === event.source.accountId
    && route.from.room === event.source.roomId
    && (route.from.event === undefined || route.from.event === event.kind)
  );
}

/**
 * Room-notification text. The native user id is opaque but stable; the account
 * label shows which Feishu bot and avoids exposing the chat id in room content.
 */
export function inboundRoomText(event: IngestEvent, route: InboundRoute): string | undefined {
  const text = event.content?.text?.trim();
  if (!text) return undefined;
  const actor = event.actor.nativeUserId || "unknown";
  const body = text.length > MAX_RELAY_TEXT ? `${text.slice(0, MAX_RELAY_TEXT)}…` : text;
  return `[Feishu ${route.from.account}] ${actor}: ${body}`;
}