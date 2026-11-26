/// <reference lib="dom" />
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const browserModule = process.env.CHAT_UI_BROWSER_MODULE;
const token = "chat-integrations-token";

test.skipIf(!browserModule)("integrations settings manage accounts, plugins, rules, inbound routes, and admin gating", async () => {
  const { chromium } = await import(pathToFileURL(browserModule!).href);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chat-integrations-"));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["run", "server/chat-server.ts"], {
    cwd: process.cwd(), env: { ...isolatedEnv(stateDir, port), CHATROOM_ALLOW_ADMIN: "true" }, stdio: "ignore",
  });
  let browser: any, offContext: any, fallbackContext: any;
  const pageErrors: string[] = [], nativeDialogs: string[] = [];
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const inboundRoute = { from: { platform: "telegram", account: "acct", room: "tg-room", event: "message.received" }, to: { room: "room-1" } };
  let integration: any = {
    enabled: false, source: "managed", editable: true, accounts: [], rules: [], inbound: [inboundRoute],
    plugins: [{ pluginId: "plugin-1", name: "telegram.js", platform: "telegram" }],
  };
  const envKeys = new Map<string, string[]>();
  let failNextSave = false;
  const routeState = {
    calls,
    snapshot: () => integration,
    replace(next: any) { integration = next; },
    envKeys,
    failNextSave: () => failNextSave,
    clearFail() { failNextSave = false; },
  };

  try {
    await waitForServer(origin);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_UI_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("dialog", (dialog: any) => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    await page.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await installIntegrationRoutes(page, routeState);
    await page.goto(`${origin}/chat`);
    expect(await page.evaluate(() => document.body.dataset.integrationsAdmin)).toBe("true");
    await page.locator("#inName").fill("__Test_IntegrationOwner");
    await page.locator("#inRoomName").fill("__Test_IntegrationRoom");
    await page.locator("#btnCreate").click();
    await page.locator("#chatView").waitFor({ state: "visible" });
    await page.locator("#btnSettings").click();
    await page.locator("#chatSettings[open]").waitFor();
    await page.locator("#settingsTabIntegrations").click();
    await page.locator("#integrationPlugins").getByText("telegram.js").waitFor();
    await page.locator("#integrationRulesEditor .monaco-editor").waitFor();
    await page.locator("#integrationInboundEditor .monaco-editor").waitFor();
    expect(calls.some((call) => call.method === "GET" && call.path === "/channeld/integration")).toBe(true);
    expect(await page.locator("#inIntegrationsEnabled").isChecked()).toBe(false);
    expect(await page.locator("#integrationAccountsEmpty").isVisible()).toBe(true);
    expect(await page.locator("#integrationRules").inputValue()).toBe("[]");
    expect(await page.locator("#integrationInbound").inputValue()).toContain('"message.received"');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (process.env.CHAT_UI_SCREENSHOT_DIR) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "integrations-panel.png") });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(120);
    const mobile = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("#chatSettings")!;
      const tabs = Array.from(dialog.querySelectorAll<HTMLElement>('[role="tab"]')).map((tab) => {
        const rect = tab.getBoundingClientRect();
        return { top: Math.round(rect.top), width: rect.width, visible: tab.getClientRects().length > 0 };
      });
      return { tabs, overflow: document.documentElement.scrollWidth - innerWidth, dialogX: dialog.scrollWidth - dialog.clientWidth };
    });
    expect(mobile.tabs).toHaveLength(4);
    expect(mobile.tabs.every((tab: any) => tab.visible && tab.width > 40)).toBe(true);
    expect(new Set(mobile.tabs.map((tab: any) => tab.top)).size).toBe(1);
    expect(mobile.overflow).toBeLessThanOrEqual(1);
    expect(mobile.dialogX).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(120);

    // The switch uses the dedicated runtime endpoints.
    await page.locator("#inIntegrationsEnabled").check();
    await page.locator("#integrationStatus").filter({ hasText: "Integrations are enabled." }).waitFor();
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/channeld/enable" });
    await page.locator("#inIntegrationsEnabled").uncheck();
    await page.locator("#integrationStatus").filter({ hasText: "Integrations are disabled." }).waitFor();
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/channeld/disable" });

    // Add an account with an environment value.
    await page.locator("#btnAddIntegrationAccount").click();
    await page.locator("#integrationAccountDialog[open]").waitFor();
    await page.locator("#integrationAccountId").fill("acct");
    await page.locator("#integrationAccountPlugin").selectOption("plugin-1");
    expect(await page.locator("#integrationAccountPlatform").inputValue()).toBe("telegram");
    await page.locator("#integrationAccountEnv .integration-env-key").fill("API_TOKEN");
    await page.locator("#integrationAccountEnv .integration-env-value").fill("first-secret");
    if (process.env.CHAT_UI_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "integrations-account.png") });
    }
    await page.locator("#btnSaveIntegrationAccount").click();
    await page.locator("#integrationAccountDialog").waitFor({ state: "hidden" });
    const accountRow = page.locator("#integrationAccounts .integration-account").filter({ hasText: "acct" });
    await accountRow.waitFor();
    expect(await accountRow.textContent()).toContain("telegram.js");
    expect(await accountRow.textContent()).toContain("API_TOKEN");

    await saveIntegrations(page);
    let saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(saved.enabled).toBe(false);
    expect(saved.accounts).toEqual([{ id: "acct", platform: "telegram", pluginId: "plugin-1", env: { API_TOKEN: "first-secret" } }]);
    expect(saved.rules).toEqual([]);
    // An untouched inbound list is omitted so the server keeps existing routes.
    expect(Object.hasOwn(saved, "inbound")).toBe(false);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();

    // Leaving env values blank omits env, preserving the stored set.
    await accountRow.getByRole("button", { name: "Edit: acct" }).click();
    await page.locator("#integrationAccountDialog[open]").waitFor();
    expect(await page.locator("#integrationAccountEnv .integration-env-key").inputValue()).toBe("API_TOKEN");
    expect(await page.locator("#integrationAccountEnv .integration-env-value").inputValue()).toBe("");
    expect(await page.locator("#integrationAccountEnv .integration-env-row.is-stored").count()).toBe(1);
    if (process.env.CHAT_UI_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.CHAT_UI_SCREENSHOT_DIR, "integrations-account-stored.png") });
    }
    await page.locator("#btnSaveIntegrationAccount").click();
    await page.locator("#integrationAccountDialog").waitFor({ state: "hidden" });
    await saveIntegrations(page);
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(Object.hasOwn(saved.accounts[0], "env")).toBe(false);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();

    // A new variable sends only the new key; untouched stored keys stay on the server.
    await accountRow.getByRole("button", { name: "Edit: acct" }).click();
    await page.locator("#integrationAccountDialog[open]").waitFor();
    await page.locator("#btnAddAccountEnv").click();
    await page.locator("#integrationAccountEnv .integration-env-key").last().fill("OTHER");
    await page.locator("#integrationAccountEnv .integration-env-value").last().fill("second-secret");
    await page.locator("#btnSaveIntegrationAccount").click();
    await page.locator("#integrationAccountDialog").waitFor({ state: "hidden" });
    await saveIntegrations(page);
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(saved.accounts[0].env).toEqual({ OTHER: "second-secret" });
    expect(Object.hasOwn(saved.accounts[0], "envDelete")).toBe(false);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();
    expect(await accountRow.textContent()).toContain("API_TOKEN, OTHER");

    // Replacing one stored value sends only that key; the other secret survives.
    await accountRow.getByRole("button", { name: "Edit: acct" }).click();
    await page.locator("#integrationAccountDialog[open]").waitFor();
    await page.locator("#integrationAccountEnv .integration-env-value").first().fill("rotated-secret");
    await page.locator("#btnSaveIntegrationAccount").click();
    await page.locator("#integrationAccountDialog").waitFor({ state: "hidden" });
    await saveIntegrations(page);
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(saved.accounts[0].env).toEqual({ API_TOKEN: "rotated-secret" });
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();
    expect(await accountRow.textContent()).toContain("API_TOKEN, OTHER");

    // Removing one stored key sends envDelete only; env: {} would clear the rest.
    await accountRow.getByRole("button", { name: "Edit: acct" }).click();
    await page.locator("#integrationAccountDialog[open]").waitFor();
    await page.locator("#integrationAccountEnv .integration-env-remove").first().click();
    await page.locator("#btnSaveIntegrationAccount").click();
    await page.locator("#integrationAccountDialog").waitFor({ state: "hidden" });
    await saveIntegrations(page);
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(Object.hasOwn(saved.accounts[0], "env")).toBe(false);
    expect(saved.accounts[0].envDelete).toEqual(["API_TOKEN"]);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();
    expect(await accountRow.textContent()).not.toContain("API_TOKEN");
    expect(await accountRow.textContent()).toContain("OTHER");

    // Clear all sends env: {} without envDelete.
    await accountRow.getByRole("button", { name: "Edit: acct" }).click();
    await page.locator("#integrationAccountDialog[open]").waitFor();
    await page.locator("#btnClearAccountEnv").click();
    expect(await page.locator("#integrationAccountEnvNote").isVisible()).toBe(true);
    await page.locator("#btnSaveIntegrationAccount").click();
    await page.locator("#integrationAccountDialog").waitFor({ state: "hidden" });
    await saveIntegrations(page);
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(saved.accounts[0].env).toEqual({});
    expect(Object.hasOwn(saved.accounts[0], "envDelete")).toBe(false);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();
    expect(await accountRow.textContent()).not.toContain("OTHER");

    // Invalid JSON and missing target accounts block the PUT with readable field errors.
    const putCount = () => calls.filter((call) => call.method === "PUT").length;
    const beforeInvalid = putCount();
    await setEditorText(page, "#integrationRulesEditor", "#integrationRules", "[");
    await saveIntegrations(page);
    await page.locator("#integrationRulesError").filter({ hasText: /line/i }).waitFor();
    expect(putCount()).toBe(beforeInvalid);

    const rule = { id: "forward", version: 1, from: { platform: "chatroom", account: "center", room: "center", event: "message.forward_requested" }, transforms: [], to: [{ platform: "telegram", account: "acct", room: "chat" }] };
    await setEditorText(page, "#integrationRulesEditor", "#integrationRules", JSON.stringify([{
      id: "forward", version: 1, from: { platform: "chatroom", account: "center", room: "center" },
      to: [{ platform: "telegram", account: "missing", room: "chat" }],
    }], null, 2));
    await page.waitForFunction(() => Number(document.querySelector("#integrationRulesEditor")?.getAttribute("data-error-count")) > 0);
    await saveIntegrations(page);
    await page.locator("#integrationRulesError").filter({ hasText: "does not exist" }).waitFor();
    expect(putCount()).toBe(beforeInvalid);
    expect(await page.locator("#integrationRulesEditor .squiggly-error").count()).toBeGreaterThan(0);

    // YAML mode parses the same schema, validates, and saves the parsed array.
    await page.locator("#integrationRulesFormatYaml").click();
    await page.waitForFunction(() => (document.getElementById("integrationRules") as HTMLTextAreaElement | null)?.value.trimStart().startsWith("-"));
    const yamlRule = [
      "- id: forward",
      "  version: 1",
      "  from:",
      "    platform: chatroom",
      "    account: center",
      "    room: center",
      "    event: message.forward_requested",
      "  transforms: []",
      "  to:",
      "    - platform: telegram",
      "      account: acct",
      "      room: chat",
    ].join("\n");
    await setEditorText(page, "#integrationRulesEditor", "#integrationRules", yamlRule);
    await page.waitForFunction(() => document.querySelector("#integrationRulesEditor")?.getAttribute("data-error-count") === "0");
    await saveIntegrations(page);
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(saved.rules).toEqual([rule]);
    expect(Object.hasOwn(saved, "inbound")).toBe(false);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();
    await page.locator("#integrationRulesFormatJson").click();
    await page.waitForFunction(() => (document.getElementById("integrationRules") as HTMLTextAreaElement | null)?.value.trimStart().startsWith("["));

    // Clearing every inbound route must send [] so the server does not preserve them.
    await setEditorText(page, "#integrationInboundEditor", "#integrationInbound", "[]");
    await saveIntegrations(page);
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(saved.inbound).toEqual([]);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();

    // A route pointing at a missing account blocks the PUT with a readable error.
    const beforeInboundInvalid = putCount();
    await setEditorText(page, "#integrationInboundEditor", "#integrationInbound", JSON.stringify([{
      from: { platform: "telegram", account: "missing", room: "tg-room" }, to: { room: "room-1" },
    }], null, 2));
    await page.waitForFunction(() => Number(document.querySelector("#integrationInboundEditor")?.getAttribute("data-error-count")) > 0);
    await saveIntegrations(page);
    await page.locator("#integrationInboundError").filter({ hasText: "does not exist" }).waitFor();
    expect(putCount()).toBe(beforeInboundInvalid);
    await setEditorText(page, "#integrationInboundEditor", "#integrationInbound", "[]");
    await page.waitForFunction(() => document.querySelector("#integrationInboundEditor")?.getAttribute("data-error-count") === "0");

    // Backend errors stay readable and keep the rules form open.
    await setEditorText(page, "#integrationRulesEditor", "#integrationRules", JSON.stringify([rule], null, 2));
    failNextSave = true;
    await saveIntegrations(page);
    await page.locator("#integrationError").filter({ hasText: "relay deployment rejected the target" }).waitFor();
    expect(await page.locator("#integrationRules").inputValue()).toContain("\"account\": \"acct\"");
    await saveIntegrations(page);
    await page.locator("#integrationStatus").filter({ hasText: "Saved. Integrations are disabled." }).waitFor();
    saved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(saved.rules).toHaveLength(1);

    // Uploading a plugin calls the plugin endpoint first and only then selects it.
    const uploadsBefore = calls.filter((call) => call.path === "/channeld/plugins").length;
    const putsBefore = putCount();
    await page.locator("#btnUploadPlugin").click();
    await page.locator("#integrationPluginDialog[open]").waitFor();
    await page.locator("#integrationPluginName").fill("custom.mjs");
    await page.locator("#integrationPluginPlatform").fill("custom");
    await page.locator("#integrationPluginSource").fill("export default async () => ({});");
    await page.locator("#integrationPluginEnv .integration-env-key").fill("PLUGIN_TOKEN");
    await page.locator("#integrationPluginEnv .integration-env-value").fill("upload-secret");
    await page.locator("#btnSaveIntegrationPlugin").click();
    await page.locator("#integrationAccountDialog[open]").waitFor();
    expect(calls.filter((call) => call.path === "/channeld/plugins")).toHaveLength(uploadsBefore + 1);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/channeld/plugins" });
    expect(calls.at(-1)!.body).toMatchObject({ name: "custom.mjs", platform: "custom", env: { PLUGIN_TOKEN: "upload-secret" } });
    expect(putCount()).toBe(putsBefore);
    expect(await page.locator("#integrationAccountPlugin").inputValue()).toBe("plugin-2");
    expect(await page.locator("#integrationAccountPlatform").inputValue()).toBe("custom");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("integrationAccountId");
    await page.locator("#btnCancelIntegrationAccount").click();
    await page.locator("#integrationPlugins").getByText("custom.mjs").waitFor();

    // An external configuration stays visible but read-only; a managed snapshot restores editing.
    const managedSnapshot = integration;
    integration = { ...integration, source: "external", editable: false };
    const putsBeforeExternal = putCount();
    await page.locator("#btnRefreshIntegrations").click();
    await page.locator("#integrationExternalNotice").waitFor({ state: "visible" });
    expect(await page.locator("#integrationExternalNotice").textContent()).toContain("external configuration file");
    for (const selector of ["#btnSaveIntegrations", "#btnAddIntegrationAccount", "#btnUploadPlugin", "#integrationRulesFormatJson", "#integrationRulesFormatYaml"]) {
      expect(await page.locator(selector).isDisabled()).toBe(true);
    }
    const externalAccount = page.locator("#integrationAccounts .integration-account").filter({ hasText: "acct" });
    expect(await externalAccount.getByRole("button", { name: "Edit: acct" }).isDisabled()).toBe(true);
    expect(await externalAccount.getByRole("button", { name: "Remove: acct" }).isDisabled()).toBe(true);
    expect(await page.locator("#integrationRulesEditor").getAttribute("data-read-only")).toBe("true");
    expect(await page.locator("#integrationInboundEditor").getAttribute("data-read-only")).toBe("true");
    await page.evaluate(() => (document.querySelector("#btnSaveIntegrations") as HTMLButtonElement | null)?.click());
    await page.waitForTimeout(100);
    expect(putCount()).toBe(putsBeforeExternal);
    integration = { ...managedSnapshot };
    delete integration.editable;
    delete integration.source;
    await page.locator("#btnRefreshIntegrations").click();
    await page.locator("#integrationExternalNotice").waitFor({ state: "hidden" });
    expect(await page.locator("#btnSaveIntegrations").isEnabled()).toBe(true);
    expect(await page.locator("#btnAddIntegrationAccount").isEnabled()).toBe(true);
    expect(await page.locator("#btnUploadPlugin").isEnabled()).toBe(true);
    expect(await page.locator("#integrationRulesFormatJson").isEnabled()).toBe(true);
    expect(await page.locator("#integrationRulesEditor").getAttribute("data-read-only")).toBe("false");

    // A blocked editor bundle must leave the plain textarea and its validation working.
    const putsBeforeFallback = () => calls.filter((call) => call.method === "PUT" && call.path === "/channeld/integration").length;
    fallbackContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const fallbackPage = await fallbackContext.newPage();
    fallbackPage.setDefaultTimeout(15000);
    fallbackPage.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await fallbackPage.route("**/assets/monaco/integration-rules.js", (route: any) => route.abort());
    await installIntegrationRoutes(fallbackPage, routeState);
    await fallbackPage.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await fallbackPage.goto(`${origin}/chat`);
    await fallbackPage.locator("#btnJoinSettings").click();
    await fallbackPage.locator("#chatSettings[open]").waitFor();
    await fallbackPage.locator("#settingsTabIntegrations").click();
    await fallbackPage.locator("#integrationRules").waitFor({ state: "visible" });
    expect(await fallbackPage.locator("#integrationRulesEditor").isVisible()).toBe(false);
    expect(await fallbackPage.locator("#integrationInboundEditor").isVisible()).toBe(false);
    expect(await fallbackPage.locator("#integrationRulesFormat").isVisible()).toBe(false);
    await fallbackPage.locator("#integrationRulesFallback").filter({ hasText: "could not load" }).waitFor();
    const beforeFallback = putsBeforeFallback();
    await fallbackPage.locator("#integrationRules").fill("[");
    await saveIntegrations(fallbackPage);
    await fallbackPage.locator("#integrationRulesError").filter({ hasText: /line/i }).waitFor();
    expect(putsBeforeFallback()).toBe(beforeFallback);
    await fallbackPage.locator("#integrationRules").fill("[]");
    await saveIntegrations(fallbackPage);
    const fallbackSaved = calls.findLast((call) => call.method === "PUT" && call.path === "/channeld/integration")!.body;
    expect(fallbackSaved.rules).toEqual([]);
    expect(Object.hasOwn(fallbackSaved, "inbound")).toBe(false);

    // Admin off removes the entry and never loads integration data.
    const integrationGets = calls.filter((call) => call.method === "GET" && call.path === "/channeld/integration").length;
    offContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const offPage = await offContext.newPage();
    offPage.setDefaultTimeout(15000);
    offPage.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await offPage.route("**/chat", async (route: any) => {
      const response = await route.fetch();
      const html = (await response.text()).replace('data-integrations-admin="true"', 'data-integrations-admin="false"');
      await route.fulfill({ response, body: html });
    });
    await offPage.addInitScript((value: string) => localStorage.setItem("chat.token", value), token);
    await offPage.goto(`${origin}/chat`);
    expect(await offPage.evaluate(() => document.body.dataset.integrationsAdmin)).toBe("false");
    await offPage.locator("#btnJoinSettings").click();
    await offPage.locator("#chatSettings[open]").waitFor();
    expect(await offPage.locator("#settingsTabIntegrations").count()).toBe(0);
    expect(await offPage.locator("#settingsPanelIntegrations").count()).toBe(0);
    expect(calls.filter((call) => call.method === "GET" && call.path === "/channeld/integration")).toHaveLength(integrationGets);

    expect(nativeDialogs).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await offContext?.close();
    await fallbackContext?.close();
    await browser?.close();
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM"); await stopped;
    await rm(stateDir, { recursive: true, force: true });
  }
}, 180000);

async function setEditorText(page: any, editor: string, textarea: string, text: string) {
  await page.locator(`${editor} .view-lines`).click({ position: { x: 12, y: 14 } });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
  await page.waitForFunction(({ id, sample }: any) => {
    const element = document.getElementById(id) as HTMLTextAreaElement | null;
    return Boolean(element && element.value.replace(/\s+/g, "").includes(sample));
  }, { id: textarea.slice(1), sample: text.replace(/\s+/g, "").slice(0, 30) });
}

async function saveIntegrations(page: any) {
  await page.locator("#btnSaveIntegrations").click();
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>("#btnSaveIntegrations");
    return button ? !button.disabled : false;
  });
}

async function installIntegrationRoutes(page: any, state: any) {
  const json = (route: any, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await page.route("**/channeld/integration", async (route: any) => {
    const request = route.request(), method = request.method();
    const body = method === "GET" ? undefined : request.postDataJSON();
    state.calls.push({ method, path: "/channeld/integration", body });
    if (method === "GET") return json(route, state.snapshot());
    if (state.failNextSave()) {
      state.clearFail();
      return json(route, { error: "relay deployment rejected the target" }, 400);
    }
    const previous = new Map<string, string[]>(state.snapshot().accounts.map((account: any) => [String(account.id), Array.isArray(account.envKeys) ? account.envKeys : []] as const));
    const accounts = (body.accounts || []).map((account: any) => {
      let keys = [...(previous.get(account.id) || [])];
      const set = account.env && Object.keys(account.env);
      const removed = Array.isArray(account.envDelete) ? account.envDelete : [];
      if (set && !set.length && !removed.length) keys = [];
      if (set && set.length) for (const key of set) if (!keys.includes(key)) keys.push(key);
      if (removed.length) keys = keys.filter((key: string) => !removed.includes(key));
      state.envKeys.set(account.id, keys);
      return { ...account, envKeys: keys, state: "stopped" };
    });
    state.replace({ ...state.snapshot(), enabled: body.enabled, accounts, rules: body.rules, inbound: Object.hasOwn(body, "inbound") ? body.inbound : state.snapshot().inbound });
    return json(route, state.snapshot());
  });
  await page.route("**/channeld/plugins", async (route: any) => {
    const body = route.request().postDataJSON();
    state.calls.push({ method: "POST", path: "/channeld/plugins", body });
    const plugin = { pluginId: "plugin-2", name: body.name, platform: body.platform };
    state.replace({ ...state.snapshot(), plugins: [...state.snapshot().plugins, plugin] });
    return json(route, plugin, 201);
  });
  for (const [pathname, enabled] of [["/channeld/enable", true], ["/channeld/disable", false]] as const) {
    await page.route(`**${pathname}`, async (route: any) => {
      state.calls.push({ method: "POST", path: pathname, body: route.request().postDataJSON() });
      state.replace({ ...state.snapshot(), enabled });
      return json(route, { enabled });
    });
  }
}

function isolatedEnv(stateDir: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"]) delete env[key];
  return { ...env, HOME: path.join(stateDir, "home"), XDG_STATE_HOME: path.join(stateDir, "state"), XDG_CONFIG_HOME: path.join(stateDir, "config"), CHAT_ROOM_STATE_DIR: stateDir, CHAT_ROOM_SERVER_HOST: "127.0.0.1", CHAT_ROOM_SERVER_PORT: String(port), CHAT_ROOM_SERVER_TOKEN: token };
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function waitForServer(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/chat`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local chat server did not start");
}