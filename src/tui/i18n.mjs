// Terminal UI language layer. Modules call t("key", vars); a missing key falls
// back to English and then to the key itself, so a language pack can never
// blank the screen. Dictionaries live in locales/en.mjs and locales/zh-CN.mjs.
import EN from "./locales/en.mjs";
import ZH from "./locales/zh-CN.mjs";

export const LANGUAGES = ["en", "zh-CN"];
export const DEFAULT_LANGUAGE = "en";

export function normalizeLanguage(value) {
  const text = String(value ?? "").trim().toLowerCase().replace("_", "-");
  if (text === "zh" || text === "zh-cn") return "zh-CN";
  return DEFAULT_LANGUAGE;
}

const DICTIONARIES = { en: EN, "zh-CN": ZH };
let current = DEFAULT_LANGUAGE;

export function setLanguage(value) {
  current = normalizeLanguage(value);
  return current;
}

export function getLanguage() {
  return current;
}

export function messageKeys(language = DEFAULT_LANGUAGE) {
  return Object.keys(DICTIONARIES[normalizeLanguage(language)]);
}

/** Look up a visible string. Vars replace {name} placeholders. */
export function t(key, vars) {
  const text = DICTIONARIES[current]?.[key] ?? EN[key] ?? key;
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, name) =>
    vars[name] === undefined ? match : String(vars[name]));
}