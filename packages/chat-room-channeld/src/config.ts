import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Transform =
  | { op: "prefix-source" }
  | { op: "trim" }
  | { op: "truncate"; max: number }
  | { op: "quote-preview" };

export type RuleTarget = { platform: string; account: string; room: string };
export type RuleSource = RuleTarget & { event?: string };

export interface RuleConfig {
  id: string;
  version: number;
  from: RuleSource;
  transforms: Transform[];
  to: RuleTarget[];
  onMissingParent: "quote_or_unthreaded" | "drop";
  onUnsupported: "text_with_notice" | "drop";
}

export interface AccountConfig {
  id: string;
  platform: string;
  adapter: { command: string[]; runtime?: string };
  /** Extra environment variables passed only to this account's adapter process. */
  env?: Record<string, string>;
}

/** A center-only route: an inbound IM event becomes a room notification. */
export interface InboundRoute {
  from: RuleSource;
  to: { room: string };
}

export interface ChannelConfig {
  stateFile: string;
  accounts: AccountConfig[];
  rules: RuleConfig[];
  /** Room notifications for inbound events; never matched by outbound rules. */
  inbound: InboundRoute[];
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, where: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`config: ${where} must be a mapping`);
  }
  return value as RecordValue;
}

const IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ACCOUNT_ENV = 64;
const MAX_ENV_VALUE = 8192;
// The host writes these two after the account env, so a config must not claim them.
const RESERVED_ENV = new Set(["CHANNELD_ACCOUNT_ID", "CHANNELD_PLATFORM"]);

function stringValue(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`config: ${where} must be a non-empty string`);
  }
  return value;
}

function identifierValue(value: unknown, where: string): string {
  const text = stringValue(value, where);
  if (!IDENTIFIER.test(text)) {
    throw new ConfigError(
      `config: ${where} must match /^[A-Za-z0-9._-]+$/ (letters, digits, dot, underscore, hyphen; "/" is not allowed)`,
    );
  }
  return text;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, where);
}

function arrayValue(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`config: ${where} must be a non-empty array`);
  }
  return value;
}

function parseTarget(value: unknown, where: string): RuleTarget {
  const raw = record(value, where);
  return {
    platform: identifierValue(raw.platform, `${where}.platform`),
    account: identifierValue(raw.account, `${where}.account`),
    room: identifierValue(raw.room, `${where}.room`),
  };
}

function parseTransform(value: unknown, where: string): Transform {
  const raw = record(value, where);
  switch (raw.op) {
    case "prefix-source":
    case "trim":
    case "quote-preview":
      return { op: raw.op };
    case "truncate": {
      if (typeof raw.max !== "number" || !Number.isInteger(raw.max) || raw.max < 1) {
        throw new ConfigError(`config: ${where}.max must be a positive integer`);
      }
      return { op: "truncate", max: raw.max };
    }
    default:
      throw new ConfigError(
        `config: ${where}.op must be one of prefix-source, trim, truncate, quote-preview`,
      );
  }
}

function parseAccountEnv(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, where);
  const entries = Object.entries(raw);
  if (entries.length > MAX_ACCOUNT_ENV) {
    throw new ConfigError(`config: ${where} must contain at most ${MAX_ACCOUNT_ENV} variables`);
  }
  const env: Array<[string, string]> = [];
  for (const [key, item] of entries) {
    if (!ENV_KEY.test(key)) {
      throw new ConfigError(
        `config: ${where}.${key} must match /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits, underscore; cannot start with a digit)`,
      );
    }
    if (RESERVED_ENV.has(key)) {
      throw new ConfigError(`config: ${where}.${key} is reserved by the channeld protocol`);
    }
    if (typeof item !== "string") {
      throw new ConfigError(`config: ${where}.${key} must be a string`);
    }
    if (item.length > MAX_ENV_VALUE) {
      throw new ConfigError(`config: ${where}.${key} must be at most ${MAX_ENV_VALUE} characters`);
    }
    env.push([key, item]);
  }
  return Object.fromEntries(env);
}

function parseAccount(value: unknown, where: string): AccountConfig {
  const raw = record(value, where);
  const adapter = record(raw.adapter, `${where}.adapter`);
  const command = arrayValue(adapter.command, `${where}.adapter.command`).map((item, index) =>
    stringValue(item, `${where}.adapter.command[${index}]`),
  );
  return {
    id: identifierValue(raw.id, `${where}.id`),
    platform: identifierValue(raw.platform, `${where}.platform`),
    adapter: { command, runtime: optionalString(adapter.runtime, `${where}.adapter.runtime`) },
    env: parseAccountEnv(raw.env, `${where}.env`),
  };
}

function parseInbound(value: unknown, where: string): InboundRoute {
  const raw = record(value, where);
  const from = record(raw.from, `${where}.from`);
  const to = record(raw.to, `${where}.to`);
  return {
    from: {
      ...parseTarget({ platform: from.platform, account: from.account, room: from.room }, `${where}.from`),
      event: optionalString(from.event, `${where}.from.event`),
    },
    to: { room: stringValue(to.room, `${where}.to.room`) },
  };
}

function parseRule(value: unknown, where: string): RuleConfig {
  const raw = record(value, where);
  const from = record(raw.from, `${where}.from`);
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ConfigError(`config: ${where}.version must be a positive integer`);
  }
  const transforms = raw.transforms === undefined
    ? []
    : arrayValueAllowEmpty(raw.transforms, `${where}.transforms`).map((item, index) =>
      parseTransform(item, `${where}.transforms[${index}]`),
    );
  const missingParent = optionalString(raw.onMissingParent, `${where}.onMissingParent`);
  if (missingParent !== undefined && missingParent !== "quote_or_unthreaded" && missingParent !== "drop") {
    throw new ConfigError(`config: ${where}.onMissingParent must be quote_or_unthreaded or drop`);
  }
  const unsupported = optionalString(raw.onUnsupported, `${where}.onUnsupported`);
  if (unsupported !== undefined && unsupported !== "text_with_notice" && unsupported !== "drop") {
    throw new ConfigError(`config: ${where}.onUnsupported must be text_with_notice or drop`);
  }
  return {
    id: stringValue(raw.id, `${where}.id`),
    version,
    from: {
      ...parseTarget({ platform: from.platform, account: from.account, room: from.room }, `${where}.from`),
      event: optionalString(from.event, `${where}.from.event`),
    },
    transforms,
    to: arrayValue(raw.to, `${where}.to`).map((item, index) => parseTarget(item, `${where}.to[${index}]`)),
    onMissingParent: (missingParent ?? "quote_or_unthreaded") as RuleConfig["onMissingParent"],
    onUnsupported: (unsupported ?? "text_with_notice") as RuleConfig["onUnsupported"],
  };
}

function arrayValueAllowEmpty(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigError(`config: ${where} must be an array`);
  return value;
}

/** Validate a parsed YAML/JSON value. */
export function parseConfig(value: unknown): ChannelConfig {
  const raw = record(value, "root");
  const stateFile = stringValue(raw.stateFile, "stateFile");
  const accounts = arrayValue(raw.accounts, "accounts").map((item, index) =>
    parseAccount(item, `accounts[${index}]`),
  );
  const rules = raw.rules === undefined
    ? []
    : arrayValueAllowEmpty(raw.rules, "rules").map((item, index) => parseRule(item, `rules[${index}]`));
  const inbound = raw.inbound === undefined
    ? []
    : arrayValueAllowEmpty(raw.inbound, "inbound").map((item, index) =>
      parseInbound(item, `inbound[${index}]`),
    );

  const accountIds = new Set<string>();
  for (const account of accounts) {
    if (accountIds.has(account.id)) throw new ConfigError(`config: duplicate account id "${account.id}"`);
    accountIds.add(account.id);
  }
  const ruleKeys = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.id}@${rule.version}`;
    if (ruleKeys.has(key)) throw new ConfigError(`config: duplicate rule "${rule.id}" version ${rule.version}`);
    ruleKeys.add(key);
  }
  return { stateFile, accounts, rules, inbound };
}

/** Load a config file. YAML parsing also accepts JSON documents. */
export function loadConfig(file: string): ChannelConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(
      `config: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new ConfigError(
      `config: invalid YAML/JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseConfig(parsed);
}