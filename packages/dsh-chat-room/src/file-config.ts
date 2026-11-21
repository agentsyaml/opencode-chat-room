import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// Shared chatroom config file. Mirrors the OpenCode client semantics: same file
// names and search order, environment still overrides the file.
export type RoomFileConfig = {
  url?: string;
  token?: string;
  client?: {
    url?: string;
    token?: string;
    participant?: string;
    deliveryIntervalMs?: number;
    requestTimeoutMs?: number;
  };
};

const FILE_NAMES = ["chatroom.json", "chatroom.jsonc", "chatroom.yaml", "chatroom.yml"] as const;

function asRecord(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`chatroom config: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`chatroom config: ${where} must be a string`);
  return value;
}

function optionalNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`chatroom config: ${where} must be a finite number`);
  }
  return value;
}

function parseClient(value: unknown): RoomFileConfig["client"] {
  const raw = asRecord(value, "client");
  if (!raw) return undefined;
  const deliveryIntervalMs = optionalNumber(raw.deliveryIntervalMs, "client.deliveryIntervalMs");
  if (deliveryIntervalMs !== undefined && deliveryIntervalMs < 1000) {
    throw new Error("chatroom config: client.deliveryIntervalMs must be at least 1000");
  }
  const requestTimeoutMs = optionalNumber(raw.requestTimeoutMs, "client.requestTimeoutMs");
  if (requestTimeoutMs !== undefined && requestTimeoutMs < 1000) {
    throw new Error("chatroom config: client.requestTimeoutMs must be at least 1000");
  }
  return {
    url: optionalString(raw.url, "client.url"),
    token: optionalString(raw.token, "client.token"),
    participant: optionalString(raw.participant, "client.participant"),
    deliveryIntervalMs,
    requestTimeoutMs,
  };
}

function parseRoomConfig(value: unknown): RoomFileConfig {
  const raw = asRecord(value, "root");
  if (!raw) return {};
  return {
    url: optionalString(raw.url, "url"),
    token: optionalString(raw.token, "token"),
    client: parseClient(raw.client),
  };
}

/** Remove comments and trailing commas without touching quoted strings. */
function stripJsonc(source: string): string {
  let out = "";
  let quote = "";
  let escaped = false;
  let comma = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
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

function parseFile(file: string): RoomFileConfig {
  let text: string;
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
    if (error instanceof SyntaxError || (error as Error)?.name === "YAMLParseError") {
      // Never include parser source text: a malformed file may contain a token.
      throw new Error(`chatroom config: ${file} is not valid JSON/YAML`);
    }
    throw error;
  }
}

function candidateDirs(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const home = env.HOME || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [...new Set([cwd, path.join(configHome, "chatroom")])];
}

/** Resolve the config path; explicit CHAT_ROOM_CONFIG must exist. */
export function findRoomConfigFile(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
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
export function loadRoomConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RoomFileConfig | null {
  const file = findRoomConfigFile(env, cwd);
  return file ? parseFile(file) : null;
}