export function initPwa() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  // Automated browsers do not model a worker's cache or its extra requests, so the browser
  // tests would measure a page that no longer matches the code under test.
  if (navigator.webdriver) return;
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
