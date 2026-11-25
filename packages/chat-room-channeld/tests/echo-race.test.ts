import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdapterProcess } from "../src/adapter.ts";
import { parseConfig } from "../src/config.ts";
import { ChannelHost, type AdapterHandle } from "../src/host.ts";
import type { IngestEvent } from "../src/protocol.ts";
import { openState, type ChannelState } from "../src/state.ts";

const roots: string[] = [];
const iterations = 25;
const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-echo-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function messageEvent(eventId: string, accountId: string, roomId: string): IngestEvent {
  return {
    schemaVersion: 1,
    eventId,
    kind: "message.created",
    source: { platform: "mock", accountId, roomId },
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: eventId,
    receivedAt: new Date().toISOString(),
    content: { text: `message ${eventId}` },
  };
}

function echoConfig(stateFile: string) {
  return parseConfig({
    stateFile,
    accounts: [
      { id: "src", platform: "mock", adapter: { command: ["bun", adapterPath] } },
      { id: "im_b", platform: "mock", adapter: { command: ["bun", adapterPath] } },
    ],
    rules: [
      {
        id: "forward",
        version: 1,
        from: { platform: "mock", account: "src", room: "in" },
        transforms: [],
        to: [{ platform: "mock", account: "im_b", room: "out" }],
      },
      {
        id: "reverse",
        version: 1,
        from: { platform: "mock", account: "im_b", room: "out" },
        transforms: [],
        to: [{ platform: "mock", account: "src", room: "in" }],
      },
    ],
  });
}

async function runEchoLoop(delay: string | undefined): Promise<void> {
  const root = tempDir();
  const config = echoConfig(path.join(root, "state.sqlite"));
  let state: ChannelState | undefined;
  const host = new ChannelHost(config, {
    stateFactory: (file) => {
      state = openState(file);
      return state;
    },
    deliveryIntervalMs: 10,
  });

  const previous = {
    emit: process.env.CHANNELD_MOCK_EMIT,
    echo: process.env.CHANNELD_MOCK_ECHO,
    delay: process.env.CHANNELD_MOCK_ECHO_DELAY_MS,
  };
  delete process.env.CHANNELD_MOCK_EMIT;
  process.env.CHANNELD_MOCK_ECHO = "1";
  if (delay) process.env.CHANNELD_MOCK_ECHO_DELAY_MS = delay;
  else delete process.env.CHANNELD_MOCK_ECHO_DELAY_MS;

  try {
    await host.start();
    for (let index = 0; index < iterations; index++) {
      await host.ingest(messageEvent(`echo-${delay ?? "same"}-${index}`, "src", "in"));
      await waitFor(() => {
        const deliveries = state!.listDeliveries();
        return state!.countEvents() === index + 1
          && deliveries.length === index + 1
          && deliveries.every((delivery) => delivery.state === "sent");
      });
      expect(state!.countEvents()).toBe(index + 1);
      expect(state!.listDeliveries()).toHaveLength(index + 1);
    }
    const last = state!.listDeliveries().at(-1)!;
    const provider = JSON.parse(last.providerMessage ?? "null") as {
      nativeMessageId?: string;
    };
    expect(provider.nativeMessageId).toBeTruthy();
    expect(state!.findEcho("mock/im_b/out", provider.nativeMessageId!)).toBe(last.eventId);
  } finally {
    await host.stop();
    if (previous.emit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
    else process.env.CHANNELD_MOCK_EMIT = previous.emit;
    if (previous.echo === undefined) delete process.env.CHANNELD_MOCK_ECHO;
    else process.env.CHANNELD_MOCK_ECHO = previous.echo;
    if (previous.delay === undefined) delete process.env.CHANNELD_MOCK_ECHO_DELAY_MS;
    else process.env.CHANNELD_MOCK_ECHO_DELAY_MS = previous.delay;
  }
}

const CUSTOM_ADAPTER = `
const mode = process.env.CHANNELD_TEST_MODE;
let buffer = "";
let sequence = 0;
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function emitIngest(target, nativeMessageId, dedupKey, eventId) {
  const event = {
    schemaVersion: 1,
    eventId,
    kind: "message.created",
    source: { platform: target.platform, accountId: target.accountId, roomId: target.roomId },
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: dedupKey,
    message: { endpoint: target, nativeMessageId },
    receivedAt: new Date().toISOString(),
    content: { text: "custom adapter event " + eventId }
  };
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: "adapter-" + (++sequence), method: "ingest", params: event
  }) + "\\n");
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      respond(message.id, { version: 1, eventSchema: 1, maxFrameBytes: 1048576, accounts: {} });
    } else if (message.method === "start") {
      respond(message.id, { ready: true });
    } else if (message.method === "send") {
      const target = message.params.target;
      if (mode === "unknown") {
        emitIngest(target, "native-unknown", "unknown-dedup", "unknown-event");
        setTimeout(() => respond(message.id, { state: "unknown", detail: "test-unknown" }), 20);
      } else {
        for (let index = 1; index <= 101; index++) {
          emitIngest(target, "native-overflow-" + index, "overflow-" + index, "overflow-event-" + index);
        }
      }
    } else if (message.method === "shutdown") {
      respond(message.id, {});
      process.exit(0);
    }
  }
});
setInterval(() => {}, 1000);
`;

function customConfig(stateFile: string, adapter: string, reverse: boolean) {
  const rules = [
    {
      id: "forward",
      version: 1,
      from: { platform: "mock", account: "src", room: "in" },
      transforms: [],
      to: [{ platform: "mock", account: "im_b", room: "out" }],
    },
  ];
  if (reverse) {
    rules.push({
      id: "reverse",
      version: 1,
      from: { platform: "mock", account: "im_b", room: "out" },
      transforms: [],
      to: [{ platform: "mock", account: "src", room: "in" }],
    });
  }
  return parseConfig({
    stateFile,
    accounts: [
      { id: "src", platform: "mock", adapter: { command: ["bun", adapterPath] } },
      { id: "im_b", platform: "mock", adapter: { command: [process.execPath, adapter] } },
    ],
    rules,
  });
}

describe("echo race barrier", () => {
  test("same-chunk send result and echo stays one event and one delivery, 25 times", async () => {
    await runEchoLoop(undefined);
  });

  test("echo before a delayed send result stays one event and one delivery, 25 times", async () => {
    await runEchoLoop("50");
  });

  test("unknown send without provider message does not skip a buffered ingest", async () => {
    const root = tempDir();
    const adapter = path.join(root, "unknown-adapter.js");
    writeFileSync(adapter, CUSTOM_ADAPTER);
    const config = customConfig(path.join(root, "state.sqlite"), adapter, true);
    let state: ChannelState | undefined;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 10,
    });

    const previousMode = process.env.CHANNELD_TEST_MODE;
    process.env.CHANNELD_TEST_MODE = "unknown";
    try {
      await host.start();
      await host.ingest(messageEvent("initial-unknown", "src", "in"));
      await waitFor(() => state!.countEvents() === 2 && state!.listDeliveries().length === 2);
      expect(state!.findEcho("mock/im_b/out", "native-unknown")).toBeUndefined();
      expect(state!.listDeliveries().find((delivery) => delivery.target === "mock/im_b/out")?.state)
        .toBe("unknown");
    } finally {
      await host.stop();
      if (previousMode === undefined) delete process.env.CHANNELD_TEST_MODE;
      else process.env.CHANNELD_TEST_MODE = previousMode;
    }
  });

  test("ingest overflow isolates one account, keeps the other delivering, and pauses drained rows", async () => {
    const root = tempDir();
    const adapter = path.join(root, "overflow-adapter.js");
    writeFileSync(adapter, CUSTOM_ADAPTER);
    const config = parseConfig({
      stateFile: path.join(root, "state.sqlite"),
      accounts: [
        { id: "im_a", platform: "mock", adapter: { command: [process.execPath, adapter] } },
        { id: "im_b", platform: "mock", adapter: { command: ["bun", adapterPath] } },
      ],
      rules: [
        {
          id: "trigger",
          version: 1,
          from: { platform: "mock", account: "im_b", room: "in" },
          transforms: [],
          to: [{ platform: "mock", account: "im_a", room: "out" }],
        },
        {
          id: "side",
          version: 1,
          from: { platform: "mock", account: "im_b", room: "in" },
          transforms: [],
          to: [{ platform: "mock", account: "im_b", room: "out" }],
        },
        {
          id: "drain",
          version: 1,
          from: { platform: "mock", account: "im_a", room: "out" },
          transforms: [],
          to: [{ platform: "mock", account: "im_a", room: "in" }],
        },
      ],
    });

    let state: ChannelState | undefined;
    let stopCount = 0;
    const host = new ChannelHost(config, {
      stateFactory: (file) => {
        state = openState(file);
        return state;
      },
      deliveryIntervalMs: 10,
      spawnAdapter: (account, context) => {
        const inner = new AdapterProcess({ account, ...context });
        if (account.id !== "im_a") return inner;
        const wrapped: AdapterHandle = {
          start: () => inner.start(),
          send: (...args) => inner.send(...args),
          stop: () => {
            stopCount += 1;
            return inner.stop();
          },
        };
        return wrapped;
      },
    });

    const previous = {
      mode: process.env.CHANNELD_TEST_MODE,
      emit: process.env.CHANNELD_MOCK_EMIT,
      echo: process.env.CHANNELD_MOCK_ECHO,
      delay: process.env.CHANNELD_MOCK_ECHO_DELAY_MS,
    };
    process.env.CHANNELD_TEST_MODE = "overflow";
    process.env.CHANNELD_MOCK_EMIT = "1";
    delete process.env.CHANNELD_MOCK_ECHO;
    delete process.env.CHANNELD_MOCK_ECHO_DELAY_MS;

    const originalWrite = process.stderr.write;
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      await host.start();
      await waitFor(() => host.disabledAccounts.includes("im_a"));
      await waitFor(() => state!.countEvents() === 101);
      await waitFor(() => {
        const imA = state!.listDeliveries().filter((delivery) => delivery.target.startsWith("mock/im_a/"));
        return imA.filter((delivery) => delivery.state === "paused").length === 100;
      });
      await waitFor(() => {
        return state!.listDeliveries().some(
          (delivery) => delivery.target === "mock/im_b/out" && delivery.state === "sent",
        );
      });
      await waitFor(() => {
        return state!.listDeliveries().find((delivery) => delivery.target === "mock/im_a/out")?.state
          === "unknown";
      });

      const text = captured.join("");
      const lines = text.split("\n").filter(Boolean);
      expect(lines.filter((line) => line.includes("ingest buffer overflow")).length).toBe(1);
      expect(lines.filter((line) => line.includes("account im_a disabled:")).length).toBe(1);
      expect(text).not.toContain("unhandled rejection");
      expect(stopCount).toBe(1);
      expect(host.disabledAccounts).toContain("im_a");
      expect(host.disabledAccounts).not.toContain("im_b");

      const imA = state!.listDeliveries().filter((delivery) => delivery.target.startsWith("mock/im_a/"));
      expect(imA.filter((delivery) => delivery.state === "paused")).toHaveLength(100);
      expect(imA.some((delivery) => delivery.state === "pending")).toBe(false);
      expect(imA.some((delivery) => delivery.state === "in_flight")).toBe(false);
      expect(imA.find((delivery) => delivery.target === "mock/im_a/out")?.state).toBe("unknown");
      expect(state!.listDeliveries().find((delivery) => delivery.target === "mock/im_b/out")?.state)
        .toBe("sent");
      expect(state!.countEvents()).toBe(101);

      const after = await host.ingest(messageEvent("after-overflow", "im_b", "in"));
      expect(after.duplicate).toBe(false);
      expect(state!.countEvents()).toBe(102);
    } finally {
      process.stderr.write = originalWrite;
      await host.stop();
      if (previous.mode === undefined) delete process.env.CHANNELD_TEST_MODE;
      else process.env.CHANNELD_TEST_MODE = previous.mode;
      if (previous.emit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previous.emit;
      if (previous.echo === undefined) delete process.env.CHANNELD_MOCK_ECHO;
      else process.env.CHANNELD_MOCK_ECHO = previous.echo;
      if (previous.delay === undefined) delete process.env.CHANNELD_MOCK_ECHO_DELAY_MS;
      else process.env.CHANNELD_MOCK_ECHO_DELAY_MS = previous.delay;
    }
  });
});