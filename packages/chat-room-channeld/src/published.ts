import { EVENT_SCHEMA_VERSION, type IngestEvent } from "./protocol.ts";
import type { DeliveryRow, DeliveryState, ReceiptRow } from "./state.ts";

export const PUBLISHED_RESULT_PREFIX = "result.published:";

export interface PublishedResultEvent extends IngestEvent {
  forwardEventId: string;
  deliveryId: string;
  receiptId: string | null;
  state: DeliveryState;
  target: string;
}

/** Build the ids/state-only terminal result event. Never include message content or error detail. */
export function buildPublishedResult(
  delivery: DeliveryRow,
  receipt: ReceiptRow | undefined,
  now: number,
): PublishedResultEvent {
  const occurredAt = new Date(now).toISOString();
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `result-${delivery.deliveryId}`,
    kind: "result.published",
    source: { platform: "channeld", accountId: "host", roomId: delivery.deliveryId },
    actor: { platform: "channeld", identityNamespace: "system", nativeUserId: "channeld" },
    sourceDedupKey: `${PUBLISHED_RESULT_PREFIX}${delivery.deliveryId}`,
    cause: { rootEventId: delivery.eventId, visitedEndpoints: [], hopCount: 1 },
    occurredAt,
    receivedAt: occurredAt,
    forwardEventId: delivery.eventId,
    deliveryId: delivery.deliveryId,
    receiptId: receipt?.receiptId ?? null,
    state: delivery.state,
    target: delivery.target,
  };
}