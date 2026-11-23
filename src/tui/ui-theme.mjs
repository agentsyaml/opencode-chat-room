// Semantic colors for the OpenTUI view. Dark and light variants follow the
// same roles OpenCode uses: background surface, text, muted metadata, border,
// selection, accent and feedback colors.
const PALETTES = {
  dark: {
    surface: "#111827",
    raised: "#1f2937",
    text: "#e5e7eb",
    muted: "#9ca3af",
    faint: "#6b7280",
    border: "#374151",
    accent: "#22d3ee",
    selectedBg: "#164e63",
    selectedFg: "#ecfeff",
    error: "#f87171",
    success: "#4ade80",
    warning: "#fbbf24",
  },
  light: {
    surface: "#f8fafc",
    raised: "#e2e8f0",
    text: "#111827",
    muted: "#64748b",
    faint: "#94a3b8",
    border: "#cbd5e1",
    accent: "#0e7490",
    selectedBg: "#0e7490",
    selectedFg: "#ecfeff",
    error: "#b91c1c",
    success: "#15803d",
    warning: "#b45309",
  },
};

export function themeFor(mode) {
  const normalized = mode === "light" ? "light" : "dark";
  return { mode: normalized, ...PALETTES[normalized] };
}

export function createTheme(renderer) {
  const theme = themeFor(renderer.themeMode);
  return {
    theme,
    mode: renderer.themeMode === "light" ? "light" : "dark",
    set(mode) {
      if (mode !== "light" && mode !== "dark") return false;
      Object.assign(theme, themeFor(mode));
      this.mode = mode;
      return true;
    },
  };
}

export function connectionStyle(theme, connection) {
  switch (connection) {
    case "online": return { label: "connected", dot: "●", color: theme.success };
    case "reconnecting": return { label: "reconnecting", dot: "◌", color: theme.warning };
    case "offline": return { label: "offline", dot: "●", color: theme.error };
    default: return { label: "connecting", dot: "○", color: theme.muted };
  }
}