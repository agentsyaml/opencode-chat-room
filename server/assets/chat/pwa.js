export function initPwa() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  // Only a worker that replaced an older one means a new release is ready; the first
  // install takes control too, and reloading then would throw away what the page just did.
  const replacing = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!replacing || reloaded) return;
    reloaded = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
