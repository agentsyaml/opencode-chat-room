import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdapterProcess } from "../src/adapter.ts";
import { parseConfig } from "../src/config.ts";
import { ChannelHost } from "../src/host.ts";
import { openState, readChannelStats } from "../src/state.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-account-runtime-"));
  roots.push(root);
  return root;
}

const ENV_ADAPTER = `
import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "initialize" && process.env.ENV_OUT) {
      writeFileSync(process.env.ENV_OUT, JSON.stringify({
        inherited: process.env.CHANNELD_TEST_INHERITED,
        custom: process.env.CUSTOM_VALUE,
        accountId: process.env.CHANNELD_ACCOUNT_ID,
        platform: process.env.CHANNELD_PLATFORM,
      }));
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { version: 1, eventSchema: 1, maxFrameBytes: 1048576, accounts: {} },
    }) + "\\n");
    newline = buffer.indexOf("\\n");
  }
});
setInterval(() => {}, 1000);
`;

const MISMATCH_ADAPTER = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { version: 1, eventSchema: 1, maxFrameBytes: 1048576, accounts: {}, platform: "other" },
    }) + "\\n");
    newline = buffer.indexOf("\\n");
  }
});
setInterval(() => {}, 1000);
`;

describe("account runtime", () => {
  test("account env reaches the adapter but never overrides CHANNELD keys", async () => {
    const root = tempDir();
    const script = path.join(root, "env-adapter.js");
    const out = path.join(root, "env.json");
    writeFileSync(script, ENV_ADAPTER);

    const account = {
      id: "acct",
      platform: "mock",
      adapter: { command: [process.execPath, script] },
      env: {
        ENV_OUT: out,
        CUSTOM_VALUE: "custom",
        CHANNELD_ACCOUNT_ID: "spoofed",
        CHANNELD_PLATFORM: "spoofed",
      },
    };
    const adapter = new AdapterProcess({
      account,
      onIngest: async () => ({ duplicate: false }),
      onExit: () => {},
      initializeTimeoutMs: 3000,
    });

    const previous = process.env.CHANNELD_TEST_INHERITED;
    process.env.CHANNELD_TEST_INHERITED = "inherited";
    try {
      await adapter.start();
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        inherited: "inherited",
        custom: "custom",
        accountId: "acct",
        platform: "mock",
      });
    } finally {
      await adapter.stop();
      if (previous === undefined) delete process.env.CHANNELD_TEST_INHERITED;
      else process.env.CHANNELD_TEST_INHERITED = previous;
    }
  });

  test("config validation bounds env keys and rejects reserved names", () => {
    const base = {
      stateFile: "state.sqlite",
      accounts: [
        {
          id: "a",
          platform: "mock",
          adapter: { command: ["unused"] },
          env: { FEISHU_APP_ID: "id", FEISHU_APP_SECRET: "secret" },
        },
      ],
      rules: [],
    };
    expect(parseConfig(base).accounts[0]?.env).toEqual({
      FEISHU_APP_ID: "id",
      FEISHU_APP_SECRET: "secret",
    });

    const withEnv = (env: unknown) => ({
      ...base,
      accounts: [{ ...base.accounts[0], env }],
    });
    expect(() => parseConfig(withEnv({ "1BAD": "x" }))).toThrow("must match");
    expect(() => parseConfig(withEnv({ GOOD: 1 }))).toThrow("must be a string");
    expect(() => parseConfig(withEnv({ CHANNELD_PLATFORM: "other" }))).toThrow("reserved");
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`KEY_${index}`, "x"]),
    );
    expect(() => parseConfig(withEnv(tooMany))).toThrow("at most 64");
  });

  test("a platform mismatch disables only that account and reports started/failed", async () => {
    const root = tempDir();
    const mismatchScript = path.join(root, "mismatch-adapter.js");
    writeFileSync(mismatchScript, MISMATCH_ADAPTER);
    const stateFile = path.join(root, "state.sqlite");
    const config = parseConfig({
      stateFile,
      accounts: [
        { id: "broken", platform: "mock", adapter: { command: [process.execPath, mismatchScript] } },
        {
          id: "healthy",
          platform: "mock",
          adapter: { command: ["bun", path.resolve(import.meta.dir, "../src/mock-adapter.ts")] },
        },
      ],
      rules: [],
    });

    const host = new ChannelHost(config);
    try {
      await host.start();
      expect(host.disabledAccounts).toEqual(["broken"]);
      expect(host.targetStatus("mock", "healthy")).toBe("ready");
      expect(host.targetStatus("mock", "broken")).toBe("disabled");

      const states = host.accountRuntimeStates;
      expect(states.get("mock/broken")?.state).toBe("failed");
      expect(states.get("mock/broken")?.lastError).toContain('reported platform "other"');
      expect(states.get("mock/healthy")?.state).toBe("started");

      const stats = readChannelStats(stateFile, Date.now(), states);
      const byAccount = new Map(stats.accounts.map((account) => [account.account, account]));
      expect(byAccount.get("mock/broken")?.state).toBe("failed");
      expect(byAccount.get("mock/broken")?.lastError).toContain("reported platform");
      expect(byAccount.get("mock/healthy")?.state).toBe("started");
      expect(byAccount.get("mock/broken")?.queueDepth).toBe(0);
    } finally {
      await host.stop();
    }
  });

  test("status runtime details are short, single-line, and redacted", () => {
    const root = tempDir();
    const file = path.join(root, "state.sqlite");
    openState(file).close();
    const state = readChannelStats(file, Date.now(), new Map([[
      "mock/a",
      { state: "failed", lastError: "token=supersecret\nsecond line " + "x".repeat(500) },
    ]]));
    const account = state.accounts.find((item) => item.account === "mock/a");
    expect(account?.state).toBe("failed");
    expect(account?.lastError).not.toContain("supersecret");
    expect(account?.lastError).not.toContain("\n");
    expect(account?.lastError?.length).toBeLessThanOrEqual(200);
  });
});