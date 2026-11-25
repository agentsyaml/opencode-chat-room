import { describe, expect, test } from "bun:test";
import { IngestGate, type IngestResult } from "../src/ingest-gate.ts";
import type { IngestEvent } from "../src/protocol.ts";

function event(eventId: string): IngestEvent {
  return {
    schemaVersion: 1,
    eventId,
    kind: "message.created",
    source: { platform: "mock", accountId: "a", roomId: "in" },
    actor: { platform: "mock", identityNamespace: "mock", nativeUserId: "u1" },
    sourceDedupKey: eventId,
    receivedAt: new Date().toISOString(),
    content: { text: eventId },
  };
}

describe("ingest gate", () => {
  test("an echo between two concurrent sends waits for both sends", async () => {
    const processed: string[] = [];
    const gate = new IngestGate(() => {});
    const process = async (item: IngestEvent): Promise<IngestResult> => {
      processed.push(item.eventId);
      return { duplicate: false };
    };

    gate.begin("a");
    const first = gate.run("a", event("first"), process);
    gate.begin("a");
    const echo = gate.run("a", event("echo"), process);
    const last = gate.run("a", event("last"), process);

    await gate.finish("a", process);
    expect(processed).toEqual([]);

    await gate.finish("a", process);
    expect(processed).toEqual(["first", "echo", "last"]);
    expect(await first).toEqual({ duplicate: false });
    expect(await echo).toEqual({ duplicate: false });
    expect(await last).toEqual({ duplicate: false });
  });

  test("overflow invokes the owner once and rejects the extra event", async () => {
    const overflows: string[] = [];
    const gate = new IngestGate((accountId) => overflows.push(accountId));
    const process = async (): Promise<IngestResult> => ({ duplicate: false });
    gate.begin("a");
    const pending = Array.from({ length: 100 }, (_, index) =>
      gate.run("a", event(`e-${index}`), process),
    );
    await expect(gate.run("a", event("overflow"), process)).rejects.toThrow(
      "ingest buffer overflow for account a",
    );
    expect(overflows).toEqual(["a"]);
    await gate.finish("a", process);
    await Promise.all(pending);
  });
});