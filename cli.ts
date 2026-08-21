#!/usr/bin/env bun

const usage = `Usage: opencode-chat-room [options]

Options:
  -h, --help             Show this help
  -v, --version          Show the package version
  -H, --host <host>      Bind hostname
  -p, --port <port>      Bind port (1-65535)
  -t, --token <token>    Enable bearer token authentication`;

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
