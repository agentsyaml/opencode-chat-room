import { expect, test } from "bun:test";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const childMode = process.env.CHAT_ROOM_MESSAGE_LIMIT_CHILD === "1";
if (!childMode) {
  test("runs message limit fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "message-limit-test-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CHAT_ROOM_MESSAGE_LIMIT_CHILD: "1", CHAT_ROOM_STATE_DIR: dir,
        HOME: path.join(dir, "home"), XDG_STATE_HOME: path.join(dir, "state"),
        XDG_CONFIG_HOME: path.join(dir, "config"), CHAT_ROOM_SERVER_URL: "", CHAT_ROOM_SERVER_TOKEN: "",
        CHAT_ROOM_WAKE_SERVE_URL: "" }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`${stdout}${stderr}`);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
} else {
  test("agent message text accepts 5000 characters and rejects 5001", async () => {
    const { roomArgs } = await import("../../plugin");
    const { roomSchema } = await import("../runtime/v2-plugin.ts");
    const longest = "x".repeat(5000);
    for (const schema of [roomArgs, roomSchema()]) {
      expect(schema.safeParse({ action: "send", roomId: "room", text: longest }).success).toBe(true);
      expect(schema.safeParse({ action: "send", roomId: "room", text: `${longest}x` }).success).toBe(false);
    }
  });
}