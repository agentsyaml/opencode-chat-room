import { afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const roots = [...new Set([tmpdir(), path.resolve(tmpdir())].map((value) => path.resolve(value)))];
const inside = (value?: string) => {
  if (!value) return false;
  const p = path.resolve(value);
  return roots.some((root) => p === root || p.startsWith(`${root}${path.sep}`));
};
const fakeCenter = (value?: string) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    // Loopback is not proof of a fake target: a real center can listen on 127.0.0.1:4399.
    // Only reserved documentation TLDs are accepted as environment-configured fake centers.
    return url.port !== "4399" && (url.hostname.endsWith(".invalid") || url.hostname.endsWith(".example"));
  } catch { return false; }
};
const sandbox = process.env.CHAT_ROOM_TEST_SANDBOX;
const trusted = process.env.CHAT_ROOM_TEST_ISOLATED === "1" && Boolean(sandbox) && inside(sandbox) &&
  existsSync(path.join(sandbox!, ".sandbox")) && path.basename(sandbox!).startsWith("chat-room-test-env-") &&
  inside(process.env.HOME) && inside(process.env.XDG_CONFIG_HOME || process.env.HOME) &&
  inside(process.env.XDG_STATE_HOME || process.env.HOME) &&
  inside(process.env.CHAT_ROOM_STATE_DIR || process.env.HOME);
const critical = ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"];
if (!trusted) {
  // No valid sandbox proof: scrub every ambient CHAT_ROOM_* value before any test file loads.
  for (const key of Object.keys(process.env)) if (key.startsWith("CHAT_ROOM_")) delete process.env[key];
  const root = mkdtempSync(path.join(tmpdir(), "chat-room-test-env-"));
  const home = path.join(root, "home"), config = path.join(root, "config");
  const state = path.join(root, "state"), rooms = path.join(root, "rooms");
  for (const dir of [home, config, state, rooms]) mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state,
    CHAT_ROOM_STATE_DIR: rooms, CHAT_ROOM_TEST_ISOLATED: "1", CHAT_ROOM_TEST_SANDBOX: root });
  writeFileSync(path.join(root, ".sandbox"), "1");
  for (const key of critical) process.env[key] = "";
  afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
} else {
  // Child tests inherit the sandbox marker, but a real (non-fake) center is still rejected.
  if (!fakeCenter(process.env.CHAT_ROOM_SERVER_URL)) {
    delete process.env.CHAT_ROOM_SERVER_URL;
    delete process.env.CHAT_ROOM_SERVER_TOKEN;
    delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
  }
  if (!fakeCenter(process.env.CHAT_ROOM_WAKE_SERVE_URL)) delete process.env.CHAT_ROOM_WAKE_SERVE_URL;
  for (const key of critical) process.env[key] ??= "";
}
if (!(process.env.BUN_OPTIONS ?? "").includes("--no-env-file")) process.env.BUN_OPTIONS = `${process.env.BUN_OPTIONS ?? ""} --no-env-file`.trim();