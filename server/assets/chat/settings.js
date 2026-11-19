// Browser settings shared by the join page and the chat: language, theme, and the optional token.
export const THEMES = ["system", "light", "dark", "forest", "sand"];

export function initSettings(app) {
  const $ = app.$;
  const dialog = $("#chatSettings");
  if (!dialog) return;
  const tokenInput = $("#inTokenChat"), tokenHint = $("#tokenHint");
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  let opener = null;

  const syncThemeColor = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (meta && background) meta.content = background;
  };
  const syncThemeInputs = () => {
    const stored = THEMES.includes(app.LS.theme) ? app.LS.theme : "system";
    for (const input of dialog.querySelectorAll('input[name="theme"]')) input.checked = input.value === stored;
  };
  const applyTheme = (value, persist) => {
    const theme = THEMES.includes(value) ? value : "system";
    document.documentElement.dataset.theme = theme;
    if (persist) app.LS.theme = theme;
    syncThemeInputs();
    syncThemeColor();
  };
  app.setTheme = (value) => applyTheme(value, true);
  app.settingsOpen = () => dialog.open;

  const open = ({ token = false } = {}) => {
    app.closePanels?.();
    syncThemeInputs();
    tokenInput.value = app.LS.token;
    if (tokenHint) tokenHint.hidden = !token;
    if (dialog.open) {
      if (token) tokenInput.focus();
      return;
    }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    opener?.setAttribute("aria-expanded", "true");
    dialog.showModal();
    (token ? tokenInput : $("#localeSelectSettings"))?.focus();
  };
  app.openSettings = () => open();
  app.openChatSettings = () => open({ token: true });

  $("#btnSettings")?.addEventListener("click", () => app.openSettings());
  $("#btnJoinSettings")?.addEventListener("click", () => app.openSettings());
  const close = () => {
    opener?.setAttribute("aria-expanded", "false");
    dialog.close();
  };
  $("#btnCloseSettings")?.addEventListener("click", close);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("cancel", () => opener?.setAttribute("aria-expanded", "false"));
  dialog.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "theme") app.setTheme(event.target.value);
  });
  dialog.addEventListener("close", () => {
    const target = opener;
    opener = null;
    if (target?.isConnected) {
      target.setAttribute("aria-expanded", "false");
      target.focus({ preventScroll: true });
    }
  });
  // The palette follows the system through its media query; only the browser chrome needs a nudge.
  scheme.addEventListener("change", () => { if (app.LS.theme === "system") syncThemeColor(); });

  applyTheme(app.LS.theme, false);
}