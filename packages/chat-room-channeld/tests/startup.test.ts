import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdapterProcess } from "../src/adapter.ts";
import { parseConfig } from "../src/config.ts";
import { ChannelHost } from "../src/host.ts";
import { openState, type ChannelState } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-startup-"));
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

describe("parallel adapter startup", () => {
  test("a fast account delivers while a slow account is still timing out", async () => {
    const root = tempDir();
    const slowScript = path.join(root, "never-ready.js");
    const adapterPath = path.resolve(import.meta.dir, "../src/mock-adapter.ts");
    writeFileSync(slowScript, "setInterval(() => {}, 1000);\n");
    const config = parseConfig({
      stateFile: path.join(root, "state.sqlite"),
      accounts: [
        { id: "fast", platform: "mock", adapter: { command: ["bun", adapterPath] } },
        { id: "slow", platform: "mock", adapter: { command: [process.execPath, slowScript] } },
      ],
      rules: [
        {
          id: "relay",
          version: 1,
          from: { platform: "mock", account: "fast", room: "in" },
          transforms: [],
          to: [{ platform: "mock", account: "fast", room: "out" }],
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
      spawnAdapter: (account, context) => new AdapterProcess({
        account,
        ...context,
        initializeTimeoutMs: account.id === "slow" ? 2000 : 5000,
      }),
    });

    const previousEmit = process.env.CHANNELD_MOCK_EMIT;
    process.env.CHANNELD_MOCK_EMIT = "1";
    let startResolved = false;
    try {
      const starting = host.start();
      void starting.then(() => {
        startResolved = true;
      });

      await waitFor(() => {
        const deliveries = state!.listDeliveries();
        return deliveries.length === 1 && deliveries[0]?.state === "sent";
      }, 3000);
      expect(startResolved).toBe(false);
      expect(host.disabledAccounts).not.toContain("slow");

      await starting;
      expect(host.disabledAccounts).toContain("slow");
      expect(host.disabledAccounts).not.toContain("fast");
      expect(state!.listDeliveries()[0]?.state).toBe("sent");
    } finally {
      await host.stop();
      if (previousEmit === undefined) delete process.env.CHANNELD_MOCK_EMIT;
      else process.env.CHANNELD_MOCK_EMIT = previousEmit;
    }
  });
});