// Editable TUI preferences over the shared palette. The old read-only facts
// stay available as "Connection details" and from the Settings detail page.
import { createInfoPalette } from "./info-app.mjs";
import { settingsMarkdown } from "./info-content.mjs";
import { normalizeLanguage, setLanguage, t } from "./i18n.mjs";
import { normalizeTheme } from "./prefs.mjs";

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));
const LANGUAGE_INPUTS = ["en", "zh", "zh-cn", "zh_cn"];

function languageLabel(language) {
  return t(normalizeLanguage(language) === "zh-CN" ? "settings.langZh" : "settings.langEn");
}

function themeLabel(theme) {
  return t(normalizeTheme(theme) === "light" ? "settings.themeLight" : "settings.themeDark");
}

function factsMarkdown(app) {
  return settingsMarkdown({
    ...app.settings,
    participant: app.participant,
    language: app.state.language,
    theme: app.state.theme,
    token: app.token,
  });
}

export function attachSettings(Class) {
  Object.assign(Class.prototype, {
    // Read-only summary kept for the palette "Settings" docs and the e key.
    openSettings() {
      const text = factsMarkdown(this);
      this.state.help = false;
      this.state.palette = {
        ...createInfoPalette("settings", t("settings.title"), t("settings.readOnlyHint")),
        mode: "detail",
        detail: { title: t("settings.title"), markdown: text, kind: "settings" },
        hint: t("settings.readOnlyHint"),
      };
      this.touch();
    },

    openSettingsEditor() {
      this.state.help = false;
      const palette = createInfoPalette("settings", t("settings.title"), t("settings.subtitle"));
      palette.hint = t("settings.editHint");
      palette.items = this.settingsItems();
      palette.selected = 0;
      this.state.palette = palette;
      this.touch();
    },

    settingsItems() {
      const server = this.prefs.url || this.settings.server || t("common.notSet");
      return [
        { name: `${t("settings.language")}: ${languageLabel(this.prefs.language)}`, value: "language" },
        { name: `${t("settings.name")}: ${this.participant}`, value: "name" },
        { name: `${t("settings.server")}: ${server}`, value: "server" },
        { name: `${t("settings.theme")}: ${themeLabel(this.prefs.theme)}`, value: "theme" },
        { name: t("settings.details"), value: "details" },
      ];
    },

    editSetting(item) {
      const palette = this.state.palette;
      if (!palette || !item) return;
      if (item.value === "details") {
        palette.mode = "detail";
        palette.previous = { mode: "info", hint: palette.hint };
        palette.detail = { title: t("settings.title"), markdown: factsMarkdown(this), kind: "settings" };
        palette.hint = t("palette.detailHint");
        this.touch();
        return;
      }
      const prompts = {
        language: { label: t("settings.languagePrompt"), value: this.prefs.language, action: "settings-language" },
        name: { label: t("settings.namePrompt"), value: this.participant, action: "settings-name" },
        server: { label: t("settings.serverPrompt"), value: this.prefs.url || this.settings.server || "", action: "settings-server" },
        theme: { label: t("settings.themePrompt"), value: this.prefs.theme, action: "settings-theme" },
      };
      const prompt = prompts[item.value];
      if (!prompt) return;
      palette.mode = "prompt";
      palette.prompt = { ...prompt, data: {} };
      palette.error = "";
      palette.hint = t("palette.enterSaveHint");
      this.touch();
    },

    /** Validate and persist one preference, then apply what can change live. */
    async submitPreferencePrompt(prompt, value) {
      const palette = this.state.palette;
      if (!palette) return;
      const raw = String(value ?? "").trim();
      let patch;
      let status = t("settings.saved");
      if (prompt.action === "settings-language") {
        if (!LANGUAGE_INPUTS.includes(raw.toLowerCase())) {
          palette.error = t("settings.invalidLanguage");
          this.touch();
          return;
        }
        patch = { language: normalizeLanguage(raw) };
      } else if (prompt.action === "settings-theme") {
        const theme = raw.toLowerCase();
        if (theme !== "dark" && theme !== "light") {
          palette.error = t("settings.invalidTheme");
          this.touch();
          return;
        }
        patch = { theme };
      } else if (prompt.action === "settings-name") {
        if (!raw || Array.from(raw).length > 64) {
          palette.error = t("settings.invalidName");
          this.touch();
          return;
        }
        patch = { participant: raw };
      } else if (prompt.action === "settings-server") {
        if (!/^https?:\/\/[^/]+/i.test(raw)) {
          palette.error = t("settings.invalidServer");
          this.touch();
          return;
        }
        patch = { url: raw.replace(/\/+$/, "") };
        status = t("settings.restartForServer");
      } else {
        return;
      }
      const next = { ...this.prefs, ...patch };
      try {
        const saved = this.savePrefs?.(next);
        this.prefs = saved ?? next;
      } catch (error) {
        palette.error = t("settings.saveFailed", { error: errorText(error) });
        this.touch();
        return;
      }
      if (patch.language) {
        this.state.language = patch.language;
        setLanguage(patch.language);
      }
      if (patch.theme) this.state.theme = patch.theme;
      if (patch.participant) {
        this.participant = patch.participant;
        this.state.participant = patch.participant;
      }
      this.setStatus(status, "success");
      this.openSettingsEditor();
    },
  });
}