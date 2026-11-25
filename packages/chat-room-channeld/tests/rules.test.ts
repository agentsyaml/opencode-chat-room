import { describe, expect, test } from "bun:test";
import { parseConfig, type ChannelConfig } from "../src/config.ts";
import type { IngestEvent } from "../src/protocol.ts";
import { matchRules, renderForTarget } from "../src/rules.ts";

const SOURCE = { platform: "chatroom", accountId: "lab", roomId: "translation" };

function config(rules: unknown[]): ChannelConfig {
  return parseConfig({
    stateFile: "./unused.sqlite",
    accounts: [{ id: "lab", platform: "chatroom", adapter: { command: ["true"] } }],
    rules,
  });
}

function event(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    schemaVersion: 1,
    eventId: overrides.eventId ?? "event-1",
    kind: overrides.kind ?? "message.created",
    source: overrides.source ?? SOURCE,
    actor: { platform: "chatroom", identityNamespace: "lab", nativeUserId: "alice" },
    sourceDedupKey: overrides.sourceDedupKey ?? "dedup-1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content: { text: "hello" },
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "relay",
    version: 1,
    from: { platform: "chatroom", account: "lab", room: "translation" },
    transforms: [],
    to: [{ platform: "chatroom", account: "lab", room: "out" }],
    ...overrides,
  };
}

describe("rule matching", () => {
  test("matches platform, account, room and optional event kind", () => {
    const parsed = config([rule({ from: { platform: "chatroom", account: "lab", room: "translation", event: "message.created" } })]);
    expect(matchRules(parsed, event())).toHaveLength(1);
    expect(matchRules(parsed, event({ kind: "message.forward_requested" }))).toHaveLength(0);
    expect(matchRules(parsed, event({ source: { ...SOURCE, roomId: "other" } }))).toHaveLength(0);
    expect(matchRules(parsed, event({ source: { ...SOURCE, accountId: "other" } }))).toHaveLength(0);
    expect(matchRules(parsed, event({ source: { ...SOURCE, platform: "other" } }))).toHaveLength(0);
  });

  test("only the highest version of each rule id matches", () => {
    const parsed = config([
      rule({ id: "b", version: 2 }),
      rule({ id: "a", version: 3 }),
      rule({ id: "a", version: 1 }),
    ]);
    const matched = matchRules(parsed, event({ kind: "anything" }));
    expect(matched.map((item) => `${item.id}@${item.version}`)).toEqual(["a@3", "b@2"]);
  });
});

describe("rendering", () => {
  test("applies transforms in config order", () => {
    const parsed = config([
      rule({ transforms: [{ op: "trim" }, { op: "prefix-source" }, { op: "truncate", max: 5 }] }),
    ]);
    const result = renderForTarget(parsed.rules[0]!, event({ content: { text: "  hello world  " } }), parsed.rules[0]!.to[0]!);
    expect(result).toEqual({ text: "[chat…" });
  });

  test("prefixes source and appends a quote preview", () => {
    const parsed = config([
      rule({ transforms: [{ op: "prefix-source" }, { op: "quote-preview" }] }),
    ]);
    const result = renderForTarget(
      parsed.rules[0]!,
      event({
        content: { text: "reply" },
        selectedMessage: { endpoint: SOURCE, nativeMessageId: "m-1", text: "quoted text" },
      }),
      parsed.rules[0]!.to[0]!,
    );
    expect(result.text).toBe("[chatroom/translation] reply\n> quoted text");
  });

  test("empty text degrades without running transforms", () => {
    const parsed = config([rule({ transforms: [{ op: "prefix-source" }] })]);
    const result = renderForTarget(parsed.rules[0]!, event({ content: {} }), parsed.rules[0]!.to[0]!);
    expect(result).toEqual({ text: "", degraded: "empty" });
  });
});