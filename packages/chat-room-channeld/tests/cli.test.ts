import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { RuleConfig } from "../src/config.ts";
import { openState } from "../src/state.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const roots: string[] = [];

function tempFile(name: string, content: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-cli-"));
  roots.push(root);
  const file = path.join(root, name);
  writeFileSync(file, content);
  return file;
}

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "channeld-cli-"));
  roots.push(root);
  return root;
}

function statusConfig(root: string, stateFile: string): string {
  const file = path.join(root, "channeld.yml");
  writeFileSync(
    file,
    [
      `stateFile: ${stateFile}`,
      "accounts:",
      "  - id: b",
      "    platform: mock",
      "    adapter: { command: [\"node\", \"mock.js\"] }",
      "rules: []",
    ].join("\n"),
  );
  return file;
}

function cli(args: string[]) {
  return spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env },
  });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("chat-room-channeld cli", () => {
  test("--version prints the package version", () => {
    const result = cli(["--version"]);
    const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`chat-room-channeld ${version}`);
  });

  test("--help exits zero and lists the config flag", () => {
    const result = cli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--config");
    expect(result.stdout).toContain("mock");
    expect(result.stdout).toContain("status");
  });

  test("check accepts a valid config and writes nothing", () => {
    const stateFile = path.join(tmpdir(), `channeld-unused-${process.pid}.sqlite`);
    const config = tempFile(
      "channeld.yml",
      [
        `stateFile: ${stateFile}`,
        "accounts:",
        "  - id: im-a",
        "    platform: dingtalk",
        "    adapter: { command: [\"node\", \"mock.js\"] }",
        "rules:",
        "  - id: project-in",
        "    version: 1",
        "    from: { platform: chatroom, account: lab, room: activation }",
        "    to: [{ platform: dingtalk, account: im-a, room: project }]",
      ].join("\n"),
    );
    const result = cli(["check", "--config", config]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("config ok: 1 accounts, 1 rules");
  });

  test("check rejects account ids containing a slash", () => {
    const config = tempFile(
      "channeld.yml",
      [
        "stateFile: ./state.sqlite",
        "accounts:",
        "  - id: im/a",
        "    platform: dingtalk",
        "    adapter: { command: [\"node\", \"mock.js\"] }",
        "rules: []",
      ].join("\n"),
    );
    const result = cli(["check", "--config", config]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("accounts[0].id");
    expect(result.stderr).toContain("must match");
    expect(result.stderr).toContain('"/" is not allowed');
  });

  test("check rejects a bad config with a stderr message", () => {
    const config = tempFile(
      "channeld.yml",
      ["stateFile: ./state.sqlite", "accounts:", "  - id: im-a", "    platform: dingtalk"].join("\n"),
    );
    const result = cli(["check", "--config", config]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("config");
  });

  test("status prints counts JSON without writing the state file", () => {
    const root = tempDir();
    const stateFile = path.join(root, "state.sqlite");
    const state = openState(stateFile);
    state.commitIngest({
      schemaVersion: 1,
      eventId: "evt-cli",
      kind: "message.created",
      source: { platform: "mock", accountId: "a", roomId: "room-secret-source" },
      actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
      sourceDedupKey: "evt-cli",
      receivedAt: new Date().toISOString(),
      content: { text: "payload-secret message text" },
    });
    state.commitIngest({
      schemaVersion: 1,
      eventId: "evt-cli-orphan",
      kind: "message.created",
      source: { platform: "mock", accountId: "a", roomId: "room-secret-source" },
      actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
      sourceDedupKey: "evt-cli-orphan",
      receivedAt: new Date().toISOString(),
      content: { text: "payload-secret message text" },
    });
    const rule: RuleConfig = {
      id: "rule-secret",
      version: 1,
      from: { platform: "mock", account: "a", room: "room-secret-source" },
      transforms: [],
      to: [{ platform: "mock", account: "b", room: "room-secret-target" }],
      onMissingParent: "quote_or_unthreaded",
      onUnsupported: "text_with_notice",
    };
    state.enqueueDeliveries(
      "evt-cli",
      rule,
      [{ platform: "mock", account: "b", room: "room-secret-target" }],
      [JSON.stringify({ text: "payload-secret message text" })],
    );
    state.close();

    const config = statusConfig(root, stateFile);
    const before = statSync(stateFile);
    const result = cli(["status", "--config", config]);
    const after = statSync(stateFile);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const stats = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(stats)).toEqual([
      "generatedAt",
      "events",
      "publishedResults",
      "eventsWithoutDeliveries",
      "deliveriesWithoutEvent",
      "receiptsWithoutDelivery",
      "deliveries",
      "queueDepth",
      "oldestBacklogAt",
      "oldestBacklogAgeMs",
      "accounts",
    ]);
    expect(stats.events).toBe(2);
    expect(stats.eventsWithoutDeliveries).toBe(1);
    expect(stats.queueDepth).toBe(1);
    expect(stats.accounts).toEqual([
      expect.objectContaining({ account: "mock/b", queueDepth: 1 }),
    ]);
    expect(result.stdout).not.toContain("payload-secret");
    expect(result.stdout).not.toContain("room-secret");
    expect(result.stdout).not.toContain("rule-secret");
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("status exits 1 when the state file is missing and does not create it", () => {
    const root = tempDir();
    const stateFile = path.join(root, "missing.sqlite");
    const config = statusConfig(root, stateFile);
    const result = cli(["status", "--config", config]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`chat-room-channeld: channel state not found: ${stateFile}`);
    expect(existsSync(stateFile)).toBe(false);
  });

  test("status exits 1 for a state file without channel tables", () => {
    const root = tempDir();
    const stateFile = path.join(root, "empty.sqlite");
    writeFileSync(stateFile, "");
    const config = statusConfig(root, stateFile);
    const before = statSync(stateFile);
    const result = cli(["status", "--config", config]);
    const after = statSync(stateFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`chat-room-channeld: channel state not found: ${stateFile}`);
    expect(after.size).toBe(before.size);
  });

  test("unknown flags are usage errors", () => {
    const result = cli(["--nope"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument");
  });
});