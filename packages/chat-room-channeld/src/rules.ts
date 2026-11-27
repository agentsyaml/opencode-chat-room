import { ConfigError, type ChannelConfig, type RuleConfig, type RuleTarget } from "./config.ts";
import type { AttachmentRef, Endpoint, IngestEvent, MessageRef } from "./protocol.ts";

const QUOTE_PREVIEW_LIMIT = 280;
export const UNSUPPORTED_NOTICE = "attachment/format unsupported";

export type RenderResult = { text: string; degraded?: "empty" };

export type DeliveryPayload = {
  text: string;
  degraded?: "empty" | "unthreaded";
  parent?: MessageRef;
  attachments?: AttachmentRef[];
};

export type PayloadPlan = { payload: DeliveryPayload } | { dropped: string };

export function targetKey(endpoint: Endpoint): string {
  const parts = [endpoint.platform, endpoint.accountId, endpoint.roomId];
  if (parts.some((part) => !part || part.includes("/"))) {
    throw new ConfigError('config: platform, account and room must be non-empty and must not contain "/"');
  }
  return parts.join("/");
}

export function sameEndpoint(left: Endpoint, right: Endpoint): boolean {
  return left.platform === right.platform
    && left.accountId === right.accountId
    && left.roomId === right.roomId;
}

/**
 * Match rules for an event. Only the highest configured version of each rule
 * id is active; an explicit newer version replaces the older definition.
 */
export function matchRules(config: ChannelConfig, event: IngestEvent): RuleConfig[] {
  if (event.kind === "result.published") return [];
  const latest = new Map<string, RuleConfig>();
  for (const rule of config.rules) {
    const current = latest.get(rule.id);
    if (!current || rule.version > current.version) latest.set(rule.id, rule);
  }
  return [...latest.values()]
    .filter((rule) => {
      const { from } = rule;
      return from.platform === event.source.platform
        && from.account === event.source.accountId
        && from.room === event.source.roomId
        && (from.event === undefined || from.event === event.kind);
    })
    .sort((left, right) =>
      left.id === right.id
        ? left.version - right.version
        : left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

/**
 * Render the event text for one target. Transforms run in config order.
 */
export function renderForTarget(
  rule: RuleConfig,
  event: IngestEvent,
  target: RuleTarget,
): RenderResult {
  void target;
  let text = event.content?.text ?? "";
  if (!text) return { text: "", degraded: "empty" };

  for (const transform of rule.transforms) {
    switch (transform.op) {
      case "prefix-source":
        text = `[${event.source.platform}/${event.source.roomId}] ${text}`;
        break;
      case "trim":
        text = text.trim();
        break;
      case "truncate":
        if (text.length > transform.max) text = `${text.slice(0, transform.max)}…`;
        break;
      case "quote-preview": {
        const quote = event.selectedMessage?.text?.trim();
        if (quote) {
          const short = quote.length > QUOTE_PREVIEW_LIMIT
            ? `${quote.slice(0, QUOTE_PREVIEW_LIMIT)}…`
            : quote;
          text = `${text}\n> ${short}`;
        }
        break;
      }
    }
  }

  if (!text) return { text: "", degraded: "empty" };
  return { text };
}

/**
 * Build the frozen payload for one target. Unsupported content follows
 * onUnsupported; replies whose parent endpoint is not the target endpoint
 * follow onMissingParent.
 */
export function planPayload(rule: RuleConfig, event: IngestEvent, target: Endpoint): PayloadPlan {
  const rendered = renderForTarget(rule, event, {
    platform: target.platform,
    account: target.accountId,
    room: target.roomId,
  });

  let payload: DeliveryPayload;
  if (rendered.degraded === "empty" && !event.content?.attachments?.length) {
    if (rule.onUnsupported === "drop") return { dropped: "rendered text is empty" };
    payload = { text: UNSUPPORTED_NOTICE, degraded: "empty" };
  } else {
    payload = { text: rendered.text };
  }

  // Attachments are opaque to rule rendering: the host resolves chatroom
  // resource ids to local files right before the adapter sends.
  if (event.content?.attachments?.length) payload.attachments = event.content.attachments;

  if (event.parent) {
    if (sameEndpoint(event.parent.endpoint, target)) {
      payload.parent = event.parent;
    } else if (rule.onMissingParent === "drop") {
      return { dropped: "parent message mapping is unavailable" };
    } else {
      payload.degraded = "unthreaded";
    }
  }
  return { payload };
}