import { describe, expect, test } from "bun:test";
import { admissionMatches, queueAdmissionId, type QueueBody } from "./queue";
import { explicitlyAddresses, explicitlyMentions } from "./mentions";
import { backgroundAtRegisteredService } from "./background";

const endpoint = { url: "http://127.0.0.1:54321", auth: { type: "basic" as const, username: "user", password: "secret" } };

function fakeApi(overrides: {
  discover?: () => Promise<typeof endpoint | undefined>;
  info?: () => Promise<{ pid: number; version: string }>;
  background?: () => Promise<void>;
  registered?: typeof endpoint;
} = {}) {
  const calls: unknown[][] = [];
  const api = {
    discover: overrides.discover ?? (async () => overrides.registered ?? endpoint),
    headers: (value: typeof endpoint) => ({ authorization: value.auth.password }),
    createClient: (baseUrl: string, headers?: Record<string, string>) => {
      calls.push(["client", baseUrl, headers]);
      return {
        server: { info: async (options: unknown) => { calls.push(["info", options]); return overrides.info ? overrides.info() : { pid: 42, version: "2.0.32" }; } },
        session: { background: async (input: unknown, options: unknown) => { calls.push(["background", input, options]); await overrides.background?.(); } },
      };
    },
    ...overrides,
  };
  return { api: api as Parameters<typeof backgroundAtRegisteredService>[2], calls };
}

describe("safe V2 background delivery", () => {
  test("backgrounds only the verified process at the exact registered custom port", async () => {
    const { api, calls } = fakeApi();
    expect((await backgroundAtRegisteredService("session", "2.0.32", api, 42)).status).toBe("done");
    expect(calls.find(([kind]) => kind === "background")?.[1]).toEqual({ sessionID: "session" });
    expect(calls[0]).toEqual(["client", "http://127.0.0.1:54321", { authorization: "secret" }]);
  });

  test.each([
    ["missing registration", { discover: async () => undefined }],
    ["wrong pid", { info: async () => ({ pid: 43, version: "2.0.32" }) }],
    ["wrong version", { info: async () => ({ pid: 42, version: "2.0.31" }) }],
    ["refused info", { info: async () => { throw Error("refused"); } }],
  ] as const)("does not background on %s", async (label, override) => {
    const { api, calls } = fakeApi(override);
    expect((await backgroundAtRegisteredService("session", "2.0.32", api, 42)).status)
      .toBe(label === "wrong pid" || label === "wrong version" ? "skip" : "failed");
    expect(calls.some(([kind]) => kind === "background")).toBe(false);
  });

  test("rejects non-loopback registration without probing it", async () => {
    const { api, calls } = fakeApi({ registered: { ...endpoint, url: "http://example.com:54321" } });
    expect((await backgroundAtRegisteredService("session", "2.0.32", api, 42)).status).toBe("skip");
    expect(calls).toHaveLength(0);
  });

  test("reports a rejected background API as failure", async () => {
    const { api, calls } = fakeApi({ background: async () => { throw Error("unauthorized"); } });
    expect((await backgroundAtRegisteredService("session", "2.0.32", api, 42)).status).toBe("failed");
    expect(calls.some(([kind]) => kind === "background")).toBe(true);
  });

  test("classifies timeout as failure and unsupported API as permanent skip", async () => {
    const timeout = Object.assign(Error("deadline"), { name: "TimeoutError" });
    const slow = fakeApi({ background: async () => { throw timeout; } });
    expect(await backgroundAtRegisteredService("session", "2.0.32", slow.api, 42)).toEqual({ status: "failed", reason: "timeout" });
    const missing = fakeApi({ background: async () => { throw Object.assign(Error("missing"), { status: 404 }); } });
    expect(await backgroundAtRegisteredService("session", "2.0.32", missing.api, 42)).toEqual({ status: "skip", reason: "unsupported-or-session-missing" });
  });

  test("keeps mention matching to explicit, non-self, non-event room messages", () => {
    const message = (text: string, senderId = "alice", senderSessionID?: string) => ({ senderId, senderSessionID, text, createdAt: 1 });
    expect(explicitlyMentions(message("hey @bob!"), "bob")).toBe(true);
    expect(explicitlyMentions(message("<at>@bob</at>"), "bob")).toBe(true);
    expect(explicitlyMentions(message(`${"x".repeat(295)} @bob`), "bob")).toBe(true);
    expect(explicitlyMentions(message(`${"x".repeat(295)} @bobby`), "bob")).toBe(false);
    expect(explicitlyMentions(message(`${"x".repeat(296)} @bob`), "bob")).toBe(false);
    for (const text of ["@bobby", "foo@bob", "email bob@example.com", "metadata: @bob_tool"]) {
      expect(explicitlyMentions(message(text), "bob")).toBe(false);
    }
    expect(explicitlyMentions(message("@bob", "bob", "session"), "bob", "session")).toBe(false);
    expect(explicitlyMentions(message("@bob", "system"), "bob")).toBe(false);
    expect(explicitlyMentions(message("@bob"), "")).toBe(false);
  });

  test("matches bounded broadcast aliases for every recipient", () => {
    const message = (text: string) => ({ senderId: "alice", text, createdAt: 1 });
    for (const text of ["@all", "<at>@all</at>", "@所有人", "<at>@所有人</at>"]) {
      expect(explicitlyMentions(message(text), "bob")).toBe(true);
    }
    for (const text of ["email@all", "@allison", "@所有人2", `${"x".repeat(296)} @all`]) {
      expect(explicitlyMentions(message(text), "bob")).toBe(false);
    }
  });

  test("addresses every other recipient in a direct room without a textual mention", () => {
    const msg = { senderId: "sender-session", text: "please check this", createdAt: 1, roomKind: "direct" as const };
    expect(explicitlyAddresses(msg, "same-name", "recipient-session", "direct")).toBe(true);
    expect(explicitlyAddresses({ ...msg, senderId: "recipient-session" }, "same-name", "recipient-session", "direct")).toBe(false);
    expect(explicitlyAddresses({ ...msg, senderId: "system" }, "same-name", "recipient-session", "direct")).toBe(false);
  });

  test("accepts an admission response after a retry changes delivery but retains its id", () => {
    const items = [{ senderId: "alice", text: "@bob please check", createdAt: 10 }];
    expect(queueAdmissionId("session", "room", items, "prompt")).toBe(queueAdmissionId("session", "room", items, "prompt"));
    const retry: QueueBody = { id: "stable", prompt: { text: "prompt" }, delivery: "queue", resume: true };
    expect(admissionMatches({ id: "stable", sessionID: "session", delivery: "steer" }, retry, "session")).toBe(true);
  });
});
