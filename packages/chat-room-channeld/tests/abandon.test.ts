import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig, type RuleConfig, type RuleTarget } from "../src/config.ts";
import { ChannelHost, type SpawnAdapter } from "../src/host.ts";
import { openState, readChannelStats, type ChannelState, type DeliveryRow } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-abandon-"));
  roots.push(root);
  return path.join(root, "state.sqlite");
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

function enqueue(state: ChannelState, ruleId: string, account: string, room: string): DeliveryRow {
  const created = state.enqueueDeliveries(
    "evt-1",
    { ...RULE, id: ruleId },
    [target(account, room)],
    ["{}"],
  )[0]!;
  return state.getDelivery(created.deliveryId)!;
}

function fakeAdapter(sends: unknown[]): SpawnAdapter {
  return () => ({
    start: async () => {},
    send: async (_deliveryId, _attemptId, _idempotencyKey, endpoint) => {
      sends.push(endpoint);
      return {
        state: "sent",
        providerMessage: { endpoint, nativeMessageId: `native-${sends.length}` },
      };
    },
    stop: async () => {},
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

describe("unconfigured account cleanup", () => {
  test("abandons ghost backlog before recovery and does not re-pend it on restart", async () => {
    const file = tempFile();
    const seed = openState(file);
    const absentPending = enqueue(seed, "absent-pending", "gone", "out-1");
    const absentInFlight = enqueue(seed, "absent-in-flight", "gone", "out-2");
    const absentPaused = enqueue(seed, "absent-paused", "gone", "out-3");
    const configured = enqueue(seed, "configured", "b", "out");
    seed.markDelivery(absentInFlight.deliveryId, "in_flight", { attemptCount: 1 });
    seed.markDelivery(absentPaused.deliveryId, "paused", { lastError: "disabled before restart" });
    seed.close();

    const config = parseConfig({
      stateFile: file,
      accounts: [{ id: "b", platform: "mock", adapter: { command: ["unused"] } }],
      rules: [],
    });

    let state: ChannelState | undefined;
    const sends: unknown[] = [];
    const results: DeliveryRow[] = [];
    const host = new ChannelHost(config, {
      stateFactory: (filePath) => {
        state = openState(filePath);
        return state;
      },
      deliveryIntervalMs: 10,
      spawnAdapter: fakeAdapter(sends),
      onDeliveryResult: (_event, delivery) => {
        results.push(delivery);
      },
    });

    try {
      await host.start();
      await waitFor(() => sends.length === 1 && state!.getDelivery(configured.deliveryId)?.state === "sent");

      for (const row of [absentPending, absentInFlight, absentPaused]) {
        const abandoned = state!.getDelivery(row.deliveryId)!;
        expect(abandoned.state).toBe("unknown");
        expect(abandoned.nextAttemptAt).toBeNull();
        expect(abandoned.lastError).toBe("account is not configured; add it back to retry");
        expect(state!.getPublishedResult(row.deliveryId)?.state).toBe("unknown");
        expect(results.filter((delivery) => delivery.deliveryId === row.deliveryId)).toHaveLength(1);
      }
      expect(state!.getDelivery(configured.deliveryId)?.state).toBe("sent");

      const stats = readChannelStats(file);
      expect(stats.publishedResults).toBe(4);
      expect(stats.queueDepth).toBe(0);
      expect(stats.accounts).toContainEqual(expect.objectContaining({
        account: "mock/b",
        queueDepth: 0,
      }));
      expect(stats.accounts.find((account) => account.account === "mock/b")?.unknown).toBe(0);
      await host.stop();
    } finally {
      await host.stop();
    }

    const restartedSends: unknown[] = [];
    const restarted = new ChannelHost(config, {
      stateFactory: (filePath) => {
        state = openState(filePath);
        return state;
      },
      deliveryIntervalMs: 10,
      spawnAdapter: fakeAdapter(restartedSends),
    });
    try {
      await restarted.start();
      await Bun.sleep(150);
      expect(restartedSends).toHaveLength(0);
      for (const row of [absentPending, absentInFlight, absentPaused]) {
        expect(state!.getDelivery(row.deliveryId)?.state).toBe("unknown");
      }
      expect(readChannelStats(file).queueDepth).toBe(0);
      expect(readChannelStats(file).publishedResults).toBe(4);
    } finally {
      await restarted.stop();
    }
  });
});