import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// A shared, human-editable configuration file. Environment variables still
// win over the file so a deployment can override one value without editing it.
export type RoomFileConfig = {
  url?: string;
  token?: string;
  server?: {
    host?: string;
    port?: number;
    token?: string;
    stateDir?: string;
    wakeServeUrl?: string;
    maxFileSizeMb?: number;
    channeld?: {
      enabled?: boolean;
      config?: string;
      stateFile?: string;
    };
  };
  client?: {
    url?: string;
    token?: string;
    participant?: string;
    wakeServeUrl?: string;
    delivery?: boolean;
    deliveryIntervalMs?: number;
    requestTimeoutMs?: number;
    codexBin?: string;
  };
  p2p?: {
    enabled?: boolean;
    peers?: Record<string, { url: string; token?: string }>;
  };
};

export type ChannelDSettings = {
  enabled: boolean;
  config?: string;
  stateFile?: string;
};

export type ServerSettings = {
  host: string;
  port: string;
  token?: string;
  stateDir?: string;
  wakeServeUrl: string;
  maxFileSizeMb?: number;
  channeld: ChannelDSettings;
};

export type ClientSettings = {
  url: string;
  token: string;
  wakeServeUrl: string;
};

const FILE_NAMES = ["chatroom.json", "chatroom.jsonc", "chatroom.yaml", "chatroom.yml"] as const;
const PEER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

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

function optionalBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`chatroom config: ${where} must be true or false`);
  return value;
}

function parseChanneld(value: unknown): NonNullable<RoomFileConfig["server"]>["channeld"] {
  const raw = asRecord(value, "server.channeld");
  if (!raw) return undefined;
  return {
    enabled: optionalBoolean(raw.enabled, "server.channeld.enabled"),
    config: optionalString(raw.config, "server.channeld.config"),
    stateFile: optionalString(raw.stateFile, "server.channeld.stateFile"),
  };
}

function parseServer(value: unknown): RoomFileConfig["server"] {
  const raw = asRecord(value, "server");
  if (!raw) return undefined;
  const port = optionalNumber(raw.port, "server.port");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("chatroom config: server.port must be an integer from 1 to 65535");
  }
  const maxFileSizeMb = optionalNumber(raw.maxFileSizeMb, "server.maxFileSizeMb");
  if (maxFileSizeMb !== undefined && maxFileSizeMb <= 0) {
    throw new Error("chatroom config: server.maxFileSizeMb must be greater than zero");
  }
  return {
    host: optionalString(raw.host, "server.host"),
    port,
    token: optionalString(raw.token, "server.token"),
    stateDir: optionalString(raw.stateDir, "server.stateDir"),
    wakeServeUrl: optionalString(raw.wakeServeUrl, "server.wakeServeUrl"),
    maxFileSizeMb,
    channeld: parseChanneld(raw.channeld),
  };
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
    wakeServeUrl: optionalString(raw.wakeServeUrl, "client.wakeServeUrl"),
    delivery: optionalBoolean(raw.delivery, "client.delivery"),
    deliveryIntervalMs,
    requestTimeoutMs,
    codexBin: optionalString(raw.codexBin, "client.codexBin"),
  };
}

function parsePeers(value: unknown): RoomFileConfig["p2p"] {
  const raw = asRecord(value, "p2p");
  if (!raw) return undefined;
  const enabled = optionalBoolean(raw.enabled, "p2p.enabled");
  const peersRaw = asRecord(raw.peers, "p2p.peers");
  const peers: Record<string, { url: string; token?: string }> = {};
  for (const [name, entry] of Object.entries(peersRaw ?? {})) {
    if (!PEER_NAME.test(name)) {
      throw new Error(`chatroom config: p2p.peers.${name} is not a valid peer name`);
    }
    const peer = asRecord(entry, `p2p.peers.${name}`);
    const url = optionalString(peer?.url, `p2p.peers.${name}.url`);
    if (!url || !/^https?:\/\/[^/]+/.test(url)) {
      throw new Error(`chatroom config: p2p.peers.${name}.url must be an http(s) origin`);
    }
    peers[name] = { url: url.replace(/\/+$/, ""), token: optionalString(peer?.token, `p2p.peers.${name}.token`) };
  }
  return { enabled, peers };
}

function parseRoomConfig(value: unknown): RoomFileConfig {
  const raw = asRecord(value, "root");
  if (!raw) return {};
  return {
    url: optionalString(raw.url, "url"),
    token: optionalString(raw.token, "token"),
    server: parseServer(raw.server),
    client: parseClient(raw.client),
    p2p: parsePeers(raw.p2p),
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

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

/** Environment overrides the file; server.token/client.token are not logged. */
export function resolveServerSettings(file: RoomFileConfig | null, env: NodeJS.ProcessEnv = process.env): ServerSettings {
  const port = envValue(env, "CHAT_ROOM_SERVER_PORT") ?? envValue(env, "PORT") ?? String(file?.server?.port ?? 4399);
  const maxRaw = envValue(env, "CHAT_ROOM_MAX_FILE_SIZE_MB");
  const maxFileSizeMb = maxRaw === undefined ? file?.server?.maxFileSizeMb : Number(maxRaw);
  if (maxFileSizeMb !== undefined && (!Number.isFinite(maxFileSizeMb) || maxFileSizeMb <= 0)) {
    throw new Error("CHAT_ROOM_MAX_FILE_SIZE_MB must be a positive finite number");
  }
  // A configured Channel D config implies opt-in; CHAT_ROOM_CHANNELD=0 still forces it off.
  const channeldRaw = envValue(env, "CHAT_ROOM_CHANNELD");
  const channeldConfig = envValue(env, "CHAT_ROOM_CHANNELD_CONFIG") ?? file?.server?.channeld?.config;
  const channeldEnabled = channeldRaw === undefined
    ? file?.server?.channeld?.enabled ?? Boolean(channeldConfig)
    : channeldRaw === "1" || channeldRaw === "true";
  return {
    host: envValue(env, "CHAT_ROOM_SERVER_HOST") ?? envValue(env, "HOST") ?? file?.server?.host ?? "0.0.0.0",
    port,
    token: envValue(env, "CHAT_ROOM_SERVER_TOKEN") ?? file?.server?.token ?? file?.token,
    stateDir: envValue(env, "CHAT_ROOM_STATE_DIR") ?? file?.server?.stateDir,
    wakeServeUrl: envValue(env, "CHAT_ROOM_WAKE_SERVE_URL") ?? file?.server?.wakeServeUrl ?? "",
    maxFileSizeMb,
    channeld: {
      enabled: channeldEnabled,
      config: channeldConfig,
      stateFile: file?.server?.channeld?.stateFile,
    },
  };
}

/** Environment overrides the file; client.url/token fall back to top-level. */
export function resolveClientSettings(file: RoomFileConfig | null, env: NodeJS.ProcessEnv = process.env): ClientSettings {
  return {
    url: envValue(env, "CHAT_ROOM_SERVER_URL") ?? file?.client?.url ?? file?.url ?? "",
    token: envValue(env, "CHAT_ROOM_SERVER_TOKEN") ?? file?.client?.token ?? file?.token ?? "",
    wakeServeUrl: envValue(env, "CHAT_ROOM_WAKE_SERVE_URL") ?? file?.client?.wakeServeUrl ?? file?.server?.wakeServeUrl ?? "",
  };
}