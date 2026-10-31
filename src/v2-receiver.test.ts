import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { QueueTransport } from "./queue-transport";
import { attachV2Receiver, groupByCenter, pollAttachmentGroup, pollAttachmentsByCenter, pollOwnedSessions, receiverState, type Attachment } from "./v2-receiver";
import type { CenterOpts } from "./center-client";

const envKeys = ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL", "XDG_STATE_HOME"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys.slice(0, 3)) delete process.env[key];
const stateHome = mkdtempSync(path.join(tmpdir(), "chat-room-receiver-"));
process.env.XDG_STATE_HOME = stateHome;
const { createV2Setup } = await import("./v2-plugin");

const noop = async () => {};
function attachment(sessions: ReadonlySet<string>, center: CenterOpts, poll: Attachment["poll"] = noop): Attachment {
  return { sessions, version: "2.0.32", transport: { protocol: "v2" }, center, poll };
}
function attach(sessions: ReadonlySet<string>, center: CenterOpts = { center: "", token: "" }, poll = noop) {
  return attachV2Receiver(attachment(sessions, center, poll));
}

describe("shared V2 receiver lifecycle", () => {
  test("groups by normalized base URL and token, not just origin", () => {
    const a = { center: { center: "https://a.invalid/api", token: "a" } };
    const sameA = { center: { center: "https://a.invalid/api/", token: "a" } };
    const pathA = { center: { center: "https://a.invalid/other", token: "a" } };
    const tokenA = { center: { center: "https://a.invalid/api", token: "b" } };
    const b = { center: { center: "https://b.invalid", token: "b" } };
    const localA = { center: { center: "", token: "one" } }, localB = { center: { center: "", token: "two" } };
    expect([...groupByCenter([a, sameA, pathA, tokenA, b, localA, localB]).values()].map((items) => items.length)).toEqual([2, 1, 1, 1, 2]);
  });

  test("actual grouped polling keeps same-origin center paths and tokens isolated", async () => {
    const polls: Array<[string, string[]]> = [], lookups: string[] = [];
    const a = attachment(new Set(["session-a"]), { center: "https://center.invalid/one", token: "token-a" }, async (ids, _t, c) => { polls.push([c.center, [...ids]]); });
    const b = attachment(new Set(["session-b"]), { center: "https://center.invalid/two", token: "token-b" }, async (ids, _t, c) => { polls.push([c.center, [...ids]]); });
    const releaseA = attachV2Receiver(a), releaseB = attachV2Receiver(b);
    try {
      await pollAttachmentsByCenter([a, b], async (item) => { lookups.push(item.center.center); return new Set([item.sessions.values().next().value!]); },
        async (owned, restored, primary) => { expect([...restored]).toEqual([]); await primary.poll(owned, primary.transport, primary.center); });
      expect(lookups.sort()).toEqual([a.center.center, b.center.center].sort());
      const expected: Array<[string, string[]]> = [[a.center.center, ["session-a"]], [b.center.center, ["session-b"]]];
      expect(polls.sort((x, y) => x[0].localeCompare(y[0]))).toEqual(expected.sort((x, y) => x[0].localeCompare(y[0])));
    } finally { releaseA(); releaseB(); }
  });

  test("keeps one timer until both setups detach in either order", () => {
    const first = attach(new Set());
    const second = attach(new Set());
    expect(receiverState()).toEqual({ attachments: 2, timerRunning: true });
    second();
    expect(receiverState()).toEqual({ attachments: 1, timerRunning: true });
    first();
    expect(receiverState()).toEqual({ attachments: 0, timerRunning: false });
  });

  test("stops the timer when the first attachment is released", () => {
    const first = attach(new Set());
    const second = attach(new Set());
    first();
    second();
    expect(receiverState()).toEqual({ attachments: 0, timerRunning: false });
  });

  test("does not attach a receiver when setup fails", async () => {
    const setup = createV2Setup({
      runtime: (directory, transport) => ({ protocol: "v2", selfServerUrl: "", selfDirectory: directory, transport,
        center: { center: "", token: "", directory } }),
      run: (_runtime, callback) => callback(), execute: async () => "", observe: async () => {},
      poll: noop,
    });
    const context = {
      location: { directory: "/isolated/project" }, app: { version: "2.0.32" },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { transform: async () => { throw Error("setup failure"); } },
      command: { transform: async () => ({ dispose: async () => {} }) },
    };
    await expect(setup(context as never)).rejects.toThrow("setup failure");
    expect(receiverState()).toEqual({ attachments: 0, timerRunning: false });
  });

  test("does not pre-load idle owned sessions and leaves a missing prompt uncommitted", async () => {
    let gets = 0;
    const prompts: string[] = [];
    const cursors = new Map<string, number>();
    const client = { session: {
      get: async () => { gets++; throw Error("should not load sessions before delivery"); },
      prompt: async ({ sessionID }: { sessionID: string }) => {
        prompts.push(sessionID);
        if (sessionID === "missing") throw Error("404");
        return { sessionID };
      },
    } };
    const ids = new Set(["restored", "missing"]);
    await pollOwnedSessions(ids, async (sessions) => Promise.all([...sessions].map(async (sessionID) => {
      try { await client.session.prompt({ sessionID }); cursors.set(sessionID, 20); } catch { /* No prompt admission, no cursor. */ }
    })).then(() => {}));
    expect(gets).toBe(0);
    expect(prompts.sort()).toEqual(["missing", "restored"]);
    expect(cursors.has("missing")).toBe(false);
  });

  test("unions observed sessions before restore and never repolls owned IDs after failure", async () => {
    const center = { center: "https://center.invalid/base", token: "token" }, calls: Array<[string, string[]]> = [];
    const poll = async (ids: ReadonlySet<string>, _transport: QueueTransport, opts: CenterOpts) => {
      calls.push([opts.center, [...ids].sort()]);
      if (ids.has("local-a")) throw Error("observed transport failed");
    };
    const a = attachment(new Set(["owned-a", "local-a"]), center, poll);
    const b = attachment(new Set(["owned-b", "local-b"]), center, poll);
    const releaseA = attachV2Receiver(a), releaseB = attachV2Receiver(b);
    try {
      await pollAttachmentGroup([a, b], async () => new Set(["owned-a", "owned-b", "restored"]), async (owned, restored, primary) => {
        expect([...restored]).toEqual(["restored"]);
        await primary.poll(owned, primary.transport, primary.center);
        throw Error("restore transport failed");
      });
      expect(calls).toEqual([[center.center, ["owned-a", "owned-b", "restored"]], [center.center, ["local-a"]], [center.center, ["local-b"]]]);
    } finally { releaseA(); releaseB(); }
  });

  test("membership failure polls every live attachment using its own center", async () => {
    const calls: Array<[string, string[]]> = [];
    const a = attachment(new Set(["session-a"]), { center: "https://one.invalid/a", token: "one" }, async (ids, _t, c) => { calls.push([c.center, [...ids]]); });
    const b = attachment(new Set(["session-b"]), { center: "https://two.invalid/b", token: "two" }, async (ids, _t, c) => { calls.push([c.center, [...ids]]); });
    const releaseA = attachV2Receiver(a), releaseB = attachV2Receiver(b);
    try {
      await pollAttachmentGroup([a, b], async () => { throw Error("center unavailable"); }, async () => { throw Error("must not restore"); });
      expect(calls).toEqual([["https://one.invalid/a", ["session-a"]], ["https://two.invalid/b", ["session-b"]]]);
    } finally { releaseA(); releaseB(); }
  });
});

afterAll(async () => {
  await fs.rm(stateHome, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
