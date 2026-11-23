// CLI entry for `opencode-chat-room cli`. Config, HTTP and session helpers are
// imported lazily so --help/--version work without a terminal or OpenTUI.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.mjs";

const NAME = "opencode-chat-room cli";
const FALLBACK_VERSION = "0.7.7";

export const HELP = `opencode-chat-room cli - terminal client for a chat-room server

Usage: opencode-chat-room cli [--name <display name>]
       opencode-chat-room cli --help
       opencode-chat-room cli --version

Options:
  --name <name>   display name for this session
  --help          show this help
  --version       print the version

Config is read from chatroom.json / chatroom.jsonc / chatroom.yaml in the
current directory or ~/.config/chatroom, and from environment variables.
A token is never accepted on the command line. See the README for fields.

Keys: arrows select rooms · Enter opens · Tab focuses the composer ·
PageUp/PageDown scroll · Alt+Home/End jumps · Alt+Space or Ctrl+P opens the
palette · Ctrl+C quits.
Type / at the start of the composer for inline commands; @ mentions members.
Commands include: members, join requests, announcements, questions, files,
reminders, room settings, recall/reveal/reply/ask, delete room and quit.
This command needs an interactive terminal.
`;

export function parseArgs(argv = []) {
  const options = { help: false, version: false, name: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) return { error: "--name requires a display name" };
      options.name = value;
      index += 1;
    } else if (arg.startsWith("--name=")) {
      const value = arg.slice("--name=".length);
      if (!value) return { error: "--name requires a display name" };
      options.name = value;
    } else {
      return { error: `unknown option: ${arg}` };
    }
  }
  return options;
}

function runtimeProblem() {
  const [nodeMajor = 0, nodeMinor = 0] = (process.versions.node ?? "").split(".").map(Number);
  const [bunMajor = 0, bunMinor = 0, bunPatch = 0] = (process.versions.bun ?? "").split(".").map(Number);
  const bunSupported = Boolean(process.versions.bun) &&
    (bunMajor > 1 || (bunMajor === 1 && (bunMinor > 3 || (bunMinor === 3 && bunPatch >= 14))));
  const nodeSupported = nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 4);
  if (typeof globalThis.Deno !== "undefined" || (!bunSupported && !nodeSupported)) {
    return "the terminal client requires Bun 1.3.14+ or Node.js 26.4+ with --experimental-ffi. Install Bun 1.3.14+ and retry, or use a supported Node.js version.";
  }
  return "";
}

function version() {
  try {
    for (const candidate of ["../../package.json", "../package.json"]) {
      try {
        const data = JSON.parse(readFileSync(new URL(candidate, import.meta.url), "utf8"));
        if (typeof data.version === "string") return data.version;
      } catch {
        // Source runs from src/tui, bundled CLI runs from dist.
      }
    }
    return FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function redact(text, token) {
  if (!token) return text;
  return String(text).split(token).join("***");
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`${NAME}: ${options.error}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${NAME} ${version()}\n`);
    return 0;
  }
  const unsupported = runtimeProblem();
  if (unsupported) {
    process.stderr.write(`${NAME}: ${unsupported}\n`);
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${NAME}: requires an interactive terminal. Use --help for usage.\n`);
    return 1;
  }

  let config;
  let renderer;
  let ui;
  try {
    const [{ resolveTuiConfig, findTuiConfigFile }, { loadSession, saveSession }, { createApi }] = await Promise.all([
      import("./config.mjs"),
      import("./session.mjs"),
      import("./http.mjs"),
    ]);
    config = resolveTuiConfig(process.env, process.cwd());
    const requested = options.name?.trim();
    const session = loadSession(config.stateFile, requested || config.participant);
    const participant = requested || session.name || config.participant;
    if (session.name !== participant) {
      try {
        saveSession(config.stateFile, { ...session, name: participant });
      } catch {
        // A read-only state file only costs a new identity next time.
      }
    }
    const api = createApi({ url: config.url, token: config.token, requestTimeoutMs: config.requestTimeoutMs });
    let host = config.url;
    try {
      host = new URL(config.url).host;
    } catch {
      // Keep the raw URL when it is not parseable.
    }

    const [{ createCliRenderer }, { createTui }] = await Promise.all([
      import("@opentui/core"),
      import("./ui.mjs"),
    ]);
    renderer = await createCliRenderer({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      useMouse: true,
      targetFps: 30,
      clearOnShutdown: true,
    });
    const app = createApp({
      api,
      sessionID: session.sessionID,
      participant,
      host,
      settings: {
        server: config.url,
        participant,
        sessionFile: config.stateFile,
        configFile: findTuiConfigFile(process.env, process.cwd()) ?? "",
        requestTimeoutMs: config.requestTimeoutMs,
        pollTimeoutMs: 20000,
        token: config.token,
      },
      downloadDir: path.join(process.cwd(), "downloads"),
    });
    ui = createTui(renderer, app);
    await app.init();
    ui.sync();

    return await new Promise((resolve) => {
      const finish = () => resolve(0);
      if (app.state.quit) {
        finish();
        return;
      }
      const unsubscribe = app.subscribe(() => {
        if (!app.state.quit) return;
        unsubscribe();
        finish();
      });
    });
  } catch (error) {
    process.stderr.write(`${NAME}: ${redact(errorText(error), config?.token)}\n`);
    return 1;
  } finally {
    ui?.destroy();
    renderer?.destroy();
  }
}