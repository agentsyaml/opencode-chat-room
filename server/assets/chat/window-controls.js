// Installed PWAs opt into the Window Controls Overlay through the manifest. Only a
// visible overlay gets the drag strip and titlebar inset; every other surface keeps
// its normal layout with no dead drag area.
const PROPS = ["top", "left", "width", "height"];

export function initWindowControls() {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return;
  const root = document.documentElement;
  let drag = null;

  const sync = () => {
    if (overlay.visible !== true) {
      delete root.dataset.wco;
      for (const name of PROPS) root.style.removeProperty(`--wco-${name}`);
      drag?.remove();
      drag = null;
      return;
    }
    // Real browsers resolve env(titlebar-area-*) first; the variables are a fallback
    // for browsers that expose the overlay without the CSS environment values.
    const area = overlay.getTitlebarAreaRect?.();
    if (area) {
      for (const name of PROPS) root.style.setProperty(`--wco-${name}`, `${area[name]}px`);
    }
    root.dataset.wco = "true";
    if (!drag) {
      drag = document.createElement("div");
      drag.className = "wco-drag";
      drag.setAttribute("aria-hidden", "true");
      document.body.append(drag);
    }
  };

  overlay.addEventListener("geometrychange", sync);
  sync();
}