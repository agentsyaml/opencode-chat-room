import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { QueueTransport } from "./queue-transport";
import { attachV2Receiver, pollOwnedSessions, pollWithMembershipFallback, receiverState } from "./v2-receiver";

const envKeys = ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL", "XDG_STATE_HOME"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys.slice(0, 3)) delete process.env[key];
const stateHome = mkdtempSync(path.join(tmpdir(), "chat-room-receiver-"));
process.env.XDG_STATE_HOME = stateHome;
const { createV2Setup } = await import("./v2-plugin");

const noop = async () => {};
function attach(sessions: ReadonlySet<string>) {
  return attachV2Receiver({
    sessions, version: "2.0.32", transport: { protocol: "v2" } satisfies QueueTransport,
    center: { center: "", token: "" }, poll: noop,
  });
}

describe("shared V2 receiver lifecycle", () => {
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

  test("keeps observed polling alive when central owner lookup returns 404", async () => {
    let observed = 0;
    let restore = 0;
    await pollWithMembershipFallback(async () => { throw Error("404"); }, async () => { restore++; },
      async () => { observed++; }, async () => { observed++; });
    expect(observed).toBe(1);
    expect(restore).toBe(0);
  });
});

afterAll(async () => {
  await fs.rm(stateHome, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
