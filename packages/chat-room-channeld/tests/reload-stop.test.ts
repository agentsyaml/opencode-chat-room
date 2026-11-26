import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.ts";
import { ChannelHost, type AdapterHandle } from "../src/host.ts";
import { openState, type ChannelState } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-reload-stop-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

describe("reload stop", () => {
  test("an aborted in-flight send settles as unknown and is not resent", async () => {
    const root = tempDir();
    const stateFile = path.join(root, "state.sqlite");
    const config = parseConfig({
      stateFile,
      accounts: [{ id: "a", platform: "mock", adapter: { command: ["unused"] } }],
      rules: [{
        id: "relay",
        version: 1,
        from: { platform: "mock", account: "a", room: "in" },
        transforms: [],
        to: [{ platform: "mock", account: "a", room: "out" }],
      }],
    });
    let release: (() => void) | undefined;
    const adapter: AdapterHandle = {
      start: async () => {},
      send: () => new Promise((resolve) => {
        release = () => resolve({
          state: "sent",
          providerMessage: {
            endpoint: { platform: "mock", accountId: "a", roomId: "out" },
            nativeMessageId: "native-late",
          },
        });
      }),
      stop: async () => { release?.(); },
    };
    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 10,
      spawnAdapter: () => adapter,
    });
    await host.start();
    await host.ingest({
      schemaVersion: 1,
      eventId: "evt-reload",
      kind: "message.created",
      source: { platform: "mock", accountId: "a", roomId: "in" },
      actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
      sourceDedupKey: "evt-reload",
      receivedAt: new Date().toISOString(),
      content: { text: "hello" },
    });
    await waitFor(() => state!.listDeliveries()[0]?.state === "in_flight");
    await host.stop({ abortInFlight: true });

    const reader = openState(stateFile);
    const delivery = reader.listDeliveries()[0]!;
    expect(delivery.state).toBe("unknown");
    expect(delivery.lastError).toContain("relay runtime stopped");
    expect(reader.listReceipts(delivery.deliveryId).at(-1)?.state).toBe("unknown");
    reader.close();

    let nextState: ChannelState | undefined;
    const next = new ChannelHost(config, {
      stateFactory: (file) => {
        nextState = openState(file);
        return nextState;
      },
      deliveryIntervalMs: 10,
      spawnAdapter: () => adapter,
    });
    try {
      await next.start();
      await Bun.sleep(80);
      expect(nextState!.listDeliveries()[0]?.state).toBe("unknown");
    } finally {
      await next.stop();
    }
  });
});