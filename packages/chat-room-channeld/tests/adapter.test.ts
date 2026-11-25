import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { AdapterProcess } from "../src/adapter.ts";
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