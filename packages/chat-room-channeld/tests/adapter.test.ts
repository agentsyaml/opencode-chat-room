import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { AdapterProcess, adapterChildEnv } from "../src/adapter.ts";
import type { AccountConfig } from "../src/config.ts";
import { AdapterGoneError, writeFrame } from "../src/framing.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-adapter-"));
  roots.push(root);
  return root;
}

const POLLUTING_ADAPTER = `
process.stdout.write("this is a log line without a newline");
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
`;

describe("adapter stdout isolation", () => {
  test("polluted stdout rejects initialization with the protocol hint", async () => {
    const root = tempDir();
    const script = path.join(root, "polluting-adapter.js");
    writeFileSync(script, POLLUTING_ADAPTER);
    const account: AccountConfig = {
      id: "polluter",
      platform: "mock",
      adapter: { command: [process.execPath, script] },
    };
    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    const adapter = new AdapterProcess({
      account,
      onIngest: async () => ({ duplicate: false }),
      onExit: (code, signal) => exits.push([code, signal]),
      initializeTimeoutMs: 2000,
    });

    let message = "";
    try {
      await adapter.start();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("wrote non-protocol output to stdout");
    expect(message).toContain("logs must go to stderr");
    expect(exits).toEqual([]);
    await adapter.stop();
  });

  test("writing after an adapter stream stops returns a typed error", () => {
    const ended = new PassThrough();
    ended.end();
    expect(() => writeFrame(ended, { ping: true })).toThrow(AdapterGoneError);

    const destroyed = new PassThrough();
    destroyed.destroy();
    expect(() => writeFrame(destroyed, { ping: true })).toThrow(AdapterGoneError);
  });
});
const PROBE_ADAPTER = `
const fs = require("node:fs");
const marker = process.env.PROBE_START_MARKER;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "start") fs.writeFileSync(marker, "started");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      result: request.method === "initialize"
        ? {
            version: 1, eventSchema: 1, platform: "probe-platform", maxFrameBytes: 1048576,
            accounts: { probe: { displayName: "Probe", account: { schema: [{ key: "TOKEN", type: "secret", required: true }] } } },
          }
        : { ready: true },
    }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;

describe("adapter probe", () => {
  test("initializes without start and reports platform and account schema", async () => {
    const root = tempDir();
    const script = path.join(root, "probe-adapter.js");
    const marker = path.join(root, "started");
    writeFileSync(script, PROBE_ADAPTER);
    const adapter = new AdapterProcess({
      account: {
        id: "probe",
        platform: "placeholder",
        adapter: { command: [process.execPath, script] },
        env: { PROBE_START_MARKER: marker },
      },
      onIngest: async () => ({ duplicate: false }),
      onExit: () => {},
      initializeTimeoutMs: 2000,
    });

    const probed = await adapter.probe();
    expect(probed.platform).toBe("probe-platform");
    expect(probed.capabilities?.displayName).toBe("Probe");
    expect(probed.capabilities?.account?.schema?.[0]?.key).toBe("TOKEN");
    expect(existsSync(marker)).toBe(false);
  });
});

const ENUM_ADAPTER = `
enum Mode { Ready = "ready" }
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const mode: Mode = Mode.Ready;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      result: request.method === "initialize"
        ? {
            version: 1, eventSchema: 1, platform: "enum-platform", maxFrameBytes: 1048576,
            accounts: { [process.env.CHANNELD_ACCOUNT_ID]: { displayName: "Enum " + mode } },
          }
        : { ready: true },
    }) + "\\n");
    newline = buffer.indexOf("\\n");
  }
});
setInterval(() => {}, 1000);
`;

describe("adapter TypeScript transform", () => {
  const node = Bun.which("node");

  test("a .ts adapter with enum starts and probes", async () => {
    if (!node) throw new Error("node is required to run the adapter TypeScript test");
    const root = tempDir();
    const script = path.join(root, "enum-adapter.ts");
    writeFileSync(script, ENUM_ADAPTER);
    const account = (id: string): AccountConfig => ({
      id,
      platform: "enum-platform",
      adapter: { command: [node, script] },
    });
    const serverOptions = process.env.NODE_OPTIONS;

    const probed = await new AdapterProcess({
      account: account("enum-probe"),
      onIngest: async () => ({ duplicate: false }),
      onExit: () => {},
      initializeTimeoutMs: 2000,
    }).probe();
    expect(probed.platform).toBe("enum-platform");
    expect(probed.capabilities?.displayName).toBe("Enum ready");

    const adapter = new AdapterProcess({
      account: account("enum-start"),
      onIngest: async () => ({ duplicate: false }),
      onExit: () => {},
      initializeTimeoutMs: 2000,
    });
    await adapter.start();
    expect(adapter.capabilities?.displayName).toBe("Enum ready");
    await adapter.stop();
    expect(process.env.NODE_OPTIONS).toBe(serverOptions);
  });

  test("adapter child env appends transform flags without duplicates", () => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--max-old-space-size=256 --experimental-transform-types";
    try {
      const env = adapterChildEnv({ id: "acct", platform: "mock", adapter: { command: ["unused"] } });
      expect(env.NODE_OPTIONS).toBe(
        "--max-old-space-size=256 --experimental-transform-types --disable-warning=ExperimentalWarning",
      );
      expect(env.CHANNELD_ACCOUNT_ID).toBe("acct");
      expect(process.env.NODE_OPTIONS).toBe("--max-old-space-size=256 --experimental-transform-types");
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });
});
