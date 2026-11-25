import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.ts";
import { ChannelHost } from "../src/host.ts";
import { openState, type ChannelState } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-rpc-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

const EMITTER = `
let buffer = "";
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function emit() {
  const account = process.env.CHANNELD_ACCOUNT_ID;
  const source = { platform: "mock", accountId: account, roomId: "in" };
  const events = [["evt-1", "dup-a"], ["evt-2", "dup-b"], ["evt-3", "dup-a"]];
  for (const [eventId, dedupKey] of events) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: "adapter-dup",
      method: "ingest",
      params: {
        schemaVersion: 1,
        eventId,
        kind: "message.created",
        source,
        actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
        sourceDedupKey: dedupKey,
        receivedAt: new Date().toISOString(),
        content: { text: "same rpc id " + dedupKey }
      }
    }) + "\\n");
  }
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
      emit();
    } else if (message.method === "shutdown") {
      respond(message.id, {});
      process.exit(0);
    }
  }
});
setInterval(() => {}, 1000);
`;

describe("RPC ids are correlation only", () => {
  test("sourceDedupKey decides identity, not the repeated JSON-RPC id", async () => {
    const root = tempDir();
    const emitter = path.join(root, "emitter.js");
    writeFileSync(emitter, EMITTER);
    const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");
    const config = parseConfig({
      stateFile: path.join(root, "state.sqlite"),
      accounts: [
        { id: "emitter", platform: "mock", adapter: { command: [process.execPath, emitter] } },
        { id: "target", platform: "mock", adapter: { command: ["bun", adapterPath] } },
      ],
      rules: [
        {
          id: "relay",
          version: 1,
          from: { platform: "mock", account: "emitter", room: "in" },
          transforms: [],
          to: [{ platform: "mock", account: "target", room: "out" }],
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
      await waitFor(() => state!.listDeliveries().length === 2);
      await Bun.sleep(100);
      const deliveries = state!.listDeliveries();
      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((delivery) => delivery.target)).toEqual(["mock/target/out", "mock/target/out"]);
    } finally {
      await host.stop();
      if (previousEmit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previousEmit;
    }
  });
});