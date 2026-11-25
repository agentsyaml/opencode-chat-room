import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.ts";
import { ChannelHost } from "../src/host.ts";
import { openState, type ChannelState } from "../src/state.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-host-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

describe("channel host", () => {
  test("relays a mock event, dedupes a repeat ingest, and rejects bad forward events", async () => {
    const root = tempDir();
    const stateFile = path.join(root, "state.sqlite");
    const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");
    const config = parseConfig({
      stateFile,
      accounts: [
        {
          id: "a",
          platform: "mock",
          adapter: { command: ["bun", adapterPath], runtime: "bun" },
        },
        {
          id: "b",
          platform: "mock",
          adapter: { command: ["bun", adapterPath], runtime: "bun" },
        },
      ],
      rules: [
        {
          id: "relay",
          version: 1,
          from: { platform: "mock", account: "a", room: "in" },
          transforms: [{ op: "prefix-source" }],
          to: [{ platform: "mock", account: "b", room: "out" }],
        },
      ],
    });

    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 40,
    });

    const previousEmit = process.env.CHANNELD_MOCK_EMIT;
    process.env.CHANNELD_MOCK_EMIT = "1";
    try {
      await host.start();
      const channelState = state!;
      await waitFor(() => {
        const deliveries = channelState.listDeliveries();
        const delivery = deliveries[0];
        return deliveries.length === 1
          && delivery?.state === "sent"
          && channelState.listReceipts(delivery.deliveryId).length === 1;
      });

      const delivery = channelState.listDeliveries()[0]!;
      expect(delivery.target).toBe("mock/b/out");
      expect(delivery.ruleId).toBe("relay");
      expect(delivery.ruleVersion).toBe(1);
      expect(JSON.parse(delivery.payload)).toEqual({ text: "[mock/in] hello from mock" });
      expect(channelState.listReceipts(delivery.deliveryId)[0]?.state).toBe("sent");

      const duplicate = await host.ingest({
        schemaVersion: 1,
        eventId: "manual-duplicate",
        kind: "message.created",
        source: { platform: "mock", accountId: "a", roomId: "in" },
        actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
        sourceDedupKey: "mock:a:hello-from-mock",
        receivedAt: new Date().toISOString(),
        content: { text: "hello again" },
      });
      expect(duplicate).toEqual({ duplicate: true, eventId: "mock-event-a" });
      await Bun.sleep(100);
      expect(channelState.listDeliveries()).toHaveLength(1);

      const before = channelState.listDeliveries().length;
      const missing = await host.ingest({
        schemaVersion: 1,
        eventId: "forward-missing",
        kind: "message.forward_requested",
        source: { platform: "mock", accountId: "a", roomId: "in" },
        actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
        sourceDedupKey: "forward-missing",
        receivedAt: new Date().toISOString(),
        content: { text: "forward me" },
      });
      expect(missing.duplicate).toBe(false);

      const outside = await host.ingest({
        schemaVersion: 1,
        eventId: "forward-outside",
        kind: "message.forward_requested",
        source: { platform: "mock", accountId: "a", roomId: "in" },
        actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
        sourceDedupKey: "forward-outside",
        receivedAt: new Date().toISOString(),
        content: { text: "forward me" },
        selectedMessage: {
          endpoint: { platform: "mock", accountId: "b", roomId: "in" },
          nativeMessageId: "native-1",
        },
      });
      expect(outside.duplicate).toBe(false);
      await Bun.sleep(100);
      expect(channelState.listDeliveries()).toHaveLength(before);
    } finally {
      await host.stop();
      if (previousEmit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previousEmit;
    }
  });

  test("a failed adapter disables only its account and leaves its deliveries pending", async () => {
    const root = tempDir();
    const stateFile = path.join(root, "state.sqlite");
    const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");
    const config = parseConfig({
      stateFile,
      accounts: [
        {
          id: "a",
          platform: "mock",
          adapter: { command: ["bun", adapterPath], runtime: "bun" },
        },
        {
          id: "b",
          platform: "mock",
          adapter: { command: [process.execPath, "-e", "process.exit(1)"], runtime: "bun" },
        },
      ],
      rules: [
        {
          id: "fanout",
          version: 1,
          from: { platform: "mock", account: "a", room: "in" },
          transforms: [{ op: "prefix-source" }],
          to: [
            { platform: "mock", account: "a", room: "out" },
            { platform: "mock", account: "b", room: "out" },
          ],
        },
      ],
    });

    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 40,
    });

    const previousEmit = process.env.CHANNELD_MOCK_EMIT;
    process.env.CHANNELD_MOCK_EMIT = "1";
    try {
      await host.start();
      expect(host.disabledAccounts).toContain("b");
      expect(host.disabledAccounts).not.toContain("a");

      const channelState = state!;
      await waitFor(() => {
        const deliveries = channelState.listDeliveries();
        const sent = deliveries.find((delivery) => delivery.target === "mock/a/out");
        const paused = deliveries.find((delivery) => delivery.target === "mock/b/out");
        return deliveries.length === 2
          && sent?.state === "sent"
          && paused?.state === "paused"
          && channelState.listReceipts(sent.deliveryId).length === 1;
      });

      const sent = channelState.listDeliveries().find((delivery) => delivery.target === "mock/a/out")!;
      const paused = channelState.listDeliveries().find((delivery) => delivery.target === "mock/b/out")!;
      expect(sent.state).toBe("sent");
      expect(channelState.listReceipts(sent.deliveryId)).toHaveLength(1);
      expect(paused.state).toBe("paused");
      expect(paused.attemptCount).toBe(0);
      expect(channelState.nextPendingDelivery("mock/a", Date.now())).toBeUndefined();
      await host.stop();
    } finally {
      await host.stop();
      if (previousEmit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previousEmit;
    }
  });

  test("polluted adapter stdout disables only its account", async () => {
    const root = tempDir();
    const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");
    const polluter = path.join(root, "polluter.js");
    writeFileSync(
      polluter,
      `
process.stdout.write("log line without newline");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const newline = buffer.indexOf("\\n");
  if (newline === -1) return;
  const request = JSON.parse(buffer.slice(0, newline));
  buffer = buffer.slice(newline + 1);
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: { version: 1, eventSchema: 1, maxFrameBytes: 1048576, accounts: {} }
  }) + "\\n");
});
setInterval(() => {}, 1000);
`,
    );
    const config = parseConfig({
      stateFile: path.join(root, "state.sqlite"),
      accounts: [
        { id: "a", platform: "mock", adapter: { command: ["bun", adapterPath] } },
        { id: "b", platform: "mock", adapter: { command: [process.execPath, polluter] } },
      ],
      rules: [
        {
          id: "fanout",
          version: 1,
          from: { platform: "mock", account: "a", room: "in" },
          transforms: [{ op: "prefix-source" }],
          to: [
            { platform: "mock", account: "a", room: "out" },
            { platform: "mock", account: "b", room: "out" },
          ],
        },
      ],
    });

    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 40,
    });

    const previousEmit = process.env.CHANNELD_MOCK_EMIT;
    process.env.CHANNELD_MOCK_EMIT = "1";
    try {
      await host.start();
      expect(host.disabledAccounts).toContain("b");
      const channelState = state!;
      await waitFor(() => {
        const deliveries = channelState.listDeliveries();
        return deliveries.length === 2
          && deliveries.some((delivery) => delivery.target === "mock/a/out" && delivery.state === "sent")
          && deliveries.some((delivery) => delivery.target === "mock/b/out" && delivery.state === "paused");
      });
      expect(channelState.listDeliveries().find((delivery) => delivery.target === "mock/b/out")?.state).toBe("paused");
    } finally {
      await host.stop();
      if (previousEmit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previousEmit;
    }
  });

  test("only the highest rule version produces a delivery", async () => {
    const root = tempDir();
    const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");
    const config = parseConfig({
      stateFile: path.join(root, "state.sqlite"),
      accounts: [
        { id: "a", platform: "mock", adapter: { command: ["bun", adapterPath] } },
        { id: "b", platform: "mock", adapter: { command: ["bun", adapterPath] } },
      ],
      rules: [
        {
          id: "relay",
          version: 1,
          from: { platform: "mock", account: "a", room: "in" },
          transforms: [{ op: "prefix-source" }],
          to: [{ platform: "mock", account: "b", room: "out" }],
        },
        {
          id: "relay",
          version: 2,
          from: { platform: "mock", account: "a", room: "in" },
          transforms: [],
          to: [{ platform: "mock", account: "b", room: "out" }],
        },
      ],
    });

    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 40,
    });

    const previousEmit = process.env.CHANNELD_MOCK_EMIT;
    process.env.CHANNELD_MOCK_EMIT = "1";
    try {
      await host.start();
      const channelState = state!;
      await waitFor(() => {
        const deliveries = channelState.listDeliveries();
        return deliveries.length === 1 && deliveries[0]?.state === "sent";
      });
      const delivery = channelState.listDeliveries()[0]!;
      expect(delivery.ruleId).toBe("relay");
      expect(delivery.ruleVersion).toBe(2);
      expect(JSON.parse(delivery.payload)).toEqual({ text: "hello from mock" });
    } finally {
      await host.stop();
      if (previousEmit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previousEmit;
    }
  });

  test("applies onUnsupported and onMissingParent policies", async () => {
    const root = tempDir();
    const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");
    const from = { platform: "mock", account: "a", room: "in" };
    const to = [{ platform: "mock", account: "b", room: "out" }];
    const config = parseConfig({
      stateFile: path.join(root, "state.sqlite"),
      accounts: [
        { id: "a", platform: "mock", adapter: { command: ["bun", adapterPath] } },
        { id: "b", platform: "mock", adapter: { command: ["bun", adapterPath] } },
      ],
      rules: [
        {
          id: "empty-drop",
          version: 1,
          from,
          transforms: [],
          to,
          onUnsupported: "drop",
          onMissingParent: "drop",
        },
        {
          id: "empty-notice",
          version: 1,
          from,
          transforms: [],
          to,
          onUnsupported: "text_with_notice",
          onMissingParent: "drop",
        },
        {
          id: "parent-drop",
          version: 1,
          from,
          transforms: [],
          to,
          onUnsupported: "drop",
          onMissingParent: "drop",
        },
        {
          id: "parent-unthread",
          version: 1,
          from,
          transforms: [],
          to,
          onUnsupported: "drop",
          onMissingParent: "quote_or_unthreaded",
        },
      ],
    });

    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 40,
    });

    const previousEmit = process.env.CHANNELD_MOCK_EMIT;
    delete process.env.CHANNELD_MOCK_EMIT;
    try {
      await host.start();
      await host.ingest({
        schemaVersion: 1,
        eventId: "empty-event",
        kind: "message.created",
        source: { platform: "mock", accountId: "a", roomId: "in" },
        actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
        sourceDedupKey: "empty-event",
        receivedAt: new Date().toISOString(),
        content: { text: "" },
      });
      await host.ingest({
        schemaVersion: 1,
        eventId: "reply-event",
        kind: "message.created",
        source: { platform: "mock", accountId: "a", roomId: "in" },
        actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
        sourceDedupKey: "reply-event",
        receivedAt: new Date().toISOString(),
        content: { text: "reply" },
        parent: {
          endpoint: { platform: "mock", accountId: "a", roomId: "in" },
          nativeMessageId: "native-parent",
        },
      });

      const deliveries = state!.listDeliveries();
      expect(deliveries).toHaveLength(2);
      const notice = deliveries.find((delivery) => delivery.ruleId === "empty-notice")!;
      expect(JSON.parse(notice.payload)).toEqual({
        text: "attachment/format unsupported",
        degraded: "empty",
      });
      const unthreaded = deliveries.find((delivery) => delivery.ruleId === "parent-unthread")!;
      expect(JSON.parse(unthreaded.payload)).toEqual({ text: "reply", degraded: "unthreaded" });
      expect(deliveries.some((delivery) => delivery.ruleId === "empty-drop")).toBe(false);
      expect(deliveries.some((delivery) => delivery.ruleId === "parent-drop")).toBe(false);
    } finally {
      await host.stop();
      if (previousEmit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previousEmit;
    }
  });
});