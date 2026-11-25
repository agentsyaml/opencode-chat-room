import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuleConfig, RuleTarget } from "../src/config.ts";
import type { IngestEvent } from "../src/protocol.ts";
import { openState } from "../src/state.ts";

const roots: string[] = [];

function tempFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-state-"));
  roots.push(root);
  return path.join(root, "state.sqlite");
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function event(overrides: Partial<IngestEvent> = {}): IngestEvent {
  const source = overrides.source ?? { platform: "mock", accountId: "a", roomId: "in" };
  return {
    schemaVersion: 1,
    eventId: overrides.eventId ?? "evt-1",
    kind: overrides.kind ?? "message.created",
    source,
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: overrides.sourceDedupKey ?? "dedup-1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content: { text: "hello" },
    ...overrides,
  };
}

const RULE: RuleConfig = {
  id: "relay",
  version: 1,
  from: { platform: "mock", account: "a", room: "in" },
  transforms: [],
  to: [{ platform: "mock", account: "b", room: "out" }],
  onMissingParent: "quote_or_unthreaded",
  onUnsupported: "text_with_notice",
};

function target(account: string, room: string): RuleTarget {
  return { platform: "mock", account, room };
}

describe("channel state", () => {
  test("duplicate ingest by dedup key returns the existing event id", () => {
    const state = openState(tempFile());
    const first = state.commitIngest(event());
    const second = state.commitIngest(event({ eventId: "evt-2" }));
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ duplicate: true, existingEventId: "evt-1" });
    state.close();
  });

  test("duplicate delivery enqueue is skipped by idempotency key", () => {
    const state = openState(tempFile());
    expect(state.commitIngest(event()).duplicate).toBe(false);
    const first = state.enqueueDeliveries("evt-1", RULE, [target("b", "out")], [
      JSON.stringify({ text: "one" }),
    ]);
    const second = state.enqueueDeliveries("evt-1", RULE, [target("b", "out")], [
      JSON.stringify({ text: "two" }),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(state.listDeliveries()).toHaveLength(1);
    expect(state.listDeliveries()[0]?.payload).toBe(JSON.stringify({ text: "one" }));
    state.close();
  });

  test("sharding picks the oldest pending delivery for its own account", async () => {
    const state = openState(tempFile());
    const ruleA = { ...RULE, id: "a" };
    const ruleB = { ...RULE, id: "b" };
    const a1 = state.enqueueDeliveries("evt-a1", ruleA, [target("a", "out-1")], ["1"])[0]!;
    await Bun.sleep(5);
    const a2 = state.enqueueDeliveries("evt-a2", ruleA, [target("a", "out-2")], ["2"])[0]!;
    const b1 = state.enqueueDeliveries("evt-b1", ruleB, [target("b", "out-1")], ["3"])[0]!;

    const firstA = state.nextPendingDelivery("mock/a", Date.now());
    expect(firstA?.deliveryId).toBe(a1.deliveryId);
    expect(firstA?.target).toBe("mock/a/out-1");

    state.markDelivery(a1.deliveryId, "in_flight", { attemptCount: 1 });
    const secondA = state.nextPendingDelivery("mock/a", Date.now());
    expect(secondA?.deliveryId).toBe(a2.deliveryId);

    const firstB = state.nextPendingDelivery("mock/b", Date.now());
    expect(firstB?.deliveryId).toBe(b1.deliveryId);
    expect(firstB?.target).toBe("mock/b/out-1");
    state.close();
  });

  test("claims use an exact account prefix, not LIKE wildcards", async () => {
    const state = openState(tempFile());
    const own = state.enqueueDeliveries("evt-own", RULE, [target("im_a", "out")], ["1"])[0]!;
    const lookalike = state.enqueueDeliveries("evt-lookalike", RULE, [target("imXa", "out")], ["2"])[0]!;
    const claimed = state.nextPendingDelivery("mock/im_a", Date.now());
    expect(claimed?.deliveryId).toBe(own.deliveryId);
    expect(claimed?.deliveryId).not.toBe(lookalike.deliveryId);

    state.markDelivery(own.deliveryId, "sent");
    expect(state.nextPendingDelivery("mock/im_a", Date.now())).toBeUndefined();
    expect(state.nextPendingDelivery("mock/imXa", Date.now())?.deliveryId).toBe(lookalike.deliveryId);
    state.close();
  });

  test("paused deliveries leave the claim queue and resume on demand", () => {
    const state = openState(tempFile());
    const own = state.enqueueDeliveries("evt-own", RULE, [target("a", "out")], ["1"])[0]!;
    const lookalike = state.enqueueDeliveries("evt-lookalike", RULE, [target("a2", "out")], ["2"])[0]!;
    expect(state.pauseAccountDeliveries("mock/a", "disabled")).toBe(1);
    expect(state.getDelivery(own.deliveryId)?.state).toBe("paused");
    expect(state.getDelivery(lookalike.deliveryId)?.state).toBe("pending");
    expect(state.nextPendingDelivery("mock/a", Date.now())).toBeUndefined();
    expect(state.resumePausedDeliveries()).toBe(1);
    expect(state.getDelivery(own.deliveryId)?.state).toBe("pending");
    expect(state.nextPendingDelivery("mock/a", Date.now())?.deliveryId).toBe(own.deliveryId);
    state.close();
  });

  test("startup recovery resets stale in-flight deliveries to pending", () => {
    const state = openState(tempFile());
    const created = state.enqueueDeliveries("evt-1", RULE, [target("b", "out")], ["{}"])[0]!;
    state.markDelivery(created.deliveryId, "in_flight", { attemptCount: 1 });
    expect(state.recoverInFlightDeliveries()).toBe(1);
    expect(state.getDelivery(created.deliveryId)?.state).toBe("pending");
    expect(state.nextPendingDelivery("mock/b", Date.now())?.deliveryId).toBe(created.deliveryId);
    state.close();
  });

  test("unknown state persists and is not picked up again", () => {
    const state = openState(tempFile());
    const created = state.enqueueDeliveries("evt-1", RULE, [target("b", "out")], ["{}"])[0]!;
    state.markDelivery(created.deliveryId, "unknown", { lastError: "timeout" });
    expect(state.getDelivery(created.deliveryId)?.state).toBe("unknown");
    expect(state.getDelivery(created.deliveryId)?.lastError).toBe("timeout");
    expect(state.nextPendingDelivery("mock/b", Date.now())).toBeUndefined();
    state.close();
  });

  test("sent receipt and echo mapping commit together", () => {
    const file = tempFile();
    const state = openState(file);
    const created = state.enqueueDeliveries("evt-1", RULE, [target("b", "out")], ["{}"])[0]!;
    state.recordSent({
      deliveryId: created.deliveryId,
      attemptId: "att-1",
      providerMessage: JSON.stringify({
        endpoint: { platform: "mock", accountId: "b", roomId: "out" },
        nativeMessageId: "native-1",
      }),
      echo: {
        endpoint: "mock/b/out",
        nativeMessageId: "native-1",
        logicalMessageId: "evt-1",
      },
    });
    expect(state.listReceipts(created.deliveryId)).toHaveLength(1);
    expect(state.findEcho("mock/b/out", "native-1")).toBe("evt-1");

    const withoutProvider = state.enqueueDeliveries("evt-2", RULE, [target("b", "out")], ["{}"])[0]!;
    state.recordSent({
      deliveryId: withoutProvider.deliveryId,
      attemptId: "att-2",
      providerMessage: null,
    });
    expect(state.listReceipts(withoutProvider.deliveryId)).toHaveLength(1);
    expect(state.findEcho("mock/b/out", "native-2")).toBeUndefined();

    const failing = state.enqueueDeliveries("evt-3", RULE, [target("b", "out")], ["{}"])[0]!;
    const trigger = new DatabaseSync(file);
    trigger.exec(
      "CREATE TRIGGER fail_echo BEFORE INSERT ON channel_echoes BEGIN SELECT RAISE(ABORT, 'echo failure'); END;",
    );
    trigger.close();
    expect(() =>
      state.recordSent({
        deliveryId: failing.deliveryId,
        attemptId: "att-3",
        providerMessage: "{}",
        echo: {
          endpoint: "mock/b/out",
          nativeMessageId: "native-3",
          logicalMessageId: "evt-3",
        },
      })
    ).toThrow("echo failure");
    expect(state.listReceipts(failing.deliveryId)).toHaveLength(0);
    expect(state.findEcho("mock/b/out", "native-3")).toBeUndefined();
    state.close();
  });

  test("records a receipt for an attempt", () => {
    const state = openState(tempFile());
    const created = state.enqueueDeliveries("evt-1", RULE, [target("b", "out")], ["{}"])[0]!;
    const receiptId = state.recordReceipt({
      deliveryId: created.deliveryId,
      attemptId: "att-1",
      state: "sent",
      detail: "ok",
    });
    const receipts = state.listReceipts(created.deliveryId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.receiptId).toBe(receiptId);
    expect(receipts[0]?.state).toBe("sent");
    state.close();
  });
});