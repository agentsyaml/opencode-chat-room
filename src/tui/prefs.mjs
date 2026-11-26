// Persistent TUI preferences in $XDG_CONFIG_HOME/chatroom/tui.json. The file
// only stores language, theme, participant and url; a server token is never
// written or accepted from this layer.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTuiConfig } from "./config.mjs";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "./i18n.mjs";

export const PREFS_FILE_NAME = "tui.json";
export const DEFAULT_THEME = "dark";
export const THEMES = ["dark", "light"];
const LANGUAGE_VALUES = ["en", "zh", "zh-cn", "zh_cn"];

export function normalizeTheme(value) {
  return String(value ?? "").trim().toLowerCase() === "light" ? "light" : "dark";
}

export function tuiPrefsFile(env = process.env) {
  const home = env.HOME || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, "chatroom", PREFS_FILE_NAME);
}

/** Keep only known, valid fields; unknown or malformed values are dropped. */
function cleanPrefs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const prefs = {};
  const language = typeof value.language === "string" ? value.language.trim().toLowerCase() : "";
  if (LANGUAGE_VALUES.includes(language)) prefs.language = normalizeLanguage(language);
  const theme = typeof value.theme === "string" ? value.theme.trim().toLowerCase() : "";
  if (THEMES.includes(theme)) prefs.theme = theme;
  if (typeof value.participant === "string" && value.participant.trim()) {
    prefs.participant = value.participant.trim().slice(0, 64);
  }
  if (typeof value.url === "string" && /^https?:\/\/[^/]+/i.test(value.url.trim())) {
    prefs.url = value.url.trim().replace(/\/+$/, "");
  }
  return prefs;
}

/** A missing or malformed file is not an error: it means "no preferences". */
export function loadTuiPrefs(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(tuiPrefsFile(env), "utf8"));
    return cleanPrefs(data);
  } catch {
    return {};
  }
}

export function saveTuiPrefs(env = process.env, patch = {}) {
  const prefs = cleanPrefs({ ...loadTuiPrefs(env), ...cleanPrefs(patch) });
  const file = tuiPrefsFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return prefs;
}

function envValue(env, key) {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

/** Resolve language and theme: flags > env > tui.json > project config > defaults. */
export function resolveTuiPreferences(env = process.env, cwd = process.cwd(), flags = {}, sources = {}) {
  const prefs = sources.prefs ?? loadTuiPrefs(env);
  const project = sources.project === undefined ? loadTuiConfig(env, cwd) : sources.project;
  return {
    language: normalizeLanguage(
      flags.language
        ?? envValue(env, "CHAT_ROOM_TUI_LANGUAGE")
        ?? prefs.language
        ?? project?.client?.language
        ?? project?.language
        ?? DEFAULT_LANGUAGE,
    ),
    theme: normalizeTheme(
      flags.theme
        ?? envValue(env, "CHAT_ROOM_TUI_THEME")
        ?? prefs.theme
        ?? project?.client?.theme
        ?? project?.theme
        ?? DEFAULT_THEME,
    ),
    prefs,
    prefsFile: tuiPrefsFile(env),
  };
}