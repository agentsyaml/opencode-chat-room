// Account form generated from the JSON Schema a plugin declares in initialize.
const CONTROL = { string: "text", secret: "password", number: "number" };

function textFor(field, fallback) {
  return typeof field.label === "string" && field.label.trim() ? field.label : fallback;
}

function addField(container, field, existing, stored, text) {
  const label = document.createElement("label");
  label.className = "field integration-schema-field";
  const caption = document.createElement("span");
  caption.className = "field-label";
  caption.textContent = textFor(field, field.key);
  if (field.required) {
    const required = document.createElement("span");
    required.className = "integration-required";
    required.textContent = " *";
    caption.append(required);
  }
  let control;
  if (field.type === "boolean" || field.type === "select") {
    control = document.createElement("select");
    control.className = "input";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = existing
      ? (stored ? text("integrationsKeepStored") : text("integrationsNotSet"))
      : "";
    control.append(blank);
    const options = field.type === "boolean"
      ? [{ value: "1", label: "True" }, { value: "0", label: "False" }]
      : Array.isArray(field.options) ? field.options : [];
    for (const option of options) {
      const node = document.createElement("option");
      node.value = String(option.value);
      node.textContent = typeof option.label === "string" && option.label ? option.label : String(option.value);
      control.append(node);
    }
    if (!existing && typeof field.default === "string" && field.default !== "") {
      control.value = field.type === "boolean"
        ? (["1", "true", "on", "yes"].includes(field.default.toLowerCase()) ? "1" : "0")
        : field.default;
    }
  } else {
    control = document.createElement("input");
    control.className = "input";
    control.type = CONTROL[field.type] || "text";
    control.autocomplete = field.type === "secret" ? "new-password" : "off";
    if (existing) control.placeholder = stored ? text("integrationsLeaveBlank") : text("integrationsNotSet");
    else if (typeof field.default === "string") control.value = field.default;
  }
  control.dataset.accountKey = field.key;
  control.dataset.accountType = field.type || "string";
  control.dataset.accountRequired = field.required ? "1" : "0";
  control.dataset.accountStored = stored ? "1" : "0";
  label.append(caption, control);
  if (typeof field.description === "string" && field.description.trim()) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = field.description;
    label.append(hint);
  }
  container.append(label);
}

export function renderAccountSchema(container, plugin, account, text) {
  container.textContent = "";
  const fields = Array.isArray(plugin?.account?.schema) ? plugin.account.schema : [];
  container.hidden = fields.length === 0;
  if (!fields.length) return;
  const existing = Boolean(account);
  const stored = new Set(account?.envKeys || []);
  for (const field of fields) {
    if (!field || typeof field.key !== "string") continue;
    addField(container, field, existing, stored.has(field.key), text);
  }
}

/** Values still land in the account env map; blank means "keep stored". */
export function readAccountSchema(container, text) {
  const values = {};
  const keys = new Set();
  const missing = [];
  for (const control of container.querySelectorAll("[data-account-key]")) {
    const key = control.dataset.accountKey;
    keys.add(key);
    const value = String(control.value ?? "").trim();
    if (value !== "") {
      values[key] = value;
      continue;
    }
    if (control.dataset.accountRequired === "1" && control.dataset.accountStored !== "1") {
      const label = control.closest(".integration-schema-field")?.querySelector(".field-label")?.textContent || key;
      missing.push(label.replace(/\s*\*$/, ""));
    }
  }
  if (missing.length) throw new Error(text("integrationsAccountRequired", { fields: missing.join(", ") }));
  return { values, keys };
}