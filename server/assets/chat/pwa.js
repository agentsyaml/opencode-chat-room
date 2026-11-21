// A waiting worker means a new release is ready. Never reload on our own: a page can
// hold a draft or a reply in progress, so the person decides when to apply it.
const UPDATE_CHECK_MS = 30 * 60 * 1000;

export function initPwa(app) {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  // Automated browsers do not model a worker's cache or its extra requests, so the browser
  // tests would measure a page that no longer matches the code under test.
  if (navigator.webdriver) return;
  const panel = app.$("#pwaUpdate"), accept = app.$("#btnPwaUpdate"), later = app.$("#btnPwaLater");
  if (!panel || !accept || !later) return;
  let registration = null;
  let waiting = null;
  let reloading = false;
  let reloaded = false;
  let lastCheck = 0;

  const show = (worker) => {
    // The first install claims this page too. It is not an upgrade, so it stays silent.
    if (!worker || !navigator.serviceWorker.controller) return;
    waiting = worker;
    panel.hidden = false;
  };
  const hide = () => { panel.hidden = true; };
  const watchWorker = (worker) => {
    if (!worker) return;
    if (worker.state === "installed") show(worker);
    else worker.addEventListener("statechange", () => {
      if (worker.state === "installed") show(worker);
    });
  };
  const watchRegistration = (next) => {
    registration = next;
    if (registration.waiting) show(registration.waiting);
    registration.addEventListener("updatefound", () => watchWorker(registration.installing));
  };
  const checkForUpdate = () => {
    if (!registration || document.visibilityState !== "visible" || !navigator.onLine) return;
    const now = Date.now();
    if (now - lastCheck < UPDATE_CHECK_MS) return;
    lastCheck = now;
    registration.update().catch(() => {});
  };

  accept.addEventListener("click", () => {
    if (!waiting) return;
    reloading = true;
    hide();
    waiting.postMessage({ type: "SKIP_WAITING" });
  });
  // Later leaves the waiting worker in place. If every page closes it activates on the
  // next open; otherwise this page keeps running without interruption.
  later.addEventListener("click", hide);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading && !reloaded) {
      reloaded = true;
      location.reload();
      return;
    }
    // Another tab may have applied the update. This page keeps its state and picks up
    // the new release on the next reload.
    waiting = null;
    hide();
  });
  window.addEventListener("online", checkForUpdate);
  window.addEventListener("focus", checkForUpdate);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((next) => {
      lastCheck = Date.now();
      watchRegistration(next);
    }).catch(() => {});
  });
}