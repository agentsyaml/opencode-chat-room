// Semantic colors for the OpenTUI view. Dark and light variants follow the
// same roles OpenCode uses: background surface, text, muted metadata, border,
// selection, accent and feedback colors.
import { t } from "./i18n.mjs";
const PALETTES = {
  dark: {
    surface: "#0e1116",
    raised: "#171c24",
    text: "#e6e9ef",
    muted: "#98a2b3",
    faint: "#667085",
    border: "#2a313d",
    accent: "#5eead4",
    selectedBg: "#12333a",
    selectedFg: "#ecfeff",
    error: "#fca5a5",
    success: "#6ee7b7",
    warning: "#fcd34d",
  },
  light: {
    surface: "#f8fafc",
    raised: "#eef2f7",
    text: "#101828",
    muted: "#5a6475",
    faint: "#98a2b3",
    border: "#d0d5dd",
    accent: "#0f766e",
    selectedBg: "#0f766e",
    selectedFg: "#f0fdfa",
    error: "#b42318",
    success: "#087443",
    warning: "#b54708",
  },
};

export function themeFor(mode) {
  const normalized = mode === "light" ? "light" : "dark";
  return { mode: normalized, ...PALETTES[normalized] };
}

export function createTheme(renderer, preferred) {
  const mode = preferred === "light" || preferred === "dark"
    ? preferred
    : renderer.themeMode === "light" ? "light" : "dark";
  const theme = themeFor(mode);
  return {
    theme,
    mode,
    set(next) {
      if (next !== "light" && next !== "dark") return false;
      Object.assign(theme, themeFor(next));
      this.mode = next;
      return true;
    },
  };
}

export function connectionStyle(theme, connection) {
  switch (connection) {
    case "online": return { label: t("connection.online"), dot: "●", color: theme.success };
    case "reconnecting": return { label: t("connection.reconnecting"), dot: "◌", color: theme.warning };
    case "offline": return { label: t("connection.offline"), dot: "●", color: theme.error };
    default: return { label: t("connection.connecting"), dot: "○", color: theme.muted };
  }
}