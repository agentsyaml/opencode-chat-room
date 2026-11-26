// Parsing and account-reference checks for integration rules and inbound routes.
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function cleanError(error, fallback) {
  const value = String(error?.message || error || "").trim()
    .replace(/channeld/gi, "integrations")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(secret|token|password|authorization|api[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return value || fallback;
}

export function stateLabel(state, text) {
  return text({
    started: "integrationsStateStarted", starting: "integrationsStateStarting", stopped: "integrationsStateStopped",
    error: "integrationsStateError", failed: "integrationsStateError",
  }[state] || "integrationsStateUnknown");
}

export function accountBody(account) {
  const body = { id: account.id, platform: account.platform, pluginId: account.pluginId };
  if (account.envClear) { body.env = {}; return body; }
  const setKeys = Object.keys(account.envSet || {});
  if (setKeys.length) body.env = account.envSet;
  const deleted = (account.envDelete || []).filter((key) => !setKeys.includes(key));
  // Delete-only edits must omit env; {} means clear every stored key.
  if (deleted.length) body.envDelete = deleted;
  return body;
}

export function normalizeAccount(account) {
  const envKeys = Array.isArray(account.envKeys) ? account.envKeys.filter((key) => typeof key === "string") : [];
  return {
    id: String(account.id || ""),
    platform: String(account.platform || ""),
    pluginId: String(account.pluginId || ""),
    envKeys,
    storedKeys: [...envKeys],
    envSet: {},
    envDelete: [],
    envClear: false,
    state: typeof account.state === "string" ? account.state : "unknown",
    lastError: typeof account.lastError === "string" ? account.lastError : "",
  };
}

export function knownPlugins(data) {
  const plugins = [...data.plugins];
  for (const account of data.accounts) {
    if (account.pluginId && !plugins.some((plugin) => plugin.pluginId === account.pluginId)) {
      plugins.push({ pluginId: account.pluginId, name: account.pluginId, platform: account.platform });
    }
  }
  return plugins;
}

function jsonLine(value, message) {
  const position = /position (\d+)/.exec(message), row = /line (\d+)/i.exec(message);
  return position ? value.slice(0, Number(position[1])).split("\n").length : row ? Number(row[1]) : 1;
}

export function parseRules(value, accounts, text) {
  let rules;
  try { rules = JSON.parse(value || "[]"); }
  catch (error) {
    throw new Error(text("integrationsInvalidJson", { line: jsonLine(value, String(error.message)) }));
  }
  return checkRules(rules, accounts, text);
}

export function checkRules(rules, accounts, text) {
  if (!Array.isArray(rules)) throw new Error(text("integrationsInvalidRules"));
  const known = new Set(accounts.map((account) => account.id));
  rules.forEach((rule, index) => {
    const ruleNumber = index + 1;
    if (!isRecord(rule)) throw new Error(text("integrationsInvalidRules"));
    const from = rule.from;
    if (!isRecord(from) || from.platform !== "chatroom" || from.account !== "center") {
      throw new Error(text("integrationsFromRequired", { index: ruleNumber }));
    }
    if (!Array.isArray(rule.to) || !rule.to.length) {
      throw new Error(text("integrationsTargetRequired", { index: ruleNumber, target: 1, field: "to" }));
    }
    rule.to.forEach((target, targetIndex) => {
      if (!isRecord(target)) throw new Error(text("integrationsInvalidRules"));
      for (const field of ["platform", "account", "room"]) {
        if (typeof target[field] !== "string" || !target[field].trim()) {
          throw new Error(text("integrationsTargetRequired", { index: ruleNumber, target: targetIndex + 1, field }));
        }
      }
      if (!known.has(target.account)) {
        throw new Error(text("integrationsTargetMissing", { index: ruleNumber, target: targetIndex + 1, account: target.account }));
      }
    });
  });
  return rules;
}

export function parseInbound(value, accounts, text) {
  let inbound;
  try { inbound = JSON.parse(value || "[]"); }
  catch (error) {
    throw new Error(text("integrationsInvalidJson", { line: jsonLine(value, String(error.message)) }));
  }
  return checkInbound(inbound, accounts);
}

export function checkInbound(inbound, accounts) {
  if (!Array.isArray(inbound)) throw new Error("Inbound routes must be a JSON array.");
  const known = new Map(accounts.map((account) => [account.id, account]));
  inbound.forEach((route, index) => {
    const label = `Inbound route ${index + 1}`;
    if (!isRecord(route) || !isRecord(route.from)) throw new Error(`${label}: from is required.`);
    const from = route.from;
    for (const field of ["platform", "account", "room"]) {
      if (typeof from[field] !== "string" || !from[field].trim()) throw new Error(`${label}: from.${field} is required.`);
    }
    if (from.event !== undefined && typeof from.event !== "string") throw new Error(`${label}: from.event must be a string.`);
    const account = known.get(from.account);
    if (!account) throw new Error(`${label}: account “${from.account}” does not exist.`);
    if (account.platform !== from.platform) throw new Error(`${label}: account “${from.account}” belongs to “${account.platform}”.`);
    if (!isRecord(route.to) || typeof route.to.room !== "string" || !route.to.room.trim()) throw new Error(`${label}: to.room is required.`);
  });
  return inbound;
}