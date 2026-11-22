#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const usage = `Usage: opencode-chat-room [options]

Options:
  -h, --help             Show this help
  -v, --version          Show the package version
  -H, --host <host>      Bind hostname
  -p, --port <port>      Bind port (1-65535)
  -t, --token <token>    Enable bearer token authentication

Commands:
  cli [--name <name>]    Open the terminal client
  watch run|start|status|stop`;

type ValueOption = "host" | "port" | "token";
const values: Partial<Record<ValueOption, string>> = {};
let help = false;
let version = false;

function fail(message: string): never {
  console.error(`Error: ${message}\n\n${usage}`);
  process.exit(1);
}

function setValue(name: ValueOption, value: string | undefined): void {
  if (value === undefined || value === "") {
    fail(`Missing value for --${name}`);
  }
  values[name] = value;
}

function validatePort(value: string): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port "${value}": expected an integer from 1 to 65535`);
  }
}

const args = process.argv.slice(2);

// `bunx package` runs the bin with Node by default, even when Bun is installed.
// The terminal client needs Bun here, so hand off to a supported Bun when one is
// available instead of making every user remember the --bun flag.
function relaunchTuiWithBun(): void {
  if (process.versions.bun) return;
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return;
  const [major = 0, minor = 0, patch = 0] = String(probe.stdout).trim().split(".").map(Number);
  const supported = major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 14)));
  if (!supported) return;
  const child = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(child.status ?? 1);
}

if (args[0] === "cli") {
  relaunchTuiWithBun();
  // Keep the plain-JS TUI outside dist so bundling cannot hoist OpenTUI into
  // every CLI command. The packaged layout has dist/cli.js beside src/tui.
  const packaged = new URL("../src/tui/main.mjs", import.meta.url);
  const source = new URL("./src/tui/main.mjs", import.meta.url);
  const entry = existsSync(fileURLToPath(packaged)) ? packaged : source;
  const { main } = await import(entry.href);
  process.exit(await main(args.slice(1)));
}
if (args[0] === "watch") {
  const action = args[1];
  if ((args.length === 2 && (action === "help" || action === "--help")) ||
    (args.length === 3 && args[2] === "--help")) {
    console.log("Usage: opencode-chat-room watch run|start|status|stop");
    process.exit(0);
  }
  if (args.length !== 2 || !["run", "start", "status", "stop"].includes(action ?? "")) {
    fail("Expected watch run, start, status, or stop");
  }
  const watcher = await import("./src/runtime/watch.ts");
  try {
    if (action === "run") await watcher.runWatcher();
    else if (action === "start") console.log(await watcher.startWatcher());
    else if (action === "status") console.log(await watcher.watchStatus());
    else console.log(await watcher.stopWatcher());
  } catch (error) {
    console.error(`watch: ${error instanceof Error ? error.message : "operation failed"}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "-h" || arg === "--help") {
    help = true;
    continue;
  }
  if (arg === "-v" || arg === "--version") {
    version = true;
    continue;
  }

  const equals = arg.match(/^--(host|port|token)=(.*)$/);
  if (equals) {
    const name = equals[1] as ValueOption;
    setValue(name, equals[2]);
    continue;
  }

  const name =
    arg === "-H" || arg === "--host"
      ? "host"
      : arg === "-p" || arg === "--port"
        ? "port"
        : arg === "-t" || arg === "--token"
          ? "token"
          : undefined;
  if (name) {
    const value = args[++i];
    if (value?.startsWith("-") && !(name === "port" && /^-\d+$/.test(value))) {
      fail(`Missing value for --${name}`);
    }
    setValue(name, value);
    continue;
  }
  fail(`Unknown option: ${arg}`);
}

if (help) {
  console.log(usage);
  process.exit(0);
}

if (version) {
  let packageJson: { version?: string } = {};
  for (const candidate of ["./package.json", "../package.json"]) {
    try {
      packageJson = JSON.parse(await readFile(new URL(candidate, import.meta.url), "utf8"));
      break;
    } catch {
      // The bundled CLI lives in dist/, while source runs from the package root.
    }
  }
  console.log(packageJson.version ?? "unknown");
  process.exit(0);
}

if (values.port !== undefined) {
  validatePort(values.port);
  process.env.CHAT_ROOM_SERVER_PORT = values.port;
}
if (values.host !== undefined) {
  process.env.CHAT_ROOM_SERVER_HOST = values.host;
}
if (values.token !== undefined) {
  process.env.CHAT_ROOM_SERVER_TOKEN = values.token;
}

const { default: server } = await import("./server/chat-server.ts");
const { startServer } = await import("./server/http-server.ts");
await startServer(server);
