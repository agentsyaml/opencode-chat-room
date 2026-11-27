// Settings > Integrations: runtime switch, accounts, plugin uploads, and rules.
import { initIntegrationEditor } from "./integration-editor.js";
import { iconNode } from "./icons.js";
import { readAccountSchema, renderAccountSchema } from "./integration-account-schema.js";
import { checkInbound, checkRules, knownPlugins, normalizeAccount, parseInbound, parseRules } from "./integration-values.js";
import { accountBody, cleanError, stateLabel } from "./integration-values.js";

const MAX_SOURCE = 256 * 1024;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|mjs|cjs|ts)$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function initIntegrations(app) {
  const $ = app.$;
  const panel = $("#settingsPanelIntegrations"); if (!panel) return;
  const enabledInput = $("#inIntegrationsEnabled"), statusText = $("#integrationStatus");
  const integrationBody = $("#integrationBody"), disabledHint = $("#integrationDisabledHint");
  const panelError = $("#integrationError"), accountsList = $("#integrationAccounts");
  const externalNotice = $("#integrationExternalNotice"), addAccountButton = $("#btnAddIntegrationAccount");
  const uploadPluginButton = $("#btnUploadPlugin");
  const accountsEmpty = $("#integrationAccountsEmpty"), pluginsList = $("#integrationPlugins");
  const pluginsEmpty = $("#integrationPluginsEmpty");
  const rulesError = $("#integrationRulesError"), saveButton = $("#btnSaveIntegrations");
  const accountDialog = $("#integrationAccountDialog"), accountForm = $("#integrationAccountForm");
  const accountError = $("#integrationAccountError"), accountId = $("#integrationAccountId");
  const accountPlugin = $("#integrationAccountPlugin");
  const accountSchema = $("#integrationAccountSchema"), accountSchemaField = $("#integrationAccountSchemaField"), accountAdvanced = $("#integrationAccountAdvanced");
  const accountEnv = $("#integrationAccountEnv"), accountEnvNote = $("#integrationAccountEnvNote");
  const accountClear = $("#btnClearAccountEnv"), accountAddEnv = $("#btnAddAccountEnv");
  const pluginDialog = $("#integrationPluginDialog"), pluginForm = $("#integrationPluginForm");
  const pluginError = $("#integrationPluginError"), pluginFile = $("#integrationPluginFile");
  let data = { enabled: false, source: "managed", editable: true, accounts: [], rules: [], inbound: [], plugins: [] };
  let initialInbound = "[]";
  let loaded = false, loading = false, saving = false, accountDraft = null, clearEnv = false;
  let pluginUploadSource = "", pluginUploadName = "";

  const text = (key, values) => app.t(key, values);
  const clean = (error) => cleanError(error, text("integrationsLoadFailed"));
  const showPanelError = (error) => { panelError.textContent = clean(error); panelError.hidden = false; };
  const hidePanelError = () => { panelError.hidden = true; };
  const showStatus = (value) => { statusText.textContent = value; };
  const showAccountError = (error) => { accountError.textContent = clean(error); accountError.hidden = false; };
  const hideAccountError = () => { accountError.hidden = true; };
  const showPluginError = (error) => { pluginError.textContent = clean(error); pluginError.hidden = false; };
  const hidePluginError = () => { pluginError.hidden = true; };
  const showRulesError = (value) => { rulesError.textContent = value; rulesError.hidden = false; };
  const hideRulesError = () => { rulesError.hidden = true; };
  const rulesSection = initIntegrationEditor(app, {
    kind: "rules",
    editor: "#integrationRulesEditor",
    textarea: "#integrationRules",
    fallback: "#integrationRulesFallback",
    error: "#integrationRulesError",
    errors: "#integrationRulesErrorList",
    formats: "#integrationRulesFormat",
    getValue: () => data.rules,
    getAccounts: () => data.accounts,
  });
  const inboundSection = initIntegrationEditor(app, {
    kind: "inbound",
    editor: "#integrationInboundEditor",
    textarea: "#integrationInbound",
    fallback: "#integrationInboundFallback",
    error: "#integrationInboundError",
    errors: "#integrationInboundErrorList",
    formats: "#integrationInboundFormat",
    getValue: () => data.inbound,
    getAccounts: () => data.accounts,
  });

  function applyEditableState() {
    const editable = data.editable !== false;
    if (externalNotice) externalNotice.hidden = editable;
    saveButton.disabled = saving || !editable;
    if (addAccountButton) addAccountButton.disabled = !editable;
    if (uploadPluginButton) uploadPluginButton.disabled = !editable;
    rulesSection.setEditable(editable);
    inboundSection.setEditable(editable);
  }

  function applyEnabledState() {
    const enabled = enabledInput.checked;
    integrationBody.hidden = !enabled;
    disabledHint.hidden = enabled;
  }

  const pluginNameOf = (pluginId) => knownPlugins(data).find((plugin) => plugin.pluginId === pluginId)?.name || pluginId;

  function adopt(snapshot) {
    const raw = isRecord(snapshot) ? snapshot : {};
    data = {
      enabled: raw.enabled === true,
      source: typeof raw.source === "string" ? raw.source : "managed",
      editable: raw.editable !== false,
      accounts: Array.isArray(raw.accounts) ? raw.accounts.filter(isRecord).map(normalizeAccount) : [],
      rules: Array.isArray(raw.rules) ? raw.rules : [],
      inbound: Array.isArray(raw.inbound) ? raw.inbound : data.inbound,
      plugins: Array.isArray(raw.plugins)
        ? raw.plugins.filter((plugin) => isRecord(plugin) && typeof plugin.pluginId === "string" && typeof plugin.name === "string" && typeof plugin.platform === "string")
        : data.plugins,
    };
    initialInbound = JSON.stringify(data.inbound);
    loaded = true;
  }

  function renderAccounts() {
    accountsList.textContent = "";
    for (const account of data.accounts) {
      const row = document.createElement("li");
      row.className = "integration-account";
      const main = document.createElement("div");
      main.className = "integration-account-main";
      const head = document.createElement("p");
      head.className = "integration-account-head";
      const id = document.createElement("span");
      id.className = "integration-account-id";
      id.textContent = account.id;
      const platform = document.createElement("span");
      platform.className = "integration-platform";
      platform.textContent = account.platform;
      const state = document.createElement("span");
      state.className = "integration-state";
      state.dataset.state = account.state;
      state.textContent = stateLabel(account.state, text);
      head.append(id, platform, state);
      const meta = document.createElement("p");
      meta.className = "integration-account-meta";
      const env = account.envClear ? "—" : account.envKeys.length ? account.envKeys.join(", ") : "—";
      meta.textContent = `${text("integrationsPlugin")}: ${pluginNameOf(account.pluginId)} · ${text("integrationsEnv")}: ${env}`;
      main.append(head, meta);
      if (account.lastError) {
        const error = document.createElement("p");
        error.className = "integration-account-error";
        error.textContent = `${text("integrationsLastError")}: ${clean(account.lastError)}`;
        main.append(error);
      }
      const actions = document.createElement("div");
      actions.className = "integration-account-actions";
      const edit = document.createElement("button");
      edit.type = "button"; edit.className = "btn ghost small"; edit.textContent = text("integrationsEdit");
      edit.setAttribute("aria-label", `${text("integrationsEdit")}: ${account.id}`);
      edit.disabled = data.editable === false;
      edit.addEventListener("click", () => openAccount(account));
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "btn ghost small danger-text"; remove.textContent = text("integrationsRemove");
      remove.setAttribute("aria-label", `${text("integrationsRemove")}: ${account.id}`);
      remove.disabled = data.editable === false;
      remove.addEventListener("click", async () => {
        if (data.editable === false) return;
        if (!(await app.confirmAction(text("integrationsRemoveAccountConfirm", { id: account.id })))) return;
        data.accounts = data.accounts.filter((item) => item.id !== account.id);
        renderAccounts();
        showStatus(text("integrationsAccountRemoved"));
      });
      actions.append(edit, remove);
      row.append(main, actions);
      accountsList.append(row);
    }
    accountsEmpty.hidden = data.accounts.length > 0;
    rulesSection.setAccounts(data.accounts);
    inboundSection.setAccounts(data.accounts);
  }

  function renderPlugins() {
    const plugins = knownPlugins(data);
    pluginsList.textContent = "";
    for (const plugin of plugins) {
      const row = document.createElement("li");
      row.className = "integration-plugin";
      const name = document.createElement("span");
      name.className = "integration-plugin-name";
      name.textContent = plugin.name;
      const platform = document.createElement("span");
      platform.className = "integration-platform";
      platform.textContent = plugin.platform;
      const download = document.createElement("button");
      download.type = "button";
      download.className = "btn ghost small integration-plugin-download";
      download.title = text("integrationsDownloadPlugin", { name: plugin.name });
      download.setAttribute("aria-label", download.title);
      download.append(iconNode("arrow_download"));
      download.addEventListener("click", () => void downloadPlugin(plugin, download));
      row.append(name, platform, download);
      pluginsList.append(row);
    }
    pluginsEmpty.hidden = plugins.length > 0;
  }

  async function downloadPlugin(plugin, button) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const blob = await app.apiBlob(`/channeld/plugins/${encodeURIComponent(plugin.pluginId)}/download`);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = plugin.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      showPanelError(error);
    } finally { button.disabled = false; }
  }

  function renderRules() {
    rulesSection.refresh();
    inboundSection.refresh();
    rulesSection.setAccounts(data.accounts);
    inboundSection.setAccounts(data.accounts);
    hideRulesError();
  }

  function renderAll() {
    enabledInput.checked = data.enabled;
    renderAccounts();
    renderPlugins();
    renderRules();
    applyEnabledState();
    applyEditableState();
  }

  async function load(force = false) {
    if (loading || loaded && !force) return;
    loading = true;
    void rulesSection.ensure();
    void inboundSection.ensure();
    hidePanelError();
    showStatus(text("integrationsLoading"));
    try {
      adopt(await app.api("/channeld/integration", { cache: "no-store" }));
      renderAll();
      showStatus("");
    } catch (error) {
      showStatus("");
      showPanelError(error);
    } finally { loading = false; }
  }
  app.loadIntegrations = () => { void load(true); };

  function setSaving(busy) {
    saving = busy;
    saveButton.disabled = busy || data.editable === false;
    enabledInput.disabled = busy;
  }

  let envMenuSerial = 0;

  function envFields() {
    const plugin = knownPlugins(data).find((item) => item.pluginId === accountPlugin.value);
    return (plugin?.account?.env ?? []).filter((field) => ENV_KEY.test(field.key));
  }

  function closeEnvMenus(except) {
    for (const menu of accountEnv.querySelectorAll(".integration-env-menu")) {
      if (menu === except) continue;
      menu.hidden = true;
      menu.parentElement?.querySelector(".integration-env-key")?.setAttribute("aria-expanded", "false");
    }
  }

  function addEnvRow(container, entry = {}, existing = false, onRemove = null) {
    const row = document.createElement("div");
    row.className = `integration-env-row${existing ? " is-stored" : ""}`;
    const key = document.createElement("input");
    key.className = "input integration-env-key";
    key.value = entry.key || "";
    key.readOnly = existing;
    key.placeholder = text("integrationsEnvKey");
    key.setAttribute("aria-label", text("integrationsEnvKey"));
    key.autocomplete = "off";
    const value = document.createElement("input");
    value.className = "input integration-env-value";
    value.type = "password";
    value.value = "";
    value.placeholder = existing ? text("integrationsLeaveBlank") : "";
    value.setAttribute("aria-label", text("integrationsEnvValue"));
    value.autocomplete = "new-password";
    let keyControl = key;
    if (!existing) {
      const combo = document.createElement("div");
      combo.className = "integration-env-combo";
      const menu = document.createElement("div");
      menu.className = "integration-env-menu";
      menu.id = `integrationEnvMenu-${++envMenuSerial}`;
      menu.role = "listbox";
      menu.hidden = true;
      key.setAttribute("role", "combobox");
      key.setAttribute("aria-autocomplete", "list");
      key.setAttribute("aria-expanded", "false");
      key.setAttribute("aria-controls", menu.id);
      const hide = () => {
        menu.hidden = true;
        key.setAttribute("aria-expanded", "false");
      };
      const choose = (option) => {
        key.value = option.dataset.key;
        hide();
        value.focus();
      };
      const renderMenu = () => {
        closeEnvMenus(menu);
        const used = new Set([...container.querySelectorAll(".integration-env-key")]
          .map((input) => input.value.trim())
          .filter(Boolean));
        const query = key.value.trim().toLowerCase();
        const matches = envFields().filter((field) => !used.has(field.key)).filter((field) => {
          if (!query) return true;
          return [field.key, field.label, field.description]
            .some((text) => String(text ?? "").toLowerCase().includes(query));
        });
        menu.replaceChildren(...matches.map((field) => {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "integration-env-option";
          option.dataset.key = field.key;
          option.tabIndex = -1;
          option.setAttribute("role", "option");
          const name = document.createElement("span");
          name.className = "integration-env-option-key";
          name.textContent = field.key;
          option.append(name);
          const detail = [field.label, field.description].filter(Boolean).join(" · ");
          if (detail) {
            const description = document.createElement("span");
            description.className = "integration-env-option-desc";
            description.textContent = detail;
            option.append(description);
          }
          option.addEventListener("mousedown", (event) => event.preventDefault());
          option.addEventListener("click", () => choose(option));
          option.addEventListener("keydown", (event) => {
            const options = [...menu.querySelectorAll(".integration-env-option")];
            const index = options.indexOf(option);
            if (event.key === "ArrowDown") {
              event.preventDefault();
              options[(index + 1) % options.length]?.focus();
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              options[(index - 1 + options.length) % options.length]?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              hide();
              key.focus();
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(option);
            }
          });
          return option;
        }));
        menu.hidden = matches.length === 0;
        key.setAttribute("aria-expanded", String(!menu.hidden));
      };
      key.addEventListener("focus", renderMenu);
      key.addEventListener("click", renderMenu);
      key.addEventListener("input", renderMenu);
      key.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (menu.hidden) renderMenu();
          menu.querySelector(".integration-env-option")?.focus();
        } else if (event.key === "Escape") {
          hide();
        }
      });
      key.addEventListener("blur", () => {
        setTimeout(() => { if (!combo.contains(document.activeElement)) hide(); }, 0);
      });
      combo.append(key, menu);
      keyControl = combo;
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn ghost small integration-env-remove";
    remove.append(iconNode("subtract"));
    remove.setAttribute("aria-label", text("integrationsRemove"));
    remove.setAttribute("title", text("integrationsRemove"));
    remove.addEventListener("click", () => {
      const currentKey = key.value.trim();
      row.remove();
      onRemove?.(currentKey, existing);
    });
    row.append(keyControl, value, remove);
    container.append(row);
    return row;
  }

  function readEnv(container) {
    const values = {};
    for (const row of container.querySelectorAll(".integration-env-row")) {
      const key = row.querySelector(".integration-env-key").value.trim();
      const value = row.querySelector(".integration-env-value").value;
      if (!key && !value) continue;
      if (!ENV_KEY.test(key) || Object.hasOwn(values, key)) throw new Error(text("integrationsEnvInvalid"));
      if (value !== "") values[key] = value;
    }
    return values;
  }

  function fillPlugins(selected) {
    accountPlugin.textContent = "";
    const plugins = knownPlugins(data);
    if (!plugins.length) {
      const option = document.createElement("option");
      option.value = ""; option.textContent = text("integrationsPluginFirst");
      accountPlugin.append(option);
    }
    for (const plugin of plugins) {
      const option = document.createElement("option");
      option.value = plugin.pluginId;
      option.textContent = `${plugin.name} · ${plugin.platform}`;
      accountPlugin.append(option);
    }
    accountPlugin.value = plugins.some((plugin) => plugin.pluginId === selected) ? selected : plugins[0]?.pluginId || "";
  }

  /** Stable once saved; a blank ID is only a convenience for new accounts. */
  function newAccountId(plugin) {
    const prefix = String(plugin?.platform || "account").replace(/[^A-Za-z0-9._-]/g, "") || "account";
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return `${prefix}-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function setClearEnv(next) {
    clearEnv = next;
    accountClear.textContent = text(next ? "integrationsKeepEnv" : "integrationsClearEnv");
    accountEnvNote.hidden = !next;
    accountEnvNote.textContent = next ? text("integrationsClearEnvActive") : "";
    accountAddEnv.disabled = next;
    for (const control of accountEnv.querySelectorAll("input, button")) control.disabled = next;
    for (const control of accountSchema.querySelectorAll("input, select, button")) control.disabled = next;
  }

  function removeStoredKey(key) {
    if (!key || !accountDraft) return;
    if ((accountDraft.storedKeys || []).includes(key) && !accountDraft.envDelete.includes(key)) {
      accountDraft.envDelete.push(key);
    }
    accountDraft.envKeys = (accountDraft.envKeys || []).filter((item) => item !== key);
    if (accountDraft.envSet) delete accountDraft.envSet[key];
  }

  function syncAccountSchema() {
    const plugin = knownPlugins(data).find((item) => item.pluginId === accountPlugin.value);
    closeEnvMenus();
    renderAccountSchema(accountSchema, plugin, accountDraft?.id ? accountDraft : null, text);
    accountSchemaField.hidden = accountSchema.hidden;
    // Without a declared schema the raw env rows are the only way to configure
    // the account, so keep them open; schema-backed plugins can collapse them.
    accountAdvanced.open = accountSchema.hidden;
  }

  function openAccount(account = null, presetPlugin = "") {
    if (data.editable === false) return;
    if (!knownPlugins(data).length) { showPanelError(text("integrationsPluginFirst")); return; }
    accountDraft = account ? {
      ...account,
      storedKeys: [...(account.storedKeys || account.envKeys || [])],
      envSet: { ...(account.envSet || {}) },
      envDelete: [...(account.envDelete || [])],
    } : { id: "", platform: "", pluginId: presetPlugin, envKeys: [], storedKeys: [], envSet: {}, envDelete: [], envClear: false, state: "unknown", lastError: "" };
    accountId.value = account?.id || "";
    accountId.readOnly = Boolean(account);
    hideAccountError();
    fillPlugins(account?.pluginId || presetPlugin);
    syncAccountSchema();
    accountEnv.textContent = "";
    const keys = account?.envClear ? account.storedKeys : account?.envKeys || [];
    for (const key of keys) addEnvRow(accountEnv, { key }, true, removeStoredKey);
    if (!keys.length) addEnvRow(accountEnv);
    setClearEnv(Boolean(account?.envClear));
    accountDialog.showModal();
    accountPlugin.focus();
  }

  function closeAccount() {
    if (accountDialog.open) accountDialog.close();
    accountDraft = null;
  }

  accountForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!accountDraft) return;
    hideAccountError();
    const pluginId = accountPlugin.value;
    const plugin = knownPlugins(data).find((item) => item.pluginId === pluginId);
    if (!plugin) return showAccountError(text("integrationsAccountInvalid"));
    const id = accountDraft.id || accountId.value.trim() || newAccountId(plugin);
    if (!IDENTIFIER.test(id)) return showAccountError(text("integrationsAccountInvalid"));
    if (data.accounts.some((item) => item.id === id && item.id !== accountDraft.id)) {
      return showAccountError(text("integrationsDuplicateAccount"));
    }
    let values;
    try { values = clearEnv ? {} : readEnv(accountEnv); }
    catch (error) { return showAccountError(error); }
    let schema;
    try { schema = readAccountSchema(accountSchema, text); }
    catch (error) { return showAccountError(error); }
    // A schema field and a free-form env row can name the same key: the schema wins.
    for (const key of schema.keys) delete values[key];
    const schemaValues = clearEnv ? {} : schema.values;
    const envSet = clearEnv ? {} : { ...(accountDraft.envSet || {}), ...values, ...schemaValues };
    const deleted = new Set(clearEnv ? [] : accountDraft.envDelete || []);
    for (const key of Object.keys(values)) deleted.delete(key);
    for (const key of Object.keys(schemaValues)) deleted.delete(key);
    const remaining = (accountDraft.envKeys || []).filter((key) => !deleted.has(key));
    const next = {
      id,
      platform: plugin.platform,
      pluginId: plugin.pluginId,
      state: accountDraft.state,
      lastError: accountDraft.lastError,
      envKeys: clearEnv ? [] : [...new Set([...remaining, ...Object.keys(envSet)])],
      storedKeys: accountDraft.storedKeys || [],
      envSet,
      envDelete: clearEnv ? [] : [...deleted].filter((key) => !Object.hasOwn(envSet, key)),
      envClear: clearEnv,
    };
    data.accounts = accountDraft.id
      ? data.accounts.map((item) => item.id === accountDraft.id ? next : item)
      : [...data.accounts, next];
    renderAccounts();
    renderPlugins();
    closeAccount();
    showStatus(text("integrationsAccountSaved"));
  });

  async function save() {
    if (saving || data.editable === false) return;
    if (data.enabled && !enabledInput.checked && !(await app.confirmAction(text("integrationsDisableConfirm")))) {
      enabledInput.checked = true;
      applyEnabledState();
      return;
    }
    hidePanelError();
    hideRulesError();
    if (!data.accounts.length) return showPanelError(text("integrationsNeedAccount"));
    const rulesState = rulesSection.current();
    let rules;
    if (rulesState.editor) {
      if (rulesState.errors.length) return;
      try { rules = checkRules(rulesState.value, data.accounts, text); }
      catch (error) { return rulesSection.showMessage(error.message); }
    } else {
      try { rules = parseRules(rulesState.text, data.accounts, text); }
      catch (error) { return showRulesError(error.message); }
    }
    const inboundState = inboundSection.current();
    let inbound;
    if (inboundState.editor) {
      if (inboundState.errors.length) return;
      try { inbound = checkInbound(inboundState.value, data.accounts); }
      catch (error) { return inboundSection.showMessage(error.message); }
    } else {
      try { inbound = parseInbound(inboundState.text, data.accounts, text); }
      catch (error) { return inboundSection.showMessage(error.message); }
    }
    const inboundChanged = JSON.stringify(inbound) !== initialInbound;
    setSaving(true);
    try {
      adopt(await app.api("/channeld/integration", {
        method: "PUT",
        body: JSON.stringify({
          enabled: enabledInput.checked,
          accounts: data.accounts.map(accountBody),
          rules,
          ...(inboundChanged ? { inbound } : {}),
        }),
      }));
      const enabled = data.enabled;
      await load(true);
      if (panelError.hidden) showStatus(text(enabled ? "integrationsSavedEnabled" : "integrationsSavedDisabled"));
    } catch (error) { showPanelError(error); }
    finally { setSaving(false); }
  }

  function openUpload() {
    if (data.editable === false) return;
    pluginForm.reset();
    pluginUploadSource = "";
    pluginUploadName = "";
    hidePluginError();
    pluginDialog.showModal();
    pluginFile.focus();
  }

  pluginFile.addEventListener("change", async () => {
    const file = pluginFile.files?.[0];
    pluginUploadSource = "";
    pluginUploadName = "";
    if (!file) return;
    if (file.size > MAX_SOURCE) return showPluginError(text("integrationsSourceTooLarge"));
    try {
      pluginUploadSource = await file.text();
      pluginUploadName = file.name;
      hidePluginError();
    } catch (error) { showPluginError(error); }
  });

  pluginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hidePluginError();
    const name = pluginUploadName || "plugin.js", source = pluginUploadSource;
    if (!PLUGIN_NAME.test(name)) return showPluginError(text("integrationsNameRequired"));
    if (!source.trim()) return showPluginError(text("integrationsSourceRequired"));
    if (new TextEncoder().encode(source).length > MAX_SOURCE) return showPluginError(text("integrationsSourceTooLarge"));
    const submit = $("#btnSaveIntegrationPlugin");
    submit.disabled = true;
    try {
      const result = await app.api("/channeld/plugins", {
        method: "POST",
        body: JSON.stringify({ name, source }),
      });
      const plugin = {
        pluginId: result.pluginId,
        name: result.name,
        platform: result.platform,
        ...(result.displayName ? { displayName: result.displayName } : {}),
        ...(result.account ? { account: result.account } : {}),
      };
      data.plugins = [...data.plugins.filter((item) => item.pluginId !== plugin.pluginId), plugin];
      renderPlugins();
      pluginDialog.close();
      showStatus(text("integrationsUploaded"));
      openAccount(null, plugin.pluginId);
    } catch (error) { showPluginError(error); }
    finally { submit.disabled = false; }
  });

  $("#btnAddAccountEnv").addEventListener("click", () => addEnvRow(accountEnv).querySelector(".integration-env-key").focus());
  accountPlugin.addEventListener("change", syncAccountSchema);
  accountClear.addEventListener("click", () => setClearEnv(!clearEnv));
  enabledInput.addEventListener("change", applyEnabledState);
  addAccountButton.addEventListener("click", () => openAccount(null));
  uploadPluginButton.addEventListener("click", openUpload);
  $("#btnRefreshIntegrations").addEventListener("click", () => void load(true));
  saveButton.addEventListener("click", () => void save());
  $("#btnCloseIntegrationAccount").addEventListener("click", closeAccount);
  $("#btnCancelIntegrationAccount").addEventListener("click", closeAccount);
  accountDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeAccount(); });
  $("#btnCloseIntegrationPlugin").addEventListener("click", () => pluginDialog.close());
  $("#btnCancelIntegrationPlugin").addEventListener("click", () => pluginDialog.close());
  pluginDialog.addEventListener("cancel", (event) => { event.preventDefault(); pluginDialog.close(); });
}