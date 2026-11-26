import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuleConfig, RuleTarget } from "../src/config.ts";
import type { IngestEvent } from "../src/protocol.ts";
import { openState, readChannelStats, type ChannelState, type DeliveryRow } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-status-"));
  roots.push(root);
  return path.join(root, "state.sqlite");
}

function event(eventId: string, dedupKey: string): IngestEvent {
  return {
    schemaVersion: 1,
    eventId,
    kind: "message.created",
    source: { platform: "mock", accountId: "a", roomId: "room-secret-source" },
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: dedupKey,
    receivedAt: "2026-01-01T00:00:00.000Z",
    content: { text: "payload-secret message text" },
  };
}

const RULE: RuleConfig = {
  id: "rule-base",
  version: 1,
  from: { platform: "mock", account: "a", room: "room-secret-source" },
  transforms: [],
  to: [{ platform: "mock", account: "b", room: "room-secret-target" }],
  onMissingParent: "quote_or_unthreaded",
  onUnsupported: "text_with_notice",
};

function target(account: string, room: string): RuleTarget {
  return { platform: "mock", account, room };
}

function enqueue(state: ChannelState, ruleId: string, account: string, room: string): DeliveryRow {
  const created = state.enqueueDeliveries(
    "evt-1",
    { ...RULE, id: ruleId },
    [target(account, room)],
    [JSON.stringify({ text: "payload-secret message text" })],
  )[0]!;
  return state.getDelivery(created.deliveryId)!;
}

describe("channel stats", () => {
  test("reports queue, health and integrity counts without sensitive content", async () => {
    const file = tempFile();
    const state = openState(file);
    state.commitIngest(event("evt-1", "dedup-1"));
    state.commitIngest(event("evt-orphan", "dedup-orphan"));

    const paused = enqueue(state, "rule-secret-paused", "b", "room-secret-paused");
    await Bun.sleep(5);
    const sent = enqueue(state, "rule-secret-sent", "a", "room-secret-sent");
    const unknown = enqueue(state, "rule-secret-unknown", "a", "room-secret-unknown");
    await Bun.sleep(5);
    const pending = enqueue(state, "rule-secret-pending", "a", "room-secret-pending");
    const retryable = enqueue(state, "rule-secret-retryable", "b", "room-secret-retryable");
    const rateLimited = enqueue(state, "rule-secret-rate", "b", "room-secret-rate");

    state.markDelivery(paused.deliveryId, "paused", { lastError: "error-secret-paused" });
    state.markDelivery(sent.deliveryId, "sent", { providerMessage: "provider-secret-sent" });
    state.markDelivery(unknown.deliveryId, "unknown", { lastError: "error-secret-unknown" });
    state.markDelivery(retryable.deliveryId, "retryable", { lastError: "error-secret-retry" });
    state.markDelivery(rateLimited.deliveryId, "rate_limited", { lastError: "error-secret-rate" });

    for (const failedState of ["permanent", "unsupported", "exhausted"] as const) {
      const failed = enqueue(state, `rule-secret-${failedState}`, "c", `room-secret-${failedState}`);
      state.markDelivery(failed.deliveryId, failedState, { lastError: "error-secret-failed" });
    }

    const queueRows = state
      .listDeliveries()
      .filter((row) => ["pending", "retryable", "rate_limited"].includes(row.state));
    const oldestBacklogAt = Math.min(...queueRows.map((row) => row.createdAt));
    const accountAOldest = Math.min(
      ...queueRows.filter((row) => row.target.startsWith("mock/a/")).map((row) => row.createdAt),
    );
    const accountBOldest = Math.min(
      ...queueRows.filter((row) => row.target.startsWith("mock/b/")).map((row) => row.createdAt),
    );
    expect(pending.createdAt).toBeGreaterThan(paused.createdAt);
    state.close();

    const orphanAt = Date.now();
    const raw = new DatabaseSync(file);
    raw.prepare(
      `INSERT INTO channel_deliveries
        (delivery_id, event_id, rule_id, rule_version, target, idempotency_key, payload, state,
         attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "dlv-orphan",
      "missing-event",
      "rule-secret-orphan",
      1,
      "mock/a/room-secret-orphan",
      "orphan-delivery-key",
      JSON.stringify({ text: "payload-secret orphan" }),
      "sent",
      0,
      orphanAt,
      orphanAt,
    );
    raw.prepare(
      `INSERT INTO channel_receipts
        (receipt_id, delivery_id, attempt_id, state, provider_message, detail, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "rcp-orphan",
      "missing-delivery",
      "att-orphan",
      "sent",
      "provider-secret-receipt",
      "error-secret-receipt",
      orphanAt,
    );
    raw.close();

    const statsNow = Date.now();
    const stats = readChannelStats(file, statsNow);
    expect(stats).toEqual({
      generatedAt: statsNow,
      events: 2,
      publishedResults: 0,
      eventsWithoutDeliveries: 1,
      deliveriesWithoutEvent: 1,
      receiptsWithoutDelivery: 1,
      deliveries: {
        total: 10,
        pending: 1,
        inFlight: 0,
        retryable: 1,
        rateLimited: 1,
        paused: 1,
        unknown: 1,
        sent: 2,
        failed: 3,
      },
      queueDepth: 3,
      oldestBacklogAt,
      oldestBacklogAgeMs: statsNow - oldestBacklogAt,
      accounts: [
        {
          account: "mock/a",
          state: "unknown",
          queueDepth: 1,
          oldestBacklogAt: accountAOldest,
          unknown: 1,
          retryable: 0,
          rateLimited: 0,
        },
        {
          account: "mock/b",
          state: "unknown",
          queueDepth: 2,
          oldestBacklogAt: accountBOldest,
          unknown: 0,
          retryable: 1,
          rateLimited: 1,
        },
        {
          account: "mock/c",
          state: "unknown",
          queueDepth: 0,
          oldestBacklogAt: null,
          unknown: 0,
          retryable: 0,
          rateLimited: 0,
        },
      ],
    });

    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain("payload-secret");
    expect(serialized).not.toContain("rule-secret");
    expect(serialized).not.toContain("error-secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("room-secret");
  });

  test("rejects a missing state file without creating it", () => {
    const file = tempFile();
    expect(() => readChannelStats(file)).toThrow(`channel state not found: ${file}`);
    expect(existsSync(file)).toBe(false);
  });

  test("rejects a database without channel tables", () => {
    const file = tempFile();
    writeFileSync(file, "");
    expect(() => readChannelStats(file)).toThrow(`channel state not found: ${file}`);
  });
});