import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the central server reads host, port, token, and state dir from chatroom.json", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chatroom-server-config-"));
  const state = path.join(root, "state");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const config = path.join(root, "chatroom.json");
  writeFileSync(config, JSON.stringify({
    server: {
      host: "127.0.0.1",
      port,
      token: "config-token",
      stateDir: state,
      maxFileSizeMb: 7,
    },
  }));
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "server/chat-server.ts"],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      TMPDIR: tmpdir(),
      BUN_OPTIONS: "--no-env-file",
      CHAT_ROOM_CONFIG: config,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/rooms`, { headers: { Authorization: "Bearer config-token" } });
        break;
      } catch {
        await sleep(50);
      }
    }
    if (!response) {
      child.kill();
      const error = await new Response(child.stderr).text();
      throw new Error(`server did not start: ${error}`);
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/rooms`);
    expect(unauthorized.status).toBe(401);
    expect(existsSync(path.join(state, "chat-room.sqlite"))).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);