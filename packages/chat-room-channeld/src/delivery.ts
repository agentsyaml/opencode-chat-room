import type { SendReceipt } from "./adapter.ts";
import { log } from "./log.ts";
import type { IngestEvent } from "./protocol.ts";
import { targetKey } from "./rules.ts";
import { isTerminalDeliveryState, type ChannelState, type DeliveryRow, type ReceiptRow } from "./state.ts";

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 30_000;
const RETRY_BASE_MS = 500;

export type DeliveryResultHandler = (
  event: IngestEvent | undefined,
  delivery: DeliveryRow,
  receipt: ReceiptRow | undefined,
) => void;

export interface NotifyDeliveryResultOptions {
  /** Attempt whose receipt is attached; omit when the outcome has no receipt row. */
  attemptId?: string;
  /** Delivery ids already reported, so a later normal path cannot fire twice. */
  notified: Set<string>;
}

/** Invoke the result callback once for a terminal delivery, with its receipt when one exists. */
export function notifyDeliveryResult(
  state: ChannelState,
  deliveryId: string,
  handler: DeliveryResultHandler | undefined,
  options: NotifyDeliveryResultOptions,
): void {
  if (options.notified.has(deliveryId)) return;
  const delivery = state.getDelivery(deliveryId);
  if (!delivery || !isTerminalDeliveryState(delivery.state)) return;
  const receipt = options.attemptId
    ? state.listReceipts(deliveryId).find((item) => item.attemptId === options.attemptId)
    : undefined;
  options.notified.add(deliveryId);
  try {
    state.recordPublishedResult(delivery, receipt);
  } catch (error) {
    log.warn(`could not record result.published: ${error instanceof Error ? error.message : String(error)}`, {
      delivery: deliveryId,
    });
  }
  if (!handler) return;
  try {
    handler(state.getEvent(delivery.eventId), delivery, receipt);
  } catch (error) {
    log.warn(`onDeliveryResult failed: ${error instanceof Error ? error.message : String(error)}`, {
      delivery: deliveryId,
    });
  }
}

/** Persist one send outcome. The caller releases the ingest barrier afterwards. */
export function applyReceipt(
  state: ChannelState,
  row: DeliveryRow,
  attemptId: string,
  accountId: string,
  receipt: SendReceipt,
  now: number,
): void {
  const providerMessage = receipt.providerMessage
    ? JSON.stringify(receipt.providerMessage)
    : undefined;

  switch (receipt.state) {
    case "sent": {
      state.markDelivery(row.deliveryId, "sent", {
        providerMessage: providerMessage ?? null,
        lastError: null,
      });
      const event = state.getEvent(row.eventId);
      const echo = receipt.providerMessage?.nativeMessageId && receipt.providerMessage.endpoint
        ? {
            endpoint: targetKey(receipt.providerMessage.endpoint),
            nativeMessageId: receipt.providerMessage.nativeMessageId,
            // The room's logical id is the selected message for a forward, the
            // provider message for an adapter ingest, and the event id otherwise.
            logicalMessageId: event?.selectedMessage?.nativeMessageId
              ?? event?.message?.nativeMessageId
              ?? row.eventId,
          }
        : undefined;
      state.recordSent({
        deliveryId: row.deliveryId,
        attemptId,
        providerMessage: providerMessage ?? null,
        detail: receipt.detail ?? null,
        echo,
      });
      log.info("delivery sent", { account: accountId, delivery: row.deliveryId });
      break;
    }
    case "retryable":
    case "rate_limited": {
      if (attemptCount(row) >= MAX_ATTEMPTS) {
        state.markDelivery(row.deliveryId, "exhausted", {
          lastError: receipt.detail ?? "attempt limit reached",
        });
        state.recordReceipt({
          deliveryId: row.deliveryId,
          attemptId,
          state: "exhausted",
          detail: receipt.detail ?? "attempt limit reached",
        });
        log.error(`delivery exhausted after ${attemptCount(row)} attempts`, {
          account: accountId,
          delivery: row.deliveryId,
        });
        break;
      }
      const delay = receipt.retryAfterMs ?? Math.min(2 ** attemptCount(row) * RETRY_BASE_MS, MAX_BACKOFF_MS);
      state.markDelivery(row.deliveryId, receipt.state, {
        nextAttemptAt: now + delay,
        lastError: receipt.detail ?? null,
      });
      state.recordReceipt({
        deliveryId: row.deliveryId,
        attemptId,
        state: receipt.state,
        detail: receipt.detail ?? null,
      });
      log.warn(`delivery ${receipt.state}; retry in ${delay}ms`, {
        account: accountId,
        delivery: row.deliveryId,
      });
      break;
    }
    case "unknown": {
      state.markDelivery(row.deliveryId, "unknown", {
        lastError: receipt.detail ?? "unknown platform outcome",
      });
      state.recordReceipt({
        deliveryId: row.deliveryId,
        attemptId,
        state: "unknown",
        detail: receipt.detail ?? null,
      });
      log.warn("delivery unknown; not retried", { account: accountId, delivery: row.deliveryId });
      break;
    }
    case "permanent":
    case "unsupported": {
      state.markDelivery(row.deliveryId, receipt.state, {
        lastError: receipt.detail ?? null,
      });
      state.recordReceipt({
        deliveryId: row.deliveryId,
        attemptId,
        state: receipt.state,
        detail: receipt.detail ?? null,
      });
      log.error(`delivery ${receipt.state}`, { account: accountId, delivery: row.deliveryId });
      break;
    }
  }
}

function attemptCount(row: DeliveryRow): number {
  return row.attemptCount + 1;
}