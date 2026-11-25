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
}

export interface ChannelConfig {
  stateFile: string;
  accounts: AccountConfig[];
  rules: RuleConfig[];
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, where: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`config: ${where} must be a mapping`);
  }
  return value as RecordValue;
}

const IDENTIFIER = /^[A-Za-z0-9._-]+$/;

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
  return { stateFile, accounts, rules };
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