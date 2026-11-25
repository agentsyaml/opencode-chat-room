import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig, type RuleConfig, type RuleTarget } from "../src/config.ts";
import { notifyDeliveryResult } from "../src/delivery.ts";
import { ChannelHost, type SpawnAdapter } from "../src/host.ts";
import type { IngestEvent } from "../src/protocol.ts";
import { matchRules } from "../src/rules.ts";
import { openState, readChannelStats, type ChannelState, type DeliveryRow } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-published-"));
  roots.push(root);
  return path.join(root, "state.sqlite");
}

function event(): IngestEvent {
  return {
    schemaVersion: 1,
    eventId: "evt-1",
    kind: "message.created",
    source: { platform: "mock", accountId: "a", roomId: "in" },
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: "dedup-1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content: { text: "payload-secret message text" },
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

function seed(file: string): { state: ChannelState; delivery: DeliveryRow } {
  const state = openState(file);
  state.commitIngest(event());
  const created = state.enqueueDeliveries(
    "evt-1",
    RULE,
    [target("b", "out")],
    [JSON.stringify({ text: "payload-secret message text" })],
  )[0]!;
  return { state, delivery: state.getDelivery(created.deliveryId)! };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

describe("result.published", () => {
  test("a sent terminal records one ids-only result and ignores duplicate notifications", () => {
    const file = tempFile();
    const { state, delivery } = seed(file);
    state.markDelivery(delivery.deliveryId, "sent", { providerMessage: "provider-secret" });
    const receiptId = state.recordReceipt({
      deliveryId: delivery.deliveryId,
      attemptId: "att-1",
      state: "sent",
      detail: "error-secret detail",
    });
    const updated = state.getDelivery(delivery.deliveryId)!;

    const notified = new Set<string>();
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    notifyDeliveryResult(state, delivery.deliveryId, handler, { attemptId: "att-1", notified });
    notifyDeliveryResult(state, delivery.deliveryId, handler, { attemptId: "att-1", notified });
    expect(calls).toBe(1);

    const published = state.getPublishedResult(delivery.deliveryId)!;
    expect(published).toMatchObject({
      kind: "result.published",
      source: { platform: "channeld", accountId: "host", roomId: delivery.deliveryId },
      actor: { platform: "channeld", identityNamespace: "system", nativeUserId: "channeld" },
      sourceDedupKey: `result.published:${delivery.deliveryId}`,
      cause: { rootEventId: "evt-1", visitedEndpoints: [], hopCount: 1 },
      forwardEventId: "evt-1",
      deliveryId: delivery.deliveryId,
      receiptId,
      state: "sent",
      target: "mock/b/out",
    });
    expect(published.state).toBe(updated.state);
    expect(typeof published.occurredAt).toBe("string");
    expect(typeof published.receivedAt).toBe("string");
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain("payload-secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("error-secret");
    state.close();
  });

  test("terminal unknown without a receipt records receiptId null even with no handler", () => {
    const file = tempFile();
    const { state, delivery } = seed(file);
    state.markDelivery(delivery.deliveryId, "unknown", { lastError: "error-secret unknown" });

    notifyDeliveryResult(state, delivery.deliveryId, undefined, { notified: new Set() });
    notifyDeliveryResult(state, delivery.deliveryId, undefined, { notified: new Set() });

    const published = state.getPublishedResult(delivery.deliveryId)!;
    expect(published).toMatchObject({
      kind: "result.published",
      forwardEventId: "evt-1",
      deliveryId: delivery.deliveryId,
      receiptId: null,
      state: "unknown",
      target: "mock/b/out",
    });
    expect(JSON.stringify(published)).not.toContain("error-secret");
    state.close();
    expect(readChannelStats(file).publishedResults).toBe(1);
  });

  test("result.published never matches a rule, even when configured explicitly", () => {
    const config = parseConfig({
      stateFile: "unused.sqlite",
      accounts: [{ id: "host", platform: "channeld", adapter: { command: ["unused"] } }],
      rules: [{
        id: "subscribe",
        version: 1,
        from: { platform: "channeld", account: "host", room: "dlv-1", event: "result.published" },
        transforms: [],
        to: [{ platform: "channeld", account: "host", room: "out" }],
      }],
    });
    const published = {
      ...event(),
      kind: "result.published",
      source: { platform: "channeld", accountId: "host", roomId: "dlv-1" },
    };
    expect(matchRules(config, published)).toEqual([]);
  });

  test("host records a terminal result without a callback and status keeps it out of source gaps", async () => {
    const file = tempFile();
    const config = parseConfig({
      stateFile: file,
      accounts: [{ id: "b", platform: "mock", adapter: { command: ["unused"] } }],
      rules: [{ ...RULE }],
    });
    const spawnAdapter: SpawnAdapter = () => ({
      start: async () => {},
      send: async (_deliveryId, _attemptId, _idempotencyKey, endpoint) => ({
        state: "sent",
        providerMessage: { endpoint, nativeMessageId: "native-1" },
      }),
      stop: async () => {},
    });
    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (filePath) => {
        state = openState(filePath);
        return state;
      },
      deliveryIntervalMs: 10,
      spawnAdapter,
    });

    try {
      await host.start();
      await host.ingest(event());
      await waitFor(() => state!.listDeliveries()[0]?.state === "sent");
      const delivery = state!.listDeliveries()[0]!;
      const published = state!.getPublishedResult(delivery.deliveryId)!;
      expect(published).toMatchObject({
        kind: "result.published",
        forwardEventId: "evt-1",
        deliveryId: delivery.deliveryId,
        state: "sent",
        target: "mock/b/out",
      });
      expect(typeof published.receiptId).toBe("string");
      expect(state!.countEvents()).toBe(1);
    } finally {
      await host.stop();
    }

    const stats = readChannelStats(file);
    expect(stats.events).toBe(2);
    expect(stats.publishedResults).toBe(1);
    expect(stats.eventsWithoutDeliveries).toBe(0);
  });
});