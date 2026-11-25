import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SendReceipt } from "../src/adapter.ts";
import { parseConfig, type ChannelConfig } from "../src/config.ts";
import { ChannelHost, type HostDeps, type SpawnAdapter, type SpawnAdapterContext } from "../src/host.ts";
import type { Endpoint, IngestEvent } from "../src/protocol.ts";
import { openState, type ChannelState } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-result-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function fakeAdapter(send: (target: Endpoint) => SendReceipt): SpawnAdapter {
  return () => ({
    start: async () => {},
    send: async (_deliveryId, _attemptId, _idempotencyKey, target) => send(target),
    stop: async () => {},
  });
}

function relayConfig(
  stateFile: string,
  accounts: string[],
  targets: { account: string; room: string }[],
): ChannelConfig {
  return parseConfig({
    stateFile,
    accounts: accounts.map((id) => ({
      id,
      platform: "mock",
      adapter: { command: ["bun", "unused-adapter.ts"] },
    })),
    rules: [
      {
        id: "relay",
        version: 1,
        from: { platform: "mock", account: accounts[0]!, room: "in" },
        transforms: [],
        to: targets.map((target) => ({ platform: "mock", ...target })),
      },
    ],
  });
}

function createHost(config: ChannelConfig, deps: Omit<HostDeps, "stateFactory">) {
  let state: ChannelState | undefined;
  const host = new ChannelHost(config, {
    ...deps,
    stateFactory: (file) => {
      state = openState(file);
      return state;
    },
  });
  return {
    host,
    state: () => {
      if (!state) throw new Error("host not started");
      return state;
    },
  };
}

function messageEvent(eventId: string): IngestEvent {
  return {
    schemaVersion: 1,
    eventId,
    kind: "message.created",
    source: { platform: "mock", accountId: "a", roomId: "in" },
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: eventId,
    receivedAt: new Date().toISOString(),
    content: { text: "hello" },
  };
}

function forwardEvent(eventId: string, requestedTarget?: Endpoint): IngestEvent {
  return {
    schemaVersion: 1,
    eventId,
    kind: "message.forward_requested",
    source: { platform: "mock", accountId: "a", roomId: "in" },
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: eventId,
    receivedAt: new Date().toISOString(),
    content: { text: "forward me" },
    selectedMessage: {
      endpoint: { platform: "mock", accountId: "a", roomId: "in" },
      nativeMessageId: "native-source",
    },
    ...(requestedTarget ? { requestedTarget } : {}),
  };
}

describe("delivery results", () => {
  test("forward_requested only delivers to the requested target", async () => {
    const root = tempDir();
    const config = relayConfig(path.join(root, "state.sqlite"), ["a", "b", "c"], [
      { account: "b", room: "out" },
      { account: "c", room: "out" },
    ]);
    const { host, state } = createHost(config, {
      deliveryIntervalMs: 10,
      spawnAdapter: fakeAdapter((target) => ({
        state: "sent",
        providerMessage: { endpoint: target, nativeMessageId: `native-${target.accountId}` },
      })),
    });

    try {
      await host.start();
      await host.ingest(
        forwardEvent("forward-b-only", { platform: "mock", accountId: "b", roomId: "out" }),
      );
      await waitFor(() => {
        const deliveries = state().listDeliveries();
        return deliveries.length === 1
          && deliveries[0]?.state === "sent"
          && state().listReceipts(deliveries[0].deliveryId).length === 1;
      });
      await Bun.sleep(100);
      const deliveries = state().listDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.target).toBe("mock/b/out");
      expect(state().listReceipts(deliveries[0]!.deliveryId).map((receipt) => receipt.state)).toEqual([
        "sent",
      ]);
      expect(deliveries.some((delivery) => delivery.target === "mock/c/out")).toBe(false);
    } finally {
      await host.stop();
    }
  });

  test("onDeliveryResult fires once with the matching event, delivery and receipt", async () => {
    const root = tempDir();
    const config = relayConfig(path.join(root, "state.sqlite"), ["a", "b"], [
      { account: "b", room: "out" },
    ]);
    const results: {
      eventId?: string;
      sourceRoom?: string;
      deliveryId: string;
      receiptState: string;
      receiptDeliveryId: string;
    }[] = [];
    const { host, state } = createHost(config, {
      deliveryIntervalMs: 10,
      spawnAdapter: fakeAdapter((target) => ({
        state: "sent",
        providerMessage: { endpoint: target, nativeMessageId: "native-result" },
      })),
      onDeliveryResult: (event, delivery, receipt) => {
        results.push({
          eventId: event?.eventId,
          sourceRoom: event?.source.roomId,
          deliveryId: delivery.deliveryId,
          receiptState: receipt!.state,
          receiptDeliveryId: receipt!.deliveryId,
        });
      },
    });

    try {
      await host.start();
      await host.ingest(messageEvent("result-sent"));
      await waitFor(() => results.length === 1 && state().listDeliveries().length === 1);
      await Bun.sleep(100);
      const delivery = state().listDeliveries()[0]!;
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        eventId: "result-sent",
        sourceRoom: "in",
        deliveryId: delivery.deliveryId,
        receiptState: "sent",
        receiptDeliveryId: delivery.deliveryId,
      });
      expect(state().getEvent(delivery.eventId)?.eventId).toBe("result-sent");
    } finally {
      await host.stop();
    }
  });

  test("account disable reports an in-flight unknown delivery once without a receipt", async () => {
    const root = tempDir();
    const config = relayConfig(path.join(root, "state.sqlite"), ["a", "b", "c", "d"], [
      { account: "b", room: "out" },
      { account: "c", room: "out" },
      { account: "d", room: "out" },
    ]);
    const contexts = new Map<string, SpawnAdapterContext>();
    const results: {
      eventId?: string;
      deliveryId: string;
      state: string;
      receiptState?: string;
    }[] = [];
    let releaseB: ((receipt: SendReceipt) => void) | undefined;
    const { host, state } = createHost(config, {
      deliveryIntervalMs: 10,
      spawnAdapter: (account, context) => {
        contexts.set(account.id, context);
        return {
          start: async () => {},
          send: async (_deliveryId, _attemptId, _idempotencyKey, target) => {
            if (account.id === "b") {
              return await new Promise<SendReceipt>((resolve) => {
                releaseB = resolve;
              });
            }
            if (account.id === "d") {
              return { state: "retryable", retryAfterMs: 60_000, detail: "try later" };
            }
            return {
              state: "sent",
              providerMessage: { endpoint: target, nativeMessageId: "native-c" },
            };
          },
          stop: async () => {},
        };
      },
      onDeliveryResult: (event, delivery, receipt) => {
        results.push({
          eventId: event?.eventId,
          deliveryId: delivery.deliveryId,
          state: delivery.state,
          receiptState: receipt?.state,
        });
      },
    });

    try {
      await host.start();
      await host.ingest(messageEvent("result-disable"));
      await waitFor(() => {
        const deliveries = state().listDeliveries();
        return deliveries.length === 3
          && deliveries.some((delivery) =>
            delivery.target === "mock/b/out" && delivery.state === "in_flight"
          )
          && deliveries.some((delivery) =>
            delivery.target === "mock/c/out" && delivery.state === "sent"
          )
          && deliveries.some((delivery) =>
            delivery.target === "mock/d/out" && delivery.state === "retryable"
          )
          && results.length === 1;
      });

      contexts.get("b")!.onExit(1, null);
      await waitFor(() => results.length === 2);
      await Bun.sleep(100);

      const deliveries = state().listDeliveries();
      const b = deliveries.find((delivery) => delivery.target === "mock/b/out")!;
      const c = deliveries.find((delivery) => delivery.target === "mock/c/out")!;
      const d = deliveries.find((delivery) => delivery.target === "mock/d/out")!;
      expect(b.state).toBe("unknown");
      expect(state().listReceipts(b.deliveryId)).toHaveLength(0);
      expect(results).toHaveLength(2);
      expect(results.find((result) => result.deliveryId === b.deliveryId)).toEqual({
        eventId: "result-disable",
        deliveryId: b.deliveryId,
        state: "unknown",
        receiptState: undefined,
      });
      expect(results.find((result) => result.deliveryId === c.deliveryId)).toEqual({
        eventId: "result-disable",
        deliveryId: c.deliveryId,
        state: "sent",
        receiptState: "sent",
      });
      expect(results.some((result) => result.deliveryId === d.deliveryId)).toBe(false);

      releaseB?.({ state: "unknown", detail: "released after disable" });
      await waitFor(() => state().listReceipts(b.deliveryId).length === 1);
      await Bun.sleep(100);
      expect(results).toHaveLength(2);
    } finally {
      releaseB?.({ state: "unknown", detail: "released during cleanup" });
      await host.stop();
    }
  });

  test("onDeliveryResult does not fire for a retryable outcome", async () => {
    const root = tempDir();
    const config = relayConfig(path.join(root, "state.sqlite"), ["a", "b"], [
      { account: "b", room: "out" },
    ]);
    let calls = 0;
    const { host, state } = createHost(config, {
      deliveryIntervalMs: 10,
      spawnAdapter: fakeAdapter(() => ({
        state: "retryable",
        retryAfterMs: 60_000,
        detail: "try later",
      })),
      onDeliveryResult: () => {
        calls += 1;
      },
    });

    try {
      await host.start();
      await host.ingest(messageEvent("result-retry"));
      await waitFor(() => {
        const delivery = state().listDeliveries()[0];
        return delivery?.state === "retryable"
          && state().listReceipts(delivery.deliveryId).length === 1;
      });
      await Bun.sleep(100);
      expect(calls).toBe(0);
    } finally {
      await host.stop();
    }
  });
});