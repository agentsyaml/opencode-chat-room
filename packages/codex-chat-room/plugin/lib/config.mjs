// Shared chatroom.json(c)/yaml configuration for the Codex plugin. The
// semantics mirror the root loader: file discovery, JSONC stripping, strict
// types for known fields, and environment variables winning over file values.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const FILE_NAMES = ["chatroom.json", "chatroom.jsonc", "chatroom.yaml", "chatroom.yml"];

function asRecord(value, where) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`chatroom config: ${where} must be an object`);
  }
  return value;
}

function optionalString(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`chatroom config: ${where} must be a string`);
  return value;
}

function optionalBoolean(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`chatroom config: ${where} must be true or false`);
  return value;
}

function parseClient(value) {
  const raw = asRecord(value, "client");
  if (!raw) return undefined;
  return {
    url: optionalString(raw.url, "client.url"),
    token: optionalString(raw.token, "client.token"),
    delivery: optionalBoolean(raw.delivery, "client.delivery"),
    codexBin: optionalString(raw.codexBin, "client.codexBin"),
  };
}

function parseRoomConfig(value) {
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
      if (comma >= 0) {
        out = out.slice(0, comma) + out.slice(comma + 1);
        comma = -1;
      }
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
    throw new Error(`chatroom config: cannot read ${file}`);
  }
  const extension = path.extname(file).toLowerCase();
  try {
    if (extension === ".yaml" || extension === ".yml") return parseRoomConfig(parseYaml(text));
    if (extension === ".jsonc") return parseRoomConfig(JSON.parse(stripJsonc(text)));
    if (extension === ".json") return parseRoomConfig(JSON.parse(text));
    try {
      return parseRoomConfig(JSON.parse(text));
    } catch {
      return parseRoomConfig(parseYaml(text));
    }
  } catch (error) {
    if (error instanceof SyntaxError || error?.name === "YAMLParseError") {
      // Never include parser source text: a malformed file may contain a token.
      throw new Error(`chatroom config: ${file} is not valid JSON/YAML`);
    }
    throw error;
  }
}

function candidateDirs(env, cwd) {
  const home = env.HOME || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [...new Set([cwd, path.join(configHome, "chatroom")])];
}

/** Resolve the config path; explicit CHAT_ROOM_CONFIG must exist. */
export function findRoomConfigFile(env = process.env, cwd = process.cwd()) {
  const explicit = env.CHAT_ROOM_CONFIG?.trim();
  if (explicit) {
    const file = explicit.startsWith("~/") ? path.join(env.HOME || os.homedir(), explicit.slice(2)) : path.resolve(cwd, explicit);
    if (!existsSync(file)) throw new Error(`chatroom config: CHAT_ROOM_CONFIG file does not exist: ${file}`);
    return file;
  }
  for (const dir of candidateDirs(env, cwd)) {
    for (const name of FILE_NAMES) {
      const file = path.join(dir, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/** Read the first found chatroom.json(c)/yaml/yml, or null when absent. */
export function loadRoomConfig(env = process.env, cwd = process.cwd()) {
  const file = findRoomConfigFile(env, cwd);
  return file ? parseFile(file) : null;
}

function envValue(env, key) {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

/** Environment overrides the file; client.* overrides the top-level url/token. */
export function resolveCodexConfig(env = process.env, cwd = process.cwd()) {
  const file = loadRoomConfig(env, cwd);
  const delivery = envValue(env, "CHAT_ROOM_DELIVERY");
  return {
    url: envValue(env, "CHAT_ROOM_SERVER_URL") ?? file?.client?.url ?? file?.url ?? "http://127.0.0.1:4399",
    token: envValue(env, "CHAT_ROOM_SERVER_TOKEN") ?? file?.client?.token ?? file?.token ?? "",
    delivery: delivery === undefined ? file?.client?.delivery ?? true : delivery !== "0",
    codexBin: envValue(env, "CHAT_ROOM_CODEX_BIN") ?? file?.client?.codexBin ?? "codex",
  };
}