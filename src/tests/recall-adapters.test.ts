import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const childMode = process.env.CHAT_ROOM_RECALL_TEST_CHILD === "1";
if (!childMode) {
  test("runs recall adapter fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "recall-adapters-test-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CHAT_ROOM_RECALL_TEST_CHILD: "1", CHAT_ROOM_STATE_DIR: dir,
        HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_SERVER_URL: "", CHAT_ROOM_WAKE_SERVE_URL: "" },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`${stdout}${stderr}`);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited.catch(() => {});
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
} else {
const envKeys = ["CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_WAKE_SERVE_URL", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "HOME"] as const;
const old = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const dir = mkdtempSync(path.join(os.tmpdir(), "recall-adapters-"));
process.env.HOME = path.join(dir, "home");
process.env.XDG_STATE_HOME = path.join(dir, "state");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");
process.env.CHAT_ROOM_STATE_DIR = dir;
delete process.env.CHAT_ROOM_SERVER_URL;
delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
const [{ server }, { centerAction }] = await Promise.all([
  import("../../plugin"), import("../center/center-client.ts"),
]);

type LocalTool = { tool: { room: { execute(args: unknown, context: unknown): Promise<string> } } };

describe.serial("recall adapters", () => {
  test("central recall posts the session to the recall route", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ ok: true, messageID: "m/1", recalledAt: 2, recalledBy: "alice" });
    }) as typeof fetch;
    try {
      expect(await centerAction({ center: "http://center.invalid", token: "" },
        { action: "recall", roomId: "r 1", messageId: "m/1" }, "session-1")).toBe("recalled message m/1");
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([{
      url: "http://center.invalid/rooms/r%201/messages/m%2F1/recall",
      method: "POST",
      body: { sessionID: "session-1" },
    }]);
  });

  test("standalone tool recalls own messages and refuses outsiders", async () => {
    const local = await server({ serverUrl: "", directory: dir } as never) as unknown as LocalTool;
    const room = await local.tool.room.execute({ action: "create", name: "recall room" }, { sessionID: "owner-session" });
    const roomId = /^Room (\S+)/.exec(room)![1]!;
    await local.tool.room.execute({ action: "join", roomId, name: "author" }, { sessionID: "author-session" });
    await local.tool.room.execute({ action: "join", roomId, name: "bystander" }, { sessionID: "bystander-session" });
    const sent = await local.tool.room.execute({ action: "send", roomId, text: "first" }, { sessionID: "author-session" });
    const messageId = /message id: (\S+)/.exec(sent)![1]!;
    expect(await local.tool.room.execute({ action: "poll", roomId }, { sessionID: "bystander-session" }))
      .toContain(`first (id: ${messageId})`);
    expect(await local.tool.room.execute({ action: "recall", roomId, messageId }, { sessionID: "bystander-session" }))
      .toBe("error: only the sender or a room admin can recall this message");
    expect(await local.tool.room.execute({ action: "recall", roomId, messageId }, { sessionID: "author-session" }))
      .toBe(`recalled message ${messageId}`);
    expect(await local.tool.room.execute({ action: "poll", roomId }, { sessionID: "bystander-session" }))
      .toBe("no new messages");
    const second = await local.tool.room.execute({ action: "send", roomId, text: "second" }, { sessionID: "author-session" });
    const secondID = /message id: (\S+)/.exec(second)![1]!;
    expect(second).toContain(`message id: ${secondID}`);
    expect(await local.tool.room.execute({ action: "recall", roomId, messageId: secondID }, { sessionID: "owner-session" }))
      .toBe("error: only the sender or a room admin can recall this message");
    expect(await local.tool.room.execute({ action: "recall", roomId, messageId: secondID }, { sessionID: "author-session" }))
      .toBe(`recalled message ${secondID}`);
  });
});

afterAll(async () => {
  for (const key of envKeys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  await fs.rm(dir, { recursive: true, force: true });
});
}