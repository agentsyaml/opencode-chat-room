import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { validateTargets } from "../src/host-helpers.ts";
import { inboundRoomText, matchInboundRoutes } from "../src/inbound.ts";
import type { IngestEvent } from "../src/protocol.ts";

function config(inbound: unknown) {
  return parseConfig({
    stateFile: "state.sqlite",
    accounts: [{ id: "feishu-main", platform: "feishu", adapter: { command: ["unused"] } }],
    inbound,
  });
}

function event(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    schemaVersion: 1,
    eventId: "feishu-main-evt-1",
    kind: "message.created",
    source: { platform: "feishu", accountId: "feishu-main", roomId: "oc_allowed" },
    actor: { platform: "feishu", identityNamespace: "open_id", nativeUserId: "ou_alice" },
    providerEventId: "evt-1",
    sourceDedupKey: "feishu:feishu-main:evt-1",
    receivedAt: new Date(0).toISOString(),
    content: { text: "hello" },
    ...overrides,
  };
}

describe("inbound routes", () => {
  test("parse, match, and render an allowlisted source", () => {
    const parsed = config([{ from: { platform: "feishu", account: "feishu-main", room: "oc_allowed" }, to: { room: "lab" } }]);
    expect(parsed.inbound).toHaveLength(1);
    expect(validateTargets(parsed)).toBeUndefined();
    expect(matchInboundRoutes(parsed, event())).toHaveLength(1);
    expect(matchInboundRoutes(parsed, event({ source: { ...event().source, roomId: "oc_other" } }))).toHaveLength(0);
    expect(inboundRoomText(event(), parsed.inbound[0]!)).toBe("[Feishu feishu-main] ou_alice: hello");
  });

  test("event kind and platform filters are honored", () => {
    const parsed = config([{
      from: { platform: "feishu", account: "feishu-main", room: "oc_allowed", event: "message.created" },
      to: { room: "lab" },
    }]);
    expect(matchInboundRoutes(parsed, event())).toHaveLength(1);
    expect(matchInboundRoutes(parsed, event({ kind: "message.updated" }))).toHaveLength(0);
    expect(matchInboundRoutes(parsed, event({ source: { ...event().source, platform: "mock" } }))).toHaveLength(0);
  });

  test("an unknown source account or platform mismatch is rejected", () => {
    const missing = config([{ from: { platform: "feishu", account: "missing", room: "oc_allowed" }, to: { room: "lab" } }]);
    expect(() => validateTargets(missing)).toThrow(/unknown account/);
    const parsed = config([{ from: { platform: "mock", account: "feishu-main", room: "oc_allowed" }, to: { room: "lab" } }]);
    expect(() => validateTargets(parsed)).toThrow(/sources platform/);
  });

  test("a room target requires a non-empty id", () => {
    expect(() => config([{ from: { platform: "feishu", account: "feishu-main", room: "oc_allowed" }, to: {} }]))
      .toThrow(/to.room/);
  });
});