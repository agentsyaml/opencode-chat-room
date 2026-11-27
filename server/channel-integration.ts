// Admin-managed Channel D integration state: uploaded JavaScript adapters and
// a server-owned YAML config under <stateDir>/integrations. Account commands are
// never accepted from the API; the server always writes ["node", pluginPath].
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AdapterProcess } from "../packages/chat-room-channeld/src/adapter.ts";
import type { AccountCapabilities } from "../packages/chat-room-channeld/src/protocol.ts";
import {
  parseConfig,
  type AccountConfig,
  type ChannelConfig,
  type RuleConfig,
} from "../packages/chat-room-channeld/src/config.ts";
import { validateTargets } from "../packages/chat-room-channeld/src/host-helpers.ts";
import { databasePath } from "../src/state/store.ts";
import { adminMessage } from "./channel-settings.ts";

export interface IntegrationRuntimeView {
  host: {
    accountRuntimeStates: ReadonlyMap<string, { state: string; lastError?: string }>;
  };
  config: ChannelConfig;
}

export interface IntegrationControl {
  enabled(): boolean;
  runtime(): IntegrationRuntimeView | undefined;
  activate(configPath: string): Promise<Response>;
  disable(): Promise<Response>;
}

type PluginMeta = {
  id: string;
  name: string;
  platform: string;
  displayName?: string;
  account?: AccountCapabilities;
};
type ManagedAccount = {
  id: string;
  platform: string;
  pluginId: string;
  env?: Record<string, string>;
};

const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|mjs|cjs|ts)$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(["CHANNELD_ACCOUNT_ID", "CHANNELD_PLATFORM"]);
const MAX_ENV = 64;
const MAX_ENV_VALUE = 8192;
const MAX_PLUGIN_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 3000;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function integrationRoot(): string {
  return path.resolve(path.dirname(databasePath()), "integrations");
}

function pluginsRoot(): string {
  return path.join(integrationRoot(), "plugins");
}

function managedConfigPath(): string {
  return path.join(integrationRoot(), "channeld.yml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicError(error: unknown, fallback = "invalid integration request"): string {
  const message = adminMessage(error)
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"']+/g, "[path]")
    .trim();
  return message || fallback;
}

/** Handshake failures keep the reason but never echo adapter stderr (env values). */
function handshakeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return publicError(new Error(raw.split(/\nstderr:/)[0] ?? ""), "plugin handshake failed");
}

function envEntry(key: string, item: unknown): [string, string] {
  if (!ENV_KEY.test(key)) throw new Error(`env key ${key} is invalid`);
  if (RESERVED_ENV.has(key)) throw new Error(`env key ${key} is reserved`);
  if (typeof item !== "string") throw new Error(`env ${key} must be a string`);
  if (item.length > MAX_ENV_VALUE) throw new Error(`env ${key} is too long`);
  return [key, item];
}

function envValue(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("env must be an object of string values");
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV) throw new Error(`env must contain at most ${MAX_ENV} variables`);
  return Object.fromEntries(entries.map(([key, item]) => envEntry(key, item)));
}

/** Partial env edits: validate only the supplied keys, not the whole account. */
function envPatch(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("env must be an object of string values");
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV) throw new Error(`env must contain at most ${MAX_ENV} variables`);
  return Object.fromEntries(entries.map(([key, item]) => envEntry(key, item)));
}

function envDeleteKeys(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("envDelete must be an array of env names");
  return value.map((key) => {
    if (typeof key !== "string" || !ENV_KEY.test(key)) {
      throw new Error(`envDelete key ${String(key)} is invalid`);
    }
    return key;
  });
}

function accountEnv(
  id: string,
  item: Record<string, unknown>,
  previous?: Record<string, string>,
): Record<string, string> | undefined {
  const hasEnv = Object.prototype.hasOwnProperty.call(item, "env");
  const hasDelete = Object.prototype.hasOwnProperty.call(item, "envDelete");
  if (!hasEnv && !hasDelete) return previous;
  const patch = hasEnv ? envPatch(item.env) : undefined;
  const deletes = hasDelete ? envDeleteKeys(item.envDelete) : [];
  for (const key of deletes) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      throw new Error(`account ${id} lists ${key} in both env and envDelete`);
    }
  }
  // Empty env clears the account; a non-empty or omitted env starts from existing keys.
  const clears = patch !== undefined && Object.keys(patch).length === 0;
  const env = clears ? {} : { ...(previous ?? {}), ...(patch ?? {}) };
  for (const key of deletes) delete env[key];
  // Re-validate the merged map so deletions cannot hide bounds violations.
  return envValue(env);
}

async function readJsonBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) return { ok: false };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function atomicWrite(file: string, text: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The original rename error is the useful one.
    }
    throw error;
  }
}

function pluginDir(pluginId: string): string {
  return path.join(pluginsRoot(), pluginId);
}

function readPlugin(pluginId: string): { dir: string; file: string; meta: PluginMeta } | undefined {
  if (!IDENTIFIER.test(pluginId)) return undefined;
  const dir = pluginDir(pluginId);
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(meta)) return undefined;
  const { id, name, platform } = meta;
  if (id !== pluginId || typeof name !== "string" || !PLUGIN_NAME.test(name)) return undefined;
  if (typeof platform !== "string" || !IDENTIFIER.test(platform)) return undefined;
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir || !existsSync(file)) return undefined;
  const displayName = typeof meta.displayName === "string" && meta.displayName.trim()
    ? meta.displayName.trim()
    : undefined;
  const account = isRecord(meta.account) ? meta.account as AccountCapabilities : undefined;
  return {
    dir,
    file,
    meta: { id, name, platform, ...(displayName ? { displayName } : {}), ...(account ? { account } : {}) },
  };
}

function downloadPlugin(pluginId: string): Response {
  const plugin = readPlugin(pluginId);
  if (!plugin) return json({ error: "plugin not found" }, 404);
  let bytes: Buffer;
  try {
    bytes = readFileSync(plugin.file);
  } catch {
    return json({ error: "plugin not found" }, 404);
  }
  const name = plugin.meta.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(plugin.meta.name)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function uploadedPlugins(): Array<{ pluginId: string; name: string; platform: string; displayName?: string; account?: AccountCapabilities }> {
  let entries: string[];
  try {
    entries = readdirSync(pluginsRoot());
  } catch {
    return [];
  }
  return entries
    .flatMap((pluginId) => {
      const plugin = readPlugin(pluginId);
      return plugin
        ? [{
            pluginId: plugin.meta.id,
            name: plugin.meta.name,
            platform: plugin.meta.platform,
            ...(plugin.meta.displayName ? { displayName: plugin.meta.displayName } : {}),
            ...(plugin.meta.account ? { account: plugin.meta.account } : {}),
          }]
        : [];
    })
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

type ManagedState = {
  config: ChannelConfig;
  accounts: ManagedAccount[];
  rules: RuleConfig[];
  inbound: ChannelConfig["inbound"];
  text: string;
};

function readManaged(): ManagedState | undefined {
  const file = managedConfigPath();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const raw: unknown = parseYaml(text);
  if (!isRecord(raw)) throw new Error("managed integration must be a mapping");
  const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  const pluginIds = new Map<string, string>();
  for (const item of rawAccounts) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.pluginId !== "string") continue;
    pluginIds.set(item.id, item.pluginId);
  }
  const config = parseConfig({ ...raw, stateFile: "managed-validation.sqlite" });
  const accounts: ManagedAccount[] = config.accounts.map((account) => {
    const pluginId = pluginIds.get(account.id) ?? "";
    return {
      id: account.id,
      platform: account.platform,
      pluginId: IDENTIFIER.test(pluginId) ? pluginId : "",
      env: account.env,
    };
  });
  return { config, accounts, rules: config.rules, inbound: config.inbound, text };
}

function integrationSnapshot(control: IntegrationControl): Record<string, unknown> {
  let managed: ManagedState | undefined;
  try {
    managed = readManaged();
  } catch {
    // An unreadable managed file must not hide a healthy external runtime.
    managed = undefined;
  }
  const runtime = control.runtime();
  // A runtime can be started from an external YAML file. Its config is readable
  // but must never be silently replaced by a managed save.
  const external = !managed && runtime ? runtime.config : undefined;
  const source = managed ? "managed" : external ? "external" : "none";
  const editable = Boolean(managed) || !runtime;
  const sourceAccounts: ManagedAccount[] = managed?.accounts
    ?? (external?.accounts ?? []).map((account) => ({
      id: account.id,
      platform: account.platform,
      pluginId: "",
      env: account.env,
    }));
  const states = runtime?.host.accountRuntimeStates;
  const accounts = sourceAccounts.map((account) => {
    const live = states?.get(`${account.platform}/${account.id}`);
    const entry: Record<string, unknown> = {
      id: account.id,
      platform: account.platform,
      pluginId: account.pluginId,
      envKeys: Object.keys(account.env ?? {}).sort(),
      state: live?.state ?? "unknown",
    };
    if (live?.lastError) {
      const stderrAt = live.lastError.indexOf("stderr:");
      entry.lastError = publicError(new Error(stderrAt >= 0 ? live.lastError.slice(0, stderrAt) : live.lastError));
    }
    return entry;
  });
  return {
    enabled: control.enabled(),
    source,
    editable,
    accounts,
    rules: managed?.rules ?? external?.rules ?? [],
    inbound: managed?.inbound ?? external?.inbound ?? [],
    plugins: uploadedPlugins(),
  };
}

function parseAccounts(value: unknown, previous?: ManagedState): ManagedAccount[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("accounts must be a non-empty array");
  }
  const oldEnv = new Map(previous?.accounts.map((account) => [account.id, account.env]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`accounts[${index}] must be an object`);
    for (const key of ["command", "args", "argv", "adapter", "runtime", "cwd", "envFile"]) {
      if (Object.prototype.hasOwnProperty.call(item, key)) {
        throw new Error(`accounts[${index}].${key} is managed by the server; use pluginId and env`);
      }
    }
    const { id, platform, pluginId } = item;
    if (typeof id !== "string" || !IDENTIFIER.test(id)) throw new Error(`accounts[${index}].id is invalid`);
    if (seen.has(id)) throw new Error(`duplicate account id ${id}`);
    seen.add(id);
    if (typeof platform !== "string" || !IDENTIFIER.test(platform)) {
      throw new Error(`accounts[${index}].platform is invalid`);
    }
    if (typeof pluginId !== "string" || !IDENTIFIER.test(pluginId)) {
      throw new Error(`accounts[${index}].pluginId is invalid`);
    }
    const plugin = readPlugin(pluginId);
    if (!plugin) throw new Error(`accounts[${index}].pluginId does not exist`);
    if (plugin.meta.platform !== platform) {
      throw new Error(`accounts[${index}].platform does not match its plugin`);
    }
    // Omitted env keeps current values, {} clears, non-empty merges, envDelete prunes.
    const env = accountEnv(id, item, oldEnv.get(id));
    return { id, platform, pluginId, env };
  });
}

async function putIntegration(req: Request, control: IntegrationControl): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body.ok || !isRecord(body.value)) {
    return json({ error: "integration body must be a JSON object" }, 400);
  }
  if (typeof body.value.enabled !== "boolean") {
    return json({ error: "enabled must be true or false" }, 400);
  }
  const file = managedConfigPath();
  let previousText: string | undefined;
  try {
    previousText = readFileSync(file, "utf8");
  } catch {
    previousText = undefined;
  }
  let previous: ManagedState | undefined;
  try {
    previous = readManaged();
  } catch {
    previous = undefined;
  }
  // A running external config has no managed file to merge with; saving would
  // replace a live runtime from a different source. Require an explicit disable.
  if (!previous && control.runtime()) {
    return json({
      error: "active integrations use an external configuration file; disable it before saving managed integrations",
    }, 409);
  }

  let accounts: ManagedAccount[];
  let config: ChannelConfig;
  let rawAccounts: Array<Record<string, unknown>>;
  try {
    accounts = parseAccounts(body.value.accounts, previous);
    rawAccounts = accounts.map((account) => {
      const plugin = readPlugin(account.pluginId)!;
      return {
        id: account.id,
        platform: account.platform,
        pluginId: account.pluginId,
        adapter: { command: ["node", plugin.file] },
        ...(account.env ? { env: account.env } : {}),
      };
    });
    const rules = body.value.rules === undefined ? [] : body.value.rules;
    const inbound = body.value.inbound === undefined ? previous?.inbound ?? [] : body.value.inbound;
    config = parseConfig({
      accounts: rawAccounts,
      rules,
      inbound,
      stateFile: "managed-validation.sqlite",
    });
    validateTargets(config);
  } catch (error) {
    return json({ error: publicError(error) }, 400);
  }

  const text = stringifyYaml({
    accounts: rawAccounts,
    rules: config.rules,
    ...(config.inbound.length > 0 ? { inbound: config.inbound } : {}),
  });
  try {
    mkdirSync(integrationRoot(), { recursive: true, mode: 0o700 });
    atomicWrite(file, text);
  } catch (error) {
    return json({ error: publicError(error, "could not save integration") }, 400);
  }

  const response = body.value.enabled ? await control.activate(file) : await control.disable();
  if (!response.ok) {
    try {
      if (previousText === undefined) rmSync(file, { force: true });
      else atomicWrite(file, previousText);
    } catch {
      // The runtime already reported the failure; stale config is the lesser risk.
    }
    return response;
  }

  if (previous) {
    const kept = new Set(accounts.map((account) => account.pluginId));
    for (const old of previous.accounts) {
      if (!old.pluginId || !IDENTIFIER.test(old.pluginId) || kept.has(old.pluginId)) continue;
      try {
        rmSync(pluginDir(old.pluginId), { recursive: true, force: true });
      } catch {
        // Orphan cleanup is best effort.
      }
    }
  }
  return json(integrationSnapshot(control));
}

async function getIntegration(control: IntegrationControl): Promise<Response> {
  try {
    return json(integrationSnapshot(control));
  } catch (error) {
    return json({ error: publicError(error, "managed integration is unreadable") }, 500);
  }
}

export async function handleIntegrationAdmin(
  req: Request,
  url: URL,
  control: IntegrationControl,
): Promise<Response | undefined> {
  const download = /^\/channeld\/plugins\/([^/]+)\/download$/.exec(url.pathname);
  if (download) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    let pluginId: string;
    try { pluginId = decodeURIComponent(download[1]!); } catch { return json({ error: "plugin not found" }, 404); }
    return downloadPlugin(pluginId);
  }
  if (url.pathname === "/channeld/plugins") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return uploadPlugin(req);
  }
  if (url.pathname === "/channeld/integration") {
    if (req.method === "GET") return getIntegration(control);
    if (req.method === "PUT") return putIntegration(req, control);
    return json({ error: "method not allowed" }, 405);
  }
  return undefined;
}

async function uploadPlugin(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body.ok || !isRecord(body.value)) {
    return json({ error: "plugin body must be a JSON object" }, 400);
  }
  const { name = "plugin.js", source } = body.value;
  if (typeof name !== "string" || !PLUGIN_NAME.test(name) || name.length > 128) {
    return json({ error: "name must be a safe .js, .mjs, .cjs, or .ts file name" }, 400);
  }
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_PLUGIN_BYTES) {
    return json({ error: `source must be UTF-8 text of at most ${MAX_PLUGIN_BYTES} bytes` }, 400);
  }

  const root = integrationRoot();
  const pluginId = randomUUID();
  const tempDir = path.join(root, "tmp", pluginId);
  const finalDir = pluginDir(pluginId);
  const pluginFile = path.join(tempDir, name);
  try {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    writeFileSync(pluginFile, source, { mode: 0o600 });

    // A probe runs initialize only: it proves the adapter speaks the protocol
    // and declares its platform/capabilities without starting the account or
    // requiring credentials.
    const account: AccountConfig = {
      id: `plugin-${pluginId}`,
      platform: "plugin",
      adapter: { command: ["node", pluginFile] },
    };
    const adapter = new AdapterProcess({
      account,
      onIngest: async () => ({ duplicate: false }),
      onExit: () => {},
      initializeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
    const probed = await adapter.probe();
    const platform = probed.platform;
    if (!platform || !IDENTIFIER.test(platform)) {
      throw new Error("plugin must declare a platform in initialize");
    }
    const meta: PluginMeta = {
      id: pluginId,
      name,
      platform,
      ...(probed.capabilities?.displayName ? { displayName: probed.capabilities.displayName } : {}),
      ...(probed.capabilities?.account ? { account: probed.capabilities.account } : {}),
    };
    writeFileSync(path.join(tempDir, "meta.json"), `${JSON.stringify(meta)}\n`, { mode: 0o600 });

    mkdirSync(pluginsRoot(), { recursive: true, mode: 0o700 });
    if (existsSync(finalDir)) throw new Error("plugin id collision");
    renameSync(tempDir, finalDir);
    return json({
      pluginId,
      name,
      platform,
      ...(meta.displayName ? { displayName: meta.displayName } : {}),
      ...(meta.account ? { account: meta.account } : {}),
    }, 201);
  } catch (error) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort: the temp directory may already be gone or unreadable.
    }
    return json({ error: handshakeError(error) }, 400);
  }
}