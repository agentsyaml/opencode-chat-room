import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";

const envKeys = ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL", "XDG_STATE_HOME"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys.slice(0, 3)) delete process.env[key];
const stateHome = mkdtempSync(path.join(tmpdir(), "chat-room-owner-"));
process.env.XDG_STATE_HOME = stateHome;
const { receiverOwnerID } = await import("./receiver-owner");

describe("per-user receiver owner binding", () => {
  test("binds the stable owner to canonical service origin and custom port", async () => {
    const a = await receiverOwnerID("http://127.0.0.1:54321/path");
    expect(await receiverOwnerID("http://127.0.0.1:54321/other")).toBe(a);
    expect(await receiverOwnerID("http://127.0.0.1:54322")).not.toBe(a);
    const hash = createHash("sha256").update("http://127.0.0.1:54321").digest("hex");
    const file = path.join(process.env.XDG_STATE_HOME!, "opencode/chat-room/owners", `${hash}.json`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const raced = await Promise.all(Array.from({ length: 8 }, () => receiverOwnerID("http://127.0.0.1:54323")));
    expect(new Set(raced).size).toBe(1);
  });

  test("does not replace an unreadable owner binding", async () => {
    const origin = "http://127.0.0.1:61234";
    const hash = createHash("sha256").update(origin).digest("hex");
    const dir = path.join(process.env.XDG_STATE_HOME!, "opencode/chat-room/owners");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${hash}.json`);
    await fs.writeFile(file, "corrupt", { mode: 0o600 });
    expect(await receiverOwnerID(origin)).toBeUndefined();
    expect(await fs.readFile(file, "utf8")).toBe("corrupt");
  });
});

afterAll(async () => {
  await fs.rm(stateHome, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
