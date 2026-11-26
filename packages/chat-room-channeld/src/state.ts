import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RuleConfig, RuleTarget } from "./config.ts";
import type { IngestEvent } from "./protocol.ts";
import { buildPublishedResult, PUBLISHED_RESULT_PREFIX, type PublishedResultEvent } from "./published.ts";

export { readChannelStats, type ChannelAccountStats, type ChannelStats } from "./stats.ts";
export type { PublishedResultEvent } from "./published.ts";

export const DELIVERY_STATES = [
  "pending",
  "in_flight",
  "sent",
  "retryable",
  "rate_limited",
  "permanent",
  "unsupported",
  "unknown",
  "exhausted",
  "paused",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = [
  "sent",
  "permanent",
  "unsupported",
  "exhausted",
  "unknown",
];

export function isTerminalDeliveryState(state: DeliveryState): boolean {
  return TERMINAL_DELIVERY_STATES.includes(state);
}

export interface DeliveryPatch {
  attemptCount?: number;
  nextAttemptAt?: number | null;
  lastError?: string | null;
  providerMessage?: string | null;
}

export interface DeliveryRow {
  deliveryId: string;
  eventId: string;
  ruleId: string;
  ruleVersion: number;
  target: string;
  idempotencyKey: string;
  payload: string;
  state: DeliveryState;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  providerMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReceiptRow {
  receiptId: string;
  deliveryId: string;
  attemptId: string;
  state: string;
  providerMessage: string | null;
  detail: string | null;
  observedAt: number;
}

export interface SentRecordInput {
  deliveryId: string;
  attemptId: string;
  providerMessage: string | null;
  detail?: string | null;
  observedAt?: number;
  echo?: { endpoint: string; nativeMessageId: string; logicalMessageId: string };
}

export interface ReceiptInput {
  deliveryId: string;
  attemptId: string;
  state: string;
  providerMessage?: string | null;
  detail?: string | null;
  observedAt?: number;
}

export type CommitResult =
  | { duplicate: true; existingEventId: string }
  | { duplicate: false; eventId: string; ingressSeq: number };

export interface ChannelState {
  commitIngest(event: IngestEvent): CommitResult;
  /** Remove a freshly committed event when a downstream consumer failed. */
  deleteIngestEvent(eventId: string): void;
  enqueueDeliveries(
    triggerEventId: string,
    rule: RuleConfig,
    targets: RuleTarget[],
    payloads: string[],
  ): { deliveryId: string; target: string }[];
  nextPendingDelivery(accountKey: string, now: number): DeliveryRow | undefined;
  markDelivery(deliveryId: string, state: DeliveryState, patch?: DeliveryPatch): void;
  recordSent(input: SentRecordInput): string;
  pauseAccountDeliveries(accountKey: string, reason: string): number;
  abandonUnconfiguredDeliveries(configuredAccountKeys: string[]): DeliveryRow[];
  resumePausedDeliveries(): number;
  recoverInFlightDeliveries(): number;
  recordReceipt(input: ReceiptInput): string;
  recordPublishedResult(delivery: DeliveryRow, receipt?: ReceiptRow): void;
  getPublishedResult(deliveryId: string): PublishedResultEvent | undefined;
  recordEcho(endpoint: string, nativeMessageId: string, logicalMessageId: string, deliveryId?: string): void;
  findEcho(endpoint: string, nativeMessageId: string): string | undefined;
  /** Latest sent provider message for one logical message at one endpoint. */
  findProviderMessage(endpoint: string, logicalMessageId: string): string | undefined;
  getDelivery(deliveryId: string): DeliveryRow | undefined;
  getEvent(eventId: string): IngestEvent | undefined;
  listDeliveries(): DeliveryRow[];
  countEvents(): number;
  listReceipts(deliveryId: string): ReceiptRow[];
  close(): void;
}

type RawRow = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_events (
  event_id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  ingress_seq INTEGER,
  committed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  target TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  provider_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_receipts (
  receipt_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_message TEXT,
  detail TEXT,
  observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_echoes (
  endpoint TEXT NOT NULL,
  native_message_id TEXT NOT NULL,
  logical_message_id TEXT NOT NULL,
  delivery_id TEXT,
  PRIMARY KEY (endpoint, native_message_id)
);
`;

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original failure.
    }
    throw error;
  }
}

function toDelivery(row: RawRow): DeliveryRow {
  return {
    deliveryId: String(row.delivery_id),
    eventId: String(row.event_id),
    ruleId: String(row.rule_id),
    ruleVersion: Number(row.rule_version),
    target: String(row.target),
    idempotencyKey: String(row.idempotency_key),
    payload: String(row.payload),
    state: String(row.state) as DeliveryState,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    providerMessage: row.provider_message === null ? null : String(row.provider_message),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toReceipt(row: RawRow): ReceiptRow {
  return {
    receiptId: String(row.receipt_id),
    deliveryId: String(row.delivery_id),
    attemptId: String(row.attempt_id),
    state: String(row.state),
    providerMessage: row.provider_message === null ? null : String(row.provider_message),
    detail: row.detail === null ? null : String(row.detail),
    observedAt: Number(row.observed_at),
  };
}

export function openState(path: string): ChannelState {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  let closed = false;

  function getDelivery(deliveryId: string): DeliveryRow | undefined {
    const row = db.prepare("SELECT * FROM channel_deliveries WHERE delivery_id = ?").get(deliveryId) as
      | RawRow
      | undefined;
    return row ? toDelivery(row) : undefined;
  }

  return {
    commitIngest(event: IngestEvent): CommitResult {
      return transaction(db, () => {
        const existing = db.prepare("SELECT event_id FROM channel_events WHERE dedup_key = ?").get(
          event.sourceDedupKey,
        ) as RawRow | undefined;
        if (existing) {
          return { duplicate: true, existingEventId: String(existing.event_id) };
        }
        const max = db.prepare("SELECT COALESCE(MAX(ingress_seq), 0) AS seq FROM channel_events").get() as RawRow;
        const ingressSeq = event.ingressSeq ?? Number(max.seq) + 1;
        const stored = { ...event, ingressSeq };
        db.prepare(
          `INSERT INTO channel_events (event_id, dedup_key, payload, ingress_seq, committed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(event.eventId, event.sourceDedupKey, JSON.stringify(stored), ingressSeq, Date.now());
        return { duplicate: false, eventId: event.eventId, ingressSeq };
      });
    },

    deleteIngestEvent(eventId) {
      db.prepare("DELETE FROM channel_events WHERE event_id = ?").run(eventId);
    },

    enqueueDeliveries(triggerEventId, rule, targets, payloads) {
      if (targets.length !== payloads.length) {
        throw new Error("enqueueDeliveries: targets and payloads must have the same length");
      }
      const now = Date.now();
      const created: { deliveryId: string; target: string }[] = [];
      transaction(db, () => {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO channel_deliveries
            (delivery_id, event_id, rule_id, rule_version, target, idempotency_key, payload, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        );
        targets.forEach((target, index) => {
          const key = `${target.platform}/${target.account}/${target.room}`;
          const idempotencyKey = `${triggerEventId}:${rule.id}:${rule.version}:0:${key}`;
          const deliveryId = `dlv-${randomUUID()}`;
          const result = insert.run(
            deliveryId,
            triggerEventId,
            rule.id,
            rule.version,
            key,
            idempotencyKey,
            payloads[index] ?? "",
            now,
            now,
          );
          if (Number(result.changes) > 0) created.push({ deliveryId, target: key });
        });
      });
      return created;
    },

    nextPendingDelivery(accountKey, now) {
      const prefix = `${accountKey.replace(/\/+$/, "")}/`;
      const row = db.prepare(
        `SELECT * FROM channel_deliveries
         WHERE substr(target, 1, length(?)) = ?
           AND state IN ('pending', 'retryable', 'rate_limited')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC, delivery_id ASC
         LIMIT 1`,
      ).get(prefix, prefix, now) as RawRow | undefined;
      return row ? toDelivery(row) : undefined;
    },

    markDelivery(deliveryId, state, patch = {}) {
      if (!DELIVERY_STATES.includes(state)) throw new Error(`unknown delivery state: ${state}`);
      const current = getDelivery(deliveryId);
      if (!current) throw new Error(`delivery not found: ${deliveryId}`);
      const terminal = isTerminalDeliveryState(state);
      const nextAttemptAt = patch.nextAttemptAt !== undefined
        ? patch.nextAttemptAt
        : terminal ? null : current.nextAttemptAt;
      db.prepare(
        `UPDATE channel_deliveries
         SET state = ?, attempt_count = ?, next_attempt_at = ?, last_error = ?, provider_message = ?, updated_at = ?
         WHERE delivery_id = ?`,
      ).run(
        state,
        patch.attemptCount ?? current.attemptCount,
        nextAttemptAt,
        patch.lastError !== undefined ? patch.lastError : current.lastError,
        patch.providerMessage !== undefined ? patch.providerMessage : current.providerMessage,
        Date.now(),
        deliveryId,
      );
    },

    recordSent(input) {
      const receiptId = `rcp-${randomUUID()}`;
      transaction(db, () => {
        db.prepare(
          `INSERT INTO channel_receipts
            (receipt_id, delivery_id, attempt_id, state, provider_message, detail, observed_at)
           VALUES (?, ?, ?, 'sent', ?, ?, ?)`,
        ).run(
          receiptId,
          input.deliveryId,
          input.attemptId,
          input.providerMessage,
          input.detail ?? null,
          input.observedAt ?? Date.now(),
        );
        if (input.echo) {
          db.prepare(
            `INSERT OR IGNORE INTO channel_echoes
              (endpoint, native_message_id, logical_message_id, delivery_id)
             VALUES (?, ?, ?, ?)`,
          ).run(
            input.echo.endpoint,
            input.echo.nativeMessageId,
            input.echo.logicalMessageId,
            input.deliveryId,
          );
        }
      });
      return receiptId;
    },

    pauseAccountDeliveries(accountKey, reason) {
      const prefix = `${accountKey.replace(/\/+$/, "")}/`;
      const result = db.prepare(
        `UPDATE channel_deliveries
         SET state = 'paused', next_attempt_at = NULL, last_error = ?, updated_at = ?
         WHERE substr(target, 1, length(?)) = ?
           AND state IN ('pending', 'retryable', 'rate_limited')`,
      ).run(reason, Date.now(), prefix, prefix);
      return Number(result.changes);
    },

    abandonUnconfiguredDeliveries(configuredAccountKeys) {
      const configured = [...new Set(configuredAccountKeys)];
      const accountKeySql = `CASE WHEN instr(target, '/') > 0
          AND instr(substr(target, instr(target, '/') + 1), '/') > 0
        THEN substr(target, 1, instr(target, '/') + instr(substr(target, instr(target, '/') + 1), '/') - 1)
        ELSE target END`;
      const filter = configured.length > 0
        ? `AND (${accountKeySql}) NOT IN (${configured.map(() => "?").join(", ")})`
        : "";
      const rows = db.prepare(
        `SELECT * FROM channel_deliveries
         WHERE state IN ('pending', 'retryable', 'rate_limited', 'in_flight', 'paused')
           ${filter}
         ORDER BY created_at ASC, delivery_id ASC`,
      ).all(...configured) as RawRow[];
      if (rows.length === 0) return [];
      transaction(db, () =>
        db.prepare(
          `UPDATE channel_deliveries
           SET state = 'unknown', next_attempt_at = NULL, last_error = ?, updated_at = ?
           WHERE state IN ('pending', 'retryable', 'rate_limited', 'in_flight', 'paused')
             ${filter}`,
        ).run("account is not configured; add it back to retry", Date.now(), ...configured)
      );
      return rows.map((row) => ({ ...toDelivery(row), state: "unknown" as const }));
    },

    resumePausedDeliveries() {
      const result = db.prepare(
        `UPDATE channel_deliveries
         SET state = 'pending', next_attempt_at = NULL, updated_at = ?
         WHERE state = 'paused'`,
      ).run(Date.now());
      return Number(result.changes);
    },

    recoverInFlightDeliveries() {
      const result = db.prepare(
        `UPDATE channel_deliveries
         SET state = 'pending', next_attempt_at = NULL,
             last_error = 'recovered stale in_flight after restart', updated_at = ?
         WHERE state = 'in_flight'`,
      ).run(Date.now());
      return Number(result.changes);
    },

    recordReceipt(input) {
      const receiptId = `rcp-${randomUUID()}`;
      db.prepare(
        `INSERT INTO channel_receipts
          (receipt_id, delivery_id, attempt_id, state, provider_message, detail, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        receiptId,
        input.deliveryId,
        input.attemptId,
        input.state,
        input.providerMessage ?? null,
        input.detail ?? null,
        input.observedAt ?? Date.now(),
      );
      return receiptId;
    },

    recordPublishedResult(delivery, receipt) {
      const now = Date.now();
      const event = buildPublishedResult(delivery, receipt, now);
      db.prepare(
        `INSERT OR IGNORE INTO channel_events (event_id, dedup_key, payload, ingress_seq, committed_at)
         VALUES (?, ?, ?, NULL, ?)`,
      ).run(event.eventId, event.sourceDedupKey, JSON.stringify(event), now);
    },

    getPublishedResult(deliveryId) {
      const row = db.prepare("SELECT payload FROM channel_events WHERE dedup_key = ?").get(
        `${PUBLISHED_RESULT_PREFIX}${deliveryId}`,
      ) as RawRow | undefined;
      return row ? (JSON.parse(String(row.payload)) as PublishedResultEvent) : undefined;
    },

    recordEcho(endpoint, nativeMessageId, logicalMessageId, deliveryId) {
      db.prepare(
        `INSERT OR IGNORE INTO channel_echoes
          (endpoint, native_message_id, logical_message_id, delivery_id)
         VALUES (?, ?, ?, ?)`,
      ).run(endpoint, nativeMessageId, logicalMessageId, deliveryId ?? null);
    },

    findEcho(endpoint, nativeMessageId) {
      const row = db.prepare(
        "SELECT logical_message_id FROM channel_echoes WHERE endpoint = ? AND native_message_id = ?",
      ).get(endpoint, nativeMessageId) as RawRow | undefined;
      return row ? String(row.logical_message_id) : undefined;
    },

    findProviderMessage(endpoint, logicalMessageId) {
      const row = db.prepare(
        `SELECT native_message_id FROM channel_echoes
         WHERE endpoint = ? AND logical_message_id = ? AND delivery_id IS NOT NULL
         ORDER BY rowid DESC LIMIT 1`,
      ).get(endpoint, logicalMessageId) as RawRow | undefined;
      return row ? String(row.native_message_id) : undefined;
    },

    getDelivery,

    getEvent(eventId) {
      const row = db.prepare("SELECT payload FROM channel_events WHERE event_id = ?").get(eventId) as
        | RawRow
        | undefined;
      return row ? (JSON.parse(String(row.payload)) as IngestEvent) : undefined;
    },

    listDeliveries() {
      return (db.prepare(
        "SELECT * FROM channel_deliveries ORDER BY created_at ASC, delivery_id ASC",
      ).all() as RawRow[]).map(toDelivery);
    },

    listReceipts(deliveryId) {
      return (db.prepare(
        "SELECT * FROM channel_receipts WHERE delivery_id = ? ORDER BY observed_at ASC, receipt_id ASC",
      ).all(deliveryId) as RawRow[]).map(toReceipt);
    },

    countEvents() {
      // Ingest events only; published results are reported by readChannelStats.
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM channel_events WHERE dedup_key NOT LIKE ?",
      ).get(`${PUBLISHED_RESULT_PREFIX}%`) as RawRow;
      return Number(row.count);
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}