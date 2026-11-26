// CLI entry for `opencode-chat-room cli`. Config, HTTP and session helpers are
// imported lazily so --help/--version work without a terminal or OpenTUI.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.mjs";
import { DEFAULT_LANGUAGE, getLanguage, normalizeLanguage, setLanguage, t } from "./i18n.mjs";

const NAME = "opencode-chat-room cli";
const FALLBACK_VERSION = "0.8.1";
const LANGUAGE_VALUES = ["en", "zh", "zh-cn", "zh_cn"];

export const HELP = t("cli.help");

export function helpText(language) {
  const previous = getLanguage();
  setLanguage(language);
  const text = t("cli.help");
  setLanguage(previous);
  return text;
}

export function parseArgs(argv = []) {
  const options = {
    help: false,
    version: false,
    setup: false,
    name: undefined,
    language: undefined,
    theme: undefined,
    server: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--setup") options.setup = true;
    else if (arg.startsWith("--")) {
      const split = arg.indexOf("=");
      const key = split === -1 ? arg : arg.slice(0, split);
      if (!["--name", "--language", "--theme", "--server"].includes(key)) {
        return { error: `unknown option: ${arg}` };
      }
      let value = split === -1 ? argv[index + 1] : arg.slice(split + 1);
      if (split === -1) {
        if (!value || value.startsWith("-")) return { error: `${key} requires a value` };
        index += 1;
      }
      if (!value) return { error: `${key} requires a value` };
      if (key === "--language") {
        if (!LANGUAGE_VALUES.includes(value.trim().toLowerCase())) {
          return { error: "--language must be en or zh-CN" };
        }
        options.language = normalizeLanguage(value);
        continue;
      }
      if (key === "--theme") {
        value = value.trim().toLowerCase();
        if (value !== "dark" && value !== "light") return { error: "--theme must be dark or light" };
        options.theme = value;
        continue;
      }
      options[key.slice(2)] = value;
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

async function helpLanguage(options) {
  const explicit = options.language ?? process.env.CHAT_ROOM_TUI_LANGUAGE;
  if (explicit) return normalizeLanguage(explicit);
  try {
    const { loadTuiPrefs } = await import("./prefs.mjs");
    return normalizeLanguage(loadTuiPrefs(process.env).language ?? DEFAULT_LANGUAGE);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** --setup always opens settings; a missing tui.json means first run. */
export function shouldOpenSetup(options = {}, prefsExists = true) {
  return Boolean(options.setup) || !prefsExists;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`${NAME}: ${options.error}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(helpText(await helpLanguage(options)));
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
    const [
      { resolveTuiConfig, findTuiConfigFile, loadTuiConfig },
      { loadSession, saveSession },
      { createApi },
      { loadTuiPrefs, saveTuiPrefs, resolveTuiPreferences, tuiPrefsFile },
    ] = await Promise.all([
      import("./config.mjs"),
      import("./session.mjs"),
      import("./http.mjs"),
      import("./prefs.mjs"),
    ]);
    const prefs = loadTuiPrefs(process.env);
    const project = loadTuiConfig(process.env, process.cwd());
    config = resolveTuiConfig(process.env, process.cwd(), { flags: options, prefs, project });
    const preferences = resolveTuiPreferences(process.env, process.cwd(), options, { prefs, project });
    setLanguage(preferences.language);
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
        prefsFile: tuiPrefsFile(process.env),
        language: preferences.language,
        theme: preferences.theme,
        requestTimeoutMs: config.requestTimeoutMs,
        pollTimeoutMs: 20000,
        token: config.token,
      },
      savePrefs: (next) => saveTuiPrefs(process.env, next),
      downloadDir: path.join(process.cwd(), "downloads"),
    });
    ui = createTui(renderer, app);
    await app.init();
    ui.sync();
    // Settings need a working server to boot, so first run and --setup open
    // here, right after the room list loads. Without a configured server the
    // config error above still exits before the terminal is touched.
    if (shouldOpenSetup(options, existsSync(preferences.prefsFile))) app.openSettingsEditor();

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