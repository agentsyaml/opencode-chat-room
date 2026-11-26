// Browser settings shared by the join page and the chat: language, theme, window frame, and the optional token.
export const THEMES = ["system", "light", "dark", "forest", "sand"];

export function initSettings(app) {
  const $ = app.$;
  const dialog = $("#chatSettings");
  if (!dialog) return;
  const tokenInput = $("#inTokenChat"), tokenHint = $("#tokenHint");
  const contentInput = $("#inContentTransition");
  const pageInput = $("#inPageStep"), pageValue = $("#pageStepValue");
  const frameSelect = $("#inWindowFrame");
  const panelInputs = [...dialog.querySelectorAll("[data-panel-mode]")];
  if (document.body.dataset.integrationsAdmin !== "true") {
    $("#settingsTabIntegrations")?.remove();
    $("#settingsPanelIntegrations")?.remove();
  }
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  let opener = null;

  const syncThemeColor = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const token = document.documentElement.dataset.windowFrame === "borderless" ? "--surface" : "--bg";
    const background = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (meta && background) meta.content = background;
  };
  const syncThemeInputs = () => {
    const stored = THEMES.includes(app.LS.theme) ? app.LS.theme : "system";
    for (const input of dialog.querySelectorAll('input[name="theme"]')) input.checked = input.value === stored;
  };
  const syncPanelInputs = () => {
    for (const select of panelInputs) select.value = app.panelMode(select.dataset.panelMode);
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

  const framePreference = () => app.LS.windowFrame === "borderless" ? "borderless" : "framed";
  const applyWindowFrame = (mode, persist) => {
    const preference = mode === "borderless" ? "borderless" : "framed";
    document.documentElement.dataset.windowFrame = preference;
    if (frameSelect) frameSelect.value = preference;
    if (persist) app.LS.windowFrame = preference;
    syncThemeColor();
  };
  app.setWindowFrame = (value) => applyWindowFrame(value, true);

  // One tab stop for the whole tablist; arrow keys move selection like a native tab widget.
  const activateTab = (name, { focus = false } = {}) => {
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      if (panel) panel.hidden = !selected;
      if (selected && focus) tab.focus();
    }
    if (name === "integrations") app.loadIntegrations?.();
  };
  const onTabKey = (event) => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    const step = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : step ? (index + step + tabs.length) % tabs.length : -1;
    if (target < 0) return;
    event.preventDefault();
    activateTab(tabs[target].dataset.settingsTab, { focus: true });
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab.dataset.settingsTab));
    tab.addEventListener("keydown", onTabKey);
  }

  const open = ({ token = false } = {}) => {
    app.closePanels?.();
    syncThemeInputs();
    syncPanelInputs();
    applyWindowFrame(framePreference(), false);
    if (contentInput) contentInput.checked = app.LS.contentTransition;
    if (pageInput) pageInput.value = String(app.LS.pageStep);
    if (pageValue) pageValue.textContent = `${app.LS.pageStep}%`;
    tokenInput.value = app.LS.token;
    if (tokenHint) tokenHint.hidden = !token;
    if (dialog.open) {
      if (token) {
        activateTab("connection");
        tokenInput.focus();
      }
      return;
    }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    opener?.setAttribute("aria-expanded", "true");
    activateTab(token ? "connection" : "general");
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
  pageInput?.addEventListener("input", () => {
    app.LS.pageStep = pageInput.value;
    pageInput.value = String(app.LS.pageStep);
    if (pageValue) pageValue.textContent = `${app.LS.pageStep}%`;
  });
  dialog.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "theme") app.setTheme(event.target.value);
    if (event.target === frameSelect) app.setWindowFrame(frameSelect.value);
    if (event.target instanceof HTMLSelectElement && event.target.dataset.panelMode) {
      app.setPanelMode(event.target.dataset.panelMode, event.target.value);
    }
    if (event.target === contentInput) app.LS.contentTransition = contentInput.checked;
    if (event.target === pageInput) {
      app.LS.pageStep = pageInput.value;
      pageInput.value = String(app.LS.pageStep);
      if (pageValue) pageValue.textContent = `${app.LS.pageStep}%`;
    }
  });
  dialog.addEventListener("close", () => {
    const target = opener;
    opener = null;
    if (target?.isConnected) target.setAttribute("aria-expanded", "false");
    if (app.focusChatComposer?.({ force: true })) return;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });
  // The palette follows the system through its media query; only the browser chrome needs a nudge.
  scheme.addEventListener("change", () => { if (app.LS.theme === "system") syncThemeColor(); });

  applyTheme(app.LS.theme, false);
  applyWindowFrame(framePreference(), false);
}