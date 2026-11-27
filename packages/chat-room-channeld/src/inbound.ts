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
 * label shows which external bot and avoids exposing the chat id in room content.
 */
export function platformLabel(platform: string): string {
  const value = platform.trim();
  return value ? value[0]!.toUpperCase() + value.slice(1) : "Channel";
}

export function inboundRoomText(event: IngestEvent, route: InboundRoute): string | undefined {
  const text = event.content?.text?.trim();
  const attachments = event.content?.attachments ?? [];
  if (!text && attachments.length === 0) return undefined;
  const actor = event.actor.nativeUserId || "unknown";
  const messageID = event.message?.nativeMessageId ?? event.providerEventId ?? "unknown";
  const names = attachments.map((attachment) =>
    attachment.kind === "image" ? "[image]" : `[file ${attachment.name}]`).join(", ");
  const body = text ? (text.length > MAX_RELAY_TEXT ? `${text.slice(0, MAX_RELAY_TEXT)}…` : text) : names;
  return `[${platformLabel(event.source.platform)} ${route.from.account}] message_id=${messageID} chat_id=${event.source.roomId} sender=${actor}: ${body}`;
}