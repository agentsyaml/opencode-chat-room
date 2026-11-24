// Keep the app inside the visible area when a soft keyboard opens (iOS does not resize the layout viewport).
export function initViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  if (!viewport) return;
  let lastHeight = viewport.height;

  // Pinch zoom shrinks visualViewport.height while the layout stays the same
  // size. Resizing the app then would collapse the whole UI under the fingers.
  const zoomed = () => Math.abs((viewport.scale || 1) - 1) > 0.01;

  const sync = () => {
    if (zoomed()) return;
    root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
    if (viewport.height < lastHeight - 80 && document.activeElement?.id === "msgInput") {
      requestAnimationFrame(() => {
        const thread = document.querySelector("#thread");
        if (thread) thread.scrollTop = thread.scrollHeight;
      });
    }
    lastHeight = viewport.height;
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  window.addEventListener("pageshow", sync);
  window.addEventListener("orientationchange", sync);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  sync();
  if (matchMedia("(pointer: coarse)").matches) document.querySelector("#msgInput")?.setAttribute("enterkeyhint", "enter");
}