import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { createApp } from "../app.mjs";
import { resolveTuiConfig } from "../config.mjs";
import { messageKeys, t } from "../i18n.mjs";
import { shouldOpenSetup, parseArgs, helpText, HELP } from "../main.mjs";
import { loadTuiPrefs, resolveTuiPreferences, saveTuiPrefs, tuiPrefsFile } from "../prefs.mjs";

const roots = [];
function temp() {
  const root = mkdtempSync(path.join(tmpdir(), "tui-settings-"));
  roots.push(root);
  return root;
}
function envFor(root) {
  return {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
  };
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("CLI flags include language, theme, server, name and setup", () => {
  assert.deepEqual(parseArgs(["--language", "zh-CN", "--theme=light", "--server", "https://x.example", "--name", "alex", "--setup"]), {
    help: false,
    version: false,
    setup: true,
    name: "alex",
    language: "zh-CN",
    theme: "light",
    server: "https://x.example",
  });
  assert.match(parseArgs(["--language", "fr"]).error, /en or zh-CN/);
  assert.match(parseArgs(["--theme", "blue"]).error, /dark or light/);
  assert.match(parseArgs(["--setup", "--nope"]).error, /unknown option/);
  assert.match(HELP, /Usage/);
  assert.match(helpText("zh-CN"), /用法/);
  assert.match(helpText("zh-CN"), /--setup/);
  assert.equal(shouldOpenSetup({}, false), true);
  assert.equal(shouldOpenSetup({ setup: true }, true), true);
  assert.equal(shouldOpenSetup({}, true), false);
});

test("tui.json persists whitelisted fields with mode 0600 and never a token", () => {
  const root = temp();
  const env = envFor(root);
  const file = tuiPrefsFile(env);
  assert.equal(file, path.join(root, "config", "chatroom", "tui.json"));
  saveTuiPrefs(env, {
    language: "zh-CN",
    theme: "light",
    participant: "alex",
    url: "https://chat.example/",
    token: "super-secret",
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(data, {
    language: "zh-CN",
    theme: "light",
    participant: "alex",
    url: "https://chat.example",
  });
  assert.equal("token" in data, false);
  assert.deepEqual(loadTuiPrefs(env), data);
});

test("a malformed tui.json falls back to project config and defaults", () => {
  const root = temp();
  const env = envFor(root);
  mkdirSync(path.join(root, "config", "chatroom"), { recursive: true });
  writeFileSync(tuiPrefsFile(env), "{not json");
  assert.deepEqual(loadTuiPrefs(env), {});
  const project = { client: { language: "zh-CN", theme: "light" } };
  const resolved = resolveTuiPreferences(env, root, {}, { prefs: loadTuiPrefs(env), project });
  assert.equal(resolved.language, "zh-CN");
  assert.equal(resolved.theme, "light");
  const defaults = resolveTuiPreferences(env, root, {}, { prefs: {}, project: null });
  assert.equal(defaults.language, "en");
  assert.equal(defaults.theme, "dark");
});

test("precedence is flags > env > tui.json > project config > defaults", () => {
  const root = temp();
  const env = envFor(root);
  const project = { url: "https://project.example", client: { participant: "project-name", language: "zh-CN", theme: "light" } };
  const prefs = { url: "https://prefs.example", participant: "prefs-name", language: "en", theme: "dark" };
  const flags = { server: "https://flags.example", name: "flags-name", language: "zh-CN", theme: "light" };

  const full = resolveTuiConfig({ ...env, CHAT_ROOM_SERVER_URL: "https://env.example", CHAT_ROOM_TUI_NAME: "env-name" }, root, { flags, prefs, project });
  assert.equal(full.url, "https://flags.example");
  assert.equal(full.participant, "flags-name");
  assert.equal(resolveTuiPreferences(env, root, flags, { prefs, project }).language, "zh-CN");

  const fromEnv = resolveTuiConfig({ ...env, CHAT_ROOM_SERVER_URL: "https://env.example", CHAT_ROOM_TUI_NAME: "env-name" }, root, { prefs, project });
  assert.equal(fromEnv.url, "https://env.example");
  assert.equal(fromEnv.participant, "env-name");

  const fromPrefs = resolveTuiConfig(env, root, { prefs, project });
  assert.equal(fromPrefs.url, "https://prefs.example");
  assert.equal(fromPrefs.participant, "prefs-name");

  const fromProject = resolveTuiConfig(env, root, { prefs: {}, project });
  assert.equal(fromProject.url, "https://project.example");
  assert.equal(fromProject.participant, "project-name");
});

test("settings editor applies language, theme, name and server and saves prefs", async () => {
  const saved = [];
  const app = createApp({
    api: {},
    sessionID: "s1",
    participant: "alex",
    autoPoll: false,
    settings: { server: "https://chat.example", participant: "alex", language: "en", theme: "dark" },
    savePrefs: (next) => { saved.push({ ...next }); return next; },
  });
  app.openSettingsEditor();
  const palette = app.state.palette;
  assert.equal(palette.kind, "settings");
  assert.equal(palette.mode, "info");
  assert.match(palette.items[0].name, /Language: English/);
  assert.match(palette.items[0].name, /English/);

  palette.selected = 0;
  await app.runInfoSelection();
  assert.equal(palette.mode, "prompt");
  await app.submitPreferencePrompt(palette.prompt, "zh-CN");
  assert.equal(app.state.language, "zh-CN");
  assert.equal(t("settings.title"), "设置");
  assert.match(app.state.palette.items[0].name, /语言/);
  assert.equal(saved.at(-1).language, "zh-CN");

  const themeIndex = app.settingsItems().findIndex((item) => item.value === "theme");
  app.state.palette.selected = themeIndex;
  await app.runInfoSelection();
  await app.submitPreferencePrompt(app.state.palette.prompt, "light");
  assert.equal(app.state.theme, "light");
  assert.equal(saved.at(-1).theme, "light");

  const nameIndex = app.settingsItems().findIndex((item) => item.value === "name");
  app.state.palette.selected = nameIndex;
  await app.runInfoSelection();
  await app.submitPreferencePrompt(app.state.palette.prompt, "alex-2");
  assert.equal(app.participant, "alex-2");
  assert.equal(saved.at(-1).participant, "alex-2");

  const serverIndex = app.settingsItems().findIndex((item) => item.value === "server");
  app.state.palette.selected = serverIndex;
  await app.runInfoSelection();
  await app.submitPreferencePrompt(app.state.palette.prompt, "https://next.example/");
  assert.equal(saved.at(-1).url, "https://next.example");
  assert.equal(app.state.statusKind, "success");
  for (const entry of saved) assert.equal("token" in entry, false);
});

test("invalid settings values stay in the prompt with an error", async () => {
  const app = createApp({
    api: {},
    sessionID: "s1",
    participant: "alex",
    autoPoll: false,
    settings: { server: "https://chat.example", language: "en", theme: "dark" },
  });
  app.openSettingsEditor();
  app.state.palette.selected = 0;
  await app.runInfoSelection();
  const palette = app.state.palette;
  await app.submitPreferencePrompt(palette.prompt, "fr");
  assert.equal(palette.mode, "prompt");
  assert.match(palette.error, /en or zh-CN/);
  assert.equal(app.state.language, "en");
});

test("both language dictionaries expose the same keys", () => {
  assert.deepEqual(messageKeys("en").sort(), messageKeys("zh-CN").sort());
});