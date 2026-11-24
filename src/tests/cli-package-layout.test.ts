import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The published package runs dist/cli.js, where relative paths differ from
// src/. Build the same bundle into a package-shaped directory and run `watch`.
test("the bundled CLI finds its skill and CLI entry from the package layout", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chat-cli-layout-"));
  try {
    cpSync(path.join(process.cwd(), "skills"), path.join(root, "skills"), { recursive: true });
    // A real install has its dependencies beside dist/.
    symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "dir");
    writeFileSync(path.join(root, "config.json"), "{}");
    const build = spawnSync(process.execPath, [
      "build", "cli.ts", "--target=node", "--packages", "external",
      "--outfile", path.join(root, "dist", "cli.js"),
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(build.stderr).not.toContain("error:");
    expect(build.status).toBe(0);

    const cli = path.join(root, "dist", "cli.js");
    // A real install launches the bin shim, a symlink to dist/cli.js; resolving
    // that link is what makes the daemon re-enter the packaged CLI.
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "opencode-chat-room");
    symlinkSync(cli, bin);
    const env = {
      ...process.env,
      HOME: root,
      XDG_STATE_HOME: path.join(root, "state"),
      CHAT_ROOM_CONFIG: path.join(root, "config.json"),
      CHAT_ROOM_STATE_DIR: path.join(root, "state"),
      CHAT_ROOM_SERVER_URL: "",
      CHAT_ROOM_SERVER_TOKEN: "",
      CHAT_ROOM_WAKE_SERVE_URL: "",
    };
    const run = (...args: string[]) => spawnSync("node", [bin, ...args], { encoding: "utf8", env });

    const status = run("watch", "status");
    expect(status.stderr).not.toContain("ENOENT");
    expect(status.stdout).toContain("stopped");

    // The daemon must re-enter the same packaged CLI, not a source .ts path.
    expect(run("watch", "start").stdout).toContain("watcher started");
    expect(run("watch", "status").stdout).toContain("running");
    expect(run("watch", "stop").stdout).toContain("watcher stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);