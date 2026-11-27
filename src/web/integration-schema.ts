/// <reference lib="dom" />

// JSON Schema shared by the Monaco JSON language service and the plain-text fallback.
export type RuleAccount = { id: string; platform: string };

export type JsonSchema = {
  type?: "array" | "object" | "string" | "integer" | "number" | "boolean";
  title?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  minimum?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  errorMessage?: string;
};

export type SchemaIssue = { path: Array<string | number>; message: string; keyword: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const accountEnum = (accounts: RuleAccount[]): JsonSchema => ({
  type: "string",
  enum: accounts.map((account) => account.id),
  errorMessage: accounts.length
    ? "Account does not exist. Add it under Accounts first."
    : "Add an account under Accounts first.",
});

const platformEnum = (accounts: RuleAccount[]): JsonSchema => ({
  type: "string",
  enum: [...new Set(accounts.map((account) => account.platform))],
  errorMessage: "Use the platform of the selected account.",
});

function target(accounts: RuleAccount[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["platform", "account", "room"],
    properties: {
      platform: platformEnum(accounts),
      account: accountEnum(accounts),
      room: { type: "string", minLength: 1, description: "Target room ID." },
    },
    allOf: accounts.map((account) => ({
      if: { required: ["account"], properties: { account: { const: account.id } } },
      then: { properties: { platform: { const: account.platform, errorMessage: `Account "${account.id}" uses platform "${account.platform}".` } } },
    })),
  };
}

const transformSchema: JsonSchema = {
  anyOf: [
    { type: "object", additionalProperties: false, required: ["op"], properties: { op: { const: "prefix-source" } } },
    { type: "object", additionalProperties: false, required: ["op"], properties: { op: { const: "trim" } } },
    { type: "object", additionalProperties: false, required: ["op"], properties: { op: { const: "quote-preview" } } },
    {
      type: "object",
      additionalProperties: false,
      required: ["op", "max"],
      properties: { op: { const: "truncate" }, max: { type: "integer", minimum: 1 } },
    },
  ],
};

export function buildRulesSchema(accounts: RuleAccount[]): JsonSchema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Integration rules",
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version", "from", "to"],
      properties: {
        id: { type: "string", minLength: 1, description: "Rule name, unique with its version." },
        version: { type: "integer", minimum: 1, description: "Bump the version to replace this rule." },
        from: {
          type: "object",
          description: "Where the rule reads events from.",
          additionalProperties: false,
          required: ["platform", "account", "room"],
          properties: {
            platform: { const: "chatroom", description: "Source platform; room messages always use chatroom.", errorMessage: "The source platform must be chatroom." },
            account: { const: "center", description: "Source account; room messages always use center.", errorMessage: "The source account must be center." },
            room: { type: "string", minLength: 1, description: "Room ID to watch." },
            event: {
              enum: ["message.created", "message.forward_requested"],
              description: "Event to match; all supported events when omitted.",
            },
          },
        },
        transforms: { type: "array", description: "Transformations applied to the message before delivery.", items: transformSchema },
        to: { type: "array", description: "External accounts and rooms that receive matching messages.", minItems: 1, items: target(accounts) },
        onMissingParent: { enum: ["quote_or_unthreaded", "drop"], description: "What to do when the replied-to parent message is unavailable on the target." },
        onUnsupported: { enum: ["text_with_notice", "drop"], description: "What to do when the target cannot render the message content." },
      },
    },
  } as JsonSchema;
}

export function buildInboundSchema(accounts: RuleAccount[]): JsonSchema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Inbound routes",
    type: "array",
    items: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: {
          type: "object",
          required: ["platform", "account", "room"],
          properties: {
            platform: platformEnum(accounts),
            account: accountEnum(accounts),
            room: { type: "string", minLength: 1, description: "Room ID on the external platform." },
            event: { type: "string", description: "Optional external event filter." },
          },
          allOf: accounts.map((account) => ({
            if: { required: ["account"], properties: { account: { const: account.id } } },
            then: { properties: { platform: { const: account.platform, errorMessage: `Account "${account.id}" uses platform "${account.platform}".` } } },
          })),
        },
        to: {
          type: "object",
          required: ["room"],
          properties: { room: { type: "string", minLength: 1, description: "Chat room ID that receives the message." } },
        },
      },
    },
  } as JsonSchema;
}

function matchesType(value: unknown, type: JsonSchema["type"]): boolean {
  switch (type) {
    case undefined: return true;
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: Array<string | number> = [],
  issues: SchemaIssue[] = [],
): SchemaIssue[] {
  const fail = (message: string, keyword: string, at = path) => {
    issues.push({ path: at, message: schema.errorMessage || message, keyword });
  };
  if (!matchesType(value, schema.type)) {
    fail(`Expected ${schema.type ?? "a supported value"}.`, "type");
    return issues;
  }
  if (schema.const !== undefined && !sameValue(value, schema.const)) {
    fail(`Must be ${JSON.stringify(schema.const)}.`, "const");
  }
  if (schema.enum && !schema.enum.some((item) => sameValue(item, value))) {
    fail(`Must be one of: ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}.`, "enum");
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    fail("Must not be empty.", "minLength");
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    fail(`Must be at least ${schema.minimum}.`, "minimum");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`Add at least ${schema.minItems} item.`, "minItems");
    }
    if (schema.items) value.forEach((item, index) => validateAgainstSchema(item, schema.items!, [...path, index], issues));
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`Missing required field "${key}".`, "required", [...path, key]);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) validateAgainstSchema(child, childSchema, [...path, key], issues);
      else if (schema.additionalProperties === false) fail(`Unknown field "${key}".`, "additionalProperties", [...path, key]);
    }
  }
  for (const branch of schema.allOf ?? []) validateAgainstSchema(value, branch, path, issues);
  if (schema.if && schema.then && validateAgainstSchema(value, schema.if, path, []).length === 0) {
    validateAgainstSchema(value, schema.then, path, issues);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!branches?.length) continue;
    const runs = branches.map((branch) => validateAgainstSchema(value, branch, path, []));
    const passed = runs.filter((run) => run.length === 0).length;
    if (keyword === "anyOf" ? passed === 0 : passed !== 1) {
      if (keyword === "oneOf" && passed > 1) {
        fail("Matches more than one allowed shape.", keyword);
      } else {
        const best = runs.filter((run) => run.length > 0).sort((left, right) => left.length - right.length)[0];
        if (best) issues.push(...best);
        else fail("Does not match any allowed shape.", keyword);
      }
    }
  }
  return issues;
}

export function formatPath(root: string, path: Array<string | number>): string {
  let text = root;
  for (const part of path) text += typeof part === "number" ? `[${part}]` : `.${part}`;
  return text;
}