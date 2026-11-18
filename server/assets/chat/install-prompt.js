// A one-time install recommendation for phones. The browser prompt itself is deferred
// until the Install button gesture; desktop, standalone, installed, and recent dissent
// all stay silent. Local storage is optional: blocked storage falls back to this tab.
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;
const DISMISS_KEY = "chat.installDismissedAt";
const INSTALLED_KEY = "chat.installedApp";
const memory = new Map();

function read(key) {
  try { return localStorage.getItem(key); } catch { /* Try the tab next. */ }
  try { return sessionStorage.getItem(key); } catch { /* Use memory. */ }
  return memory.get(key) ?? null;
}

function write(key, value) {
  try { localStorage.setItem(key, value); return; } catch { /* Try the tab next. */ }
  try { sessionStorage.setItem(key, value); } catch { memory.set(key, value); }
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

export function initInstallPrompt(app) {
  const card = app.$("#installPrompt"), installButton = app.$("#btnInstallApp"), guideButton = app.$("#btnInstallGuide"), guide = app.$("#installGuide"), dismissButton = app.$("#btnDismissInstall");
  const rail = app.$("#railInstall"), railInstall = app.$("#btnRailInstall"), railGuide = app.$("#railInstallGuide");
  if (!card || !installButton || !guideButton || !guide || !dismissButton || !rail || !railInstall || !railGuide) return;
  const eligible = () => matchMedia("(max-width: 760px)").matches && window.isSecureContext;
  const suppressed = () => read(INSTALLED_KEY) === "1" || Number(read(DISMISS_KEY) || 0) > Date.now() - DISMISS_MS;
  let deferred = null;

  function hide() {
    const fromCard = card.contains(document.activeElement), fromRail = rail.contains(document.activeElement);
    card.hidden = true;
    rail.hidden = true;
    if (fromCard) app.$("#inName")?.focus({ preventScroll: true });
    else if (fromRail) app.$("#btnSettings")?.focus({ preventScroll: true });
  }

  // The join card explains itself; the room drawer carries the same offer for people
  // who restore straight into a room and never see the join page.
  function render(mode) {
    const visible = Boolean(mode) && eligible() && !isStandalone() && !suppressed();
    card.hidden = rail.hidden = !visible;
    if (!visible) return;
    installButton.hidden = mode !== "prompt";
    guideButton.hidden = mode !== "ios";
    railInstall.hidden = mode !== "prompt";
    railGuide.hidden = mode !== "ios";
    if (mode !== "ios") { guide.hidden = true; guideButton.setAttribute("aria-expanded", "false"); }
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (!eligible() || isStandalone() || suppressed()) return;
    event.preventDefault();
    deferred = event;
    render("prompt");
  });
  window.addEventListener("appinstalled", () => { write(INSTALLED_KEY, "1"); hide(); });
  const promptInstall = async () => {
    const prompt = deferred;
    if (!prompt) return;
    deferred = null;
    let accepted = false;
    try { accepted = (await prompt.prompt())?.outcome === "accepted"; } catch { /* Count it as declined. */ }
    write(accepted ? INSTALLED_KEY : DISMISS_KEY, accepted ? "1" : String(Date.now()));
    hide();
  };
  installButton.addEventListener("click", promptInstall);
  railInstall.addEventListener("click", promptInstall);
  guideButton.addEventListener("click", () => {
    const open = guide.hidden;
    guide.hidden = !open;
    guideButton.setAttribute("aria-expanded", String(open));
  });
  dismissButton.addEventListener("click", () => { write(DISMISS_KEY, String(Date.now())); hide(); });
  if (isIos()) render("ios");
}