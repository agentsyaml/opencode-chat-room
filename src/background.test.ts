import { describe, expect, test } from "bun:test";
import { admissionMatches, queueAdmissionId, type QueueBody } from "./queue";
import { explicitlyMentions } from "./mentions";
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
    expect(await backgroundAtRegisteredService("session", "2.0.32", api, 42)).toBe(true);
    expect(calls.find(([kind]) => kind === "background")?.[1]).toEqual({ sessionID: "session" });
    expect(calls[0]).toEqual(["client", "http://127.0.0.1:54321", { authorization: "secret" }]);
  });

  test.each([
    ["missing registration", { discover: async () => undefined }],
    ["wrong pid", { info: async () => ({ pid: 43, version: "2.0.32" }) }],
    ["wrong version", { info: async () => ({ pid: 42, version: "2.0.31" }) }],
    ["refused info", { info: async () => { throw Error("refused"); } }],
  ] as const)("does not background on %s", async (_label, override) => {
    const { api, calls } = fakeApi(override);
    expect(await backgroundAtRegisteredService("session", "2.0.32", api, 42)).toBe(false);
    expect(calls.some(([kind]) => kind === "background")).toBe(false);
  });

  test("rejects non-loopback registration without probing it", async () => {
    const { api, calls } = fakeApi({ registered: { ...endpoint, url: "http://example.com:54321" } });
    expect(await backgroundAtRegisteredService("session", "2.0.32", api, 42)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("reports a rejected background API as failure", async () => {
    const { api, calls } = fakeApi({ background: async () => { throw Error("unauthorized"); } });
    expect(await backgroundAtRegisteredService("session", "2.0.32", api, 42)).toBe(false);
    expect(calls.some(([kind]) => kind === "background")).toBe(true);
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

  test("accepts an admission response after a retry changes delivery but retains its id", () => {
    const items = [{ senderId: "alice", text: "@bob please check", createdAt: 10 }];
    expect(queueAdmissionId("session", "room", items, "prompt")).toBe(queueAdmissionId("session", "room", items, "prompt"));
    const retry: QueueBody = { id: "stable", prompt: { text: "prompt" }, delivery: "queue", resume: true };
    expect(admissionMatches({ id: "stable", sessionID: "session", delivery: "steer" }, retry, "session")).toBe(true);
  });
});
