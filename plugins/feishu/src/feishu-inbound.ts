import type { IngestEvent, MessageRef } from "../../../packages/chat-room-channeld/src/protocol.ts";

export interface InboundOptions {
  accountId: string;
  appId: string;
  /** Group chat ids explicitly allowed by the operator. */
  chats: ReadonlySet<string>;
}

export interface ParsedInbound {
  event?: IngestEvent;
  ignored?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function replaceMentions(text: string, mentions: unknown): string {
  if (!Array.isArray(mentions)) return text;
  let next = text;
  for (const item of mentions) {
    if (!isRecord(item)) continue;
    const key = stringValue(item.key);
    const name = stringValue(item.name);
    if (key && name) next = next.split(key).join(`@${name}`);
  }
  return next;
}

function richText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const line of value) {
    if (!Array.isArray(line)) continue;
    for (const item of line) {
      if (!isRecord(item)) continue;
      if (item.tag === "at") {
        const name = stringValue(item.user_name) ?? stringValue(item.user_id);
        if (name) parts.push(`@${name}`);
      } else {
        const text = stringValue(item.text);
        if (text) parts.push(text);
      }
    }
    parts.push("\n");
  }
  return parts.join("").trim() || undefined;
}

function messageText(messageType: string, raw: string, mentions: unknown): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (messageType === "text") {
    const text = stringValue(parsed.text);
    return text ? replaceMentions(text, mentions) : undefined;
  }
  if (messageType === "post") {
    const post = isRecord(parsed.content)
      ? Object.values(parsed.content).find((item) => Array.isArray(item))
      : parsed.content;
    return richText(post);
  }
  return undefined;
}

type ParsedAttachment = { kind: "image" | "file"; name: string; sourceId: string };

/** Files and images carry a provider key instead of text; post images live inline. */
function messageAttachments(messageType: string, raw: string): ParsedAttachment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  if (messageType === "image") {
    const key = stringValue(parsed.image_key);
    return key ? [{ kind: "image", name: "image", sourceId: key }] : [];
  }
  if (messageType === "file") {
    const key = stringValue(parsed.file_key);
    return key ? [{ kind: "file", name: stringValue(parsed.file_name) ?? "file", sourceId: key }] : [];
  }
  if (messageType !== "post") return [];
  const post = isRecord(parsed.content)
    ? Object.values(parsed.content).find((item) => Array.isArray(item))
    : parsed.content;
  if (!Array.isArray(post)) return [];
  const attachments: ParsedAttachment[] = [];
  for (const line of post) {
    if (!Array.isArray(line)) continue;
    for (const item of line) {
      if (!isRecord(item) || item.tag !== "img") continue;
      const key = stringValue(item.image_key);
      if (key) attachments.push({ kind: "image", name: "image", sourceId: key });
    }
  }
  return attachments;
}

function occurredAt(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text || !/^\d{10,16}$/.test(text)) return undefined;
  const ms = Number(text);
  const stamp = text.length <= 11 ? ms * 1000 : ms;
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Map one Feishu `im.message.receive_v1` payload to a Channel D ingest event.
 * Only allowlisted group text/post/image/file messages from human senders are relayed.
 */
export function parseInboundEvent(payload: string, options: InboundOptions): ParsedInbound {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    return { ignored: "malformed event JSON" };
  }
  if (!isRecord(root)) return { ignored: "malformed event JSON" };
  const header = isRecord(root.header) ? root.header : undefined;
  if (!header) return { ignored: "missing event header" };
  if (header.event_type !== "im.message.receive_v1") return { ignored: "unsubscribed event type" };
  if (stringValue(header.app_id) !== options.appId) return { ignored: "event app mismatch" };

  const body = isRecord(root.event) ? root.event : undefined;
  const message = body && isRecord(body.message) ? body.message : undefined;
  const sender = body && isRecord(body.sender) ? body.sender : undefined;
  if (!body || !message || !sender) return { ignored: "malformed message event" };

  const chatType = stringValue(message.chat_type);
  if (chatType !== "group" && chatType !== "topic_group") return { ignored: "not a group message" };
  const chatId = stringValue(message.chat_id);
  const messageId = stringValue(message.message_id);
  const messageType = stringValue(message.message_type);
  if (!chatId || !messageId || !messageType) return { ignored: "message identity is incomplete" };
  if (!options.chats.has(chatId)) return { ignored: "chat is not in FEISHU_INBOUND_CHATS" };

  const senderType = stringValue(sender.sender_type);
  if (senderType !== "user") return { ignored: "bot or unknown sender" };
  const senderIds = isRecord(sender.sender_id) ? sender.sender_id : {};
  if (stringValue(senderIds.app_id)) return { ignored: "bot sender" };
  const nativeUserId = stringValue(senderIds.open_id)
    ?? stringValue(senderIds.user_id)
    ?? stringValue(senderIds.union_id);
  if (!nativeUserId) return { ignored: "sender identity is unavailable" };

  const rawContent = stringValue(message.content) ?? "";
  const text = messageText(messageType, rawContent, message.mentions);
  const attachments = messageAttachments(messageType, rawContent);
  if (!text && attachments.length === 0) return { ignored: `unsupported or empty ${messageType} message` };

  const source = { platform: "feishu", accountId: options.accountId, roomId: chatId };
  const parentId = stringValue(message.parent_id) ?? stringValue(message.root_id);
  const parent: MessageRef | undefined = parentId
    ? { endpoint: source, nativeMessageId: parentId }
    : undefined;
  const eventRef: MessageRef = { endpoint: source, nativeMessageId: messageId, ...(text ? { text } : {}) };
  const providerEventId = stringValue(header.event_id) ?? messageId;
  const eventId = `feishu-${options.accountId}-${providerEventId}`;
  const createTime = occurredAt(message.create_time);

  return {
    event: {
      schemaVersion: 1,
      eventId,
      kind: "message.created",
      source,
      actor: {
        platform: "feishu",
        identityNamespace: stringValue(senderIds.open_id) ? "open_id" : "user_id",
        nativeUserId,
      },
      providerEventId,
      // Feishu event ids are stable across retries; fall back to the message id.
      sourceDedupKey: `feishu:${options.accountId}:${providerEventId}`,
      message: eventRef,
      ...(parent ? { parent } : {}),
      ...(createTime ? { occurredAt: createTime } : {}),
      receivedAt: new Date().toISOString(),
      content: {
        ...(text ? { text } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
    },
  };
}