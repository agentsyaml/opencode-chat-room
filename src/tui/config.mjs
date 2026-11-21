// Runtime-neutral chatroom config loader for the TUI: JSON, JSONC and YAML,
// with environment variables overriding file values.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const FILE_NAMES = ["chatroom.json", "chatroom.jsonc", "chatroom.yaml", "chatroom.yml"];
export const DEFAULT_PARTICIPANT = "chatroom-tui";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

const URL_HINT = "set CHAT_ROOM_SERVER_URL or client.url in your chatroom config";

function asRecord(value, where) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`chatroom TUI: ${where} must be an object`);
  }
  return value;
}

function optionalString(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`chatroom TUI: ${where} must be a string`);
  return value;
}

function optionalNumber(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`chatroom TUI: ${where} must be a finite number`);
  }
  return value;
}

function parseClient(value) {
  const raw = asRecord(value, "client");
  if (!raw) return undefined;
  const requestTimeoutMs = optionalNumber(raw.requestTimeoutMs, "client.requestTimeoutMs");
  if (requestTimeoutMs !== undefined && requestTimeoutMs <= 0) {
    throw new Error("chatroom TUI: client.requestTimeoutMs must be greater than zero");
  }
  return {
    url: optionalString(raw.url, "client.url"),
    token: optionalString(raw.token, "client.token"),
    participant: optionalString(raw.participant, "client.participant"),
    requestTimeoutMs,
  };
}

function parseConfig(value) {
  const raw = asRecord(value, "root");
  if (!raw) return {};
  return {
    url: optionalString(raw.url, "url"),
    token: optionalString(raw.token, "token"),
    client: parseClient(raw.client),
  };
}

/** Remove comments and trailing commas without touching quoted strings. */
function stripJsonc(source) {
  let out = "";
  let quote = "";
  let escaped = false;
  let comma = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"') {
      quote = char;
      comma = -1;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (char === ",") {
      comma = out.length;
      out += char;
      continue;
    }
    if (char === "}" || char === "]") {
      if (comma >= 0) out = out.slice(0, comma) + out.slice(comma + 1);
      comma = -1;
      out += char;
      continue;
    }
    if (!/\s/.test(char)) comma = -1;
    out += char;
  }
  return out;
}

function parseFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`chatroom TUI: cannot read ${file}`);
  }
  const extension = path.extname(file).toLowerCase();
  try {
    if (extension === ".yaml" || extension === ".yml") return parseConfig(parseYaml(text));
    if (extension === ".jsonc") return parseConfig(JSON.parse(stripJsonc(text)));
    if (extension === ".json") return parseConfig(JSON.parse(text));
    try {
      return parseConfig(JSON.parse(text));
    } catch {
      return parseConfig(parseYaml(text));
    }
  } catch (error) {
    if (error instanceof SyntaxError || error?.name === "YAMLParseError") {
      // Never include parser source text: a malformed file may contain a token.
      throw new Error(`chatroom TUI: ${file} is not valid JSON/YAML`);
    }
    throw error;
  }
}

function expandHome(value, home) {
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** Resolve the config path; an explicit CHAT_ROOM_CONFIG must exist. */
export function findTuiConfigFile(env = process.env, cwd = process.cwd()) {
  const home = env.HOME || os.homedir();
  const explicit = env.CHAT_ROOM_CONFIG?.trim();
  if (explicit) {
    const file = path.resolve(cwd, expandHome(explicit, home));
    if (!existsSync(file)) throw new Error(`chatroom TUI: CHAT_ROOM_CONFIG file does not exist: ${file}`);
    return file;
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  for (const dir of [...new Set([cwd, path.join(configHome, "chatroom")])]) {
    for (const name of FILE_NAMES) {
      const file = path.join(dir, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

export function loadTuiConfig(env = process.env, cwd = process.cwd()) {
  const file = findTuiConfigFile(env, cwd);
  return file ? parseFile(file) : null;
}

function envValue(env, key) {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

function stateFile(env, cwd, home) {
  const explicit = envValue(env, "CHAT_ROOM_TUI_STATE");
  if (explicit) return path.resolve(cwd, expandHome(explicit, home));
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(stateHome, "chatroom-tui", "session.json");
}

export function resolveTuiConfig(env = process.env, cwd = process.cwd()) {
  const file = loadTuiConfig(env, cwd);
  const home = env.HOME || os.homedir();
  const url = (envValue(env, "CHAT_ROOM_SERVER_URL") ?? file?.client?.url ?? file?.url ?? "")
    .trim().replace(/\/+$/, "");
  if (!url) throw new Error(`chatroom TUI: server URL is not set; ${URL_HINT}`);
  if (!/^https?:\/\/[^/]+/i.test(url)) {
    throw new Error(`chatroom TUI: server URL must be an http(s) URL; ${URL_HINT}`);
  }
  const name = envValue(env, "CHAT_ROOM_TUI_NAME") ?? file?.client?.participant ?? DEFAULT_PARTICIPANT;
  return {
    url,
    token: envValue(env, "CHAT_ROOM_SERVER_TOKEN") ?? file?.client?.token ?? file?.token ?? "",
    participant: name.trim().slice(0, 64) || DEFAULT_PARTICIPANT,
    requestTimeoutMs: file?.client?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    stateFile: stateFile(env, cwd, home),
  };
}