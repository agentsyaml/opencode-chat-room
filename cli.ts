#!/usr/bin/env bun

const usage = `Usage: opencode-chat-room [options]

Options:
  -h, --help             Show this help
  -v, --version          Show the package version
  -H, --host <host>      Bind hostname
  -p, --port <port>      Bind port (1-65535)
  -t, --token <token>    Enable bearer token authentication

Commands:
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
  const watcher = await import("./src/watch");
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
  const packageJson = (await Bun.file(
    new URL("./package.json", import.meta.url),
  ).json()) as { version?: string };
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

const { default: server } = await import("./server/chat-server");
Bun.serve(server);
