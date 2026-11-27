import { createRandomId } from "./state.js";
import { iconNode } from "./icons.js";

const MIN_SCALE = .5, MAX_SCALE = 4, ZOOM_STEP = 1.25, FIT_PADDING = 24;
let mermaidReady = false, mermaidPalette = "";
const diagramSources = new WeakMap();
export function rememberDiagramSource(node, source) { diagramSources.set(node, source); }

// The diagram palette is the chat palette, resolved for the active theme.
function mermaidThemeVariables() {
  const style = getComputedStyle(document.documentElement);
  const token = (name) => style.getPropertyValue(name).trim();
  const surface = token("--surface"), surface2 = token("--surface-2");
  const ink = token("--ink"), ink2 = token("--ink-2");
  const accent = token("--accent"), accentSoft = token("--accent-soft");
  return {
    background: surface2,
    primaryColor: accentSoft, primaryTextColor: ink, primaryBorderColor: accent,
    secondaryColor: surface, secondaryTextColor: ink2,
    tertiaryColor: surface2, tertiaryTextColor: ink2,
    lineColor: ink2, textColor: ink,
    edgeLabelBackground: surface,
    clusterBkg: surface2, clusterBorder: token("--line"),
    fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif",
    fontSize: "15px",
    actorBkg: accentSoft, actorTextColor: ink, actorBorder: accent,
    signalColor: ink2, signalTextColor: ink,
    labelBoxBkgColor: accentSoft, labelTextColor: ink,
    noteBkgColor: surface, noteTextColor: ink2,
  };
}

// Mermaid bundles are loaded once. Re-initialization happens only when the
// resolved palette changes, so a theme switch repaints existing diagrams.
async function initializeMermaid() {
  if (!window.mermaid) await new Promise((resolve, reject) => {
    const script = document.querySelector('script[src$="mermaid-11.12.2.min.js"]');
    if (!script) return reject(new Error("Mermaid bundle is missing"));
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", reject, { once: true });
    window.addEventListener("load", resolve, { once: true });
  });
  if (!window.mermaid) throw new Error("Mermaid bundle failed to load");
  const themeVariables = mermaidThemeVariables(), signature = JSON.stringify(themeVariables);
  if (mermaidReady && signature === mermaidPalette) return;
  window.mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "base", themeVariables,
    flowchart: { htmlLabels: false, useMaxWidth: false }, sequence: { useMaxWidth: false }, gantt: { useMaxWidth: false },
    maxTextSize: 20000, maxEdges: 200, suppressErrorRendering: true,
    secure: ["secure", "securityLevel", "startOnLoad", "htmlLabels", "flowchart", "theme", "themeVariables", "themeCSS", "dompurifyConfig", "maxTextSize", "maxEdges", "suppressErrorRendering"],
  });
  mermaidReady = true; mermaidPalette = signature;
}
export async function renderDiagram(node, source, app) {
  if (source === undefined || isUnsafeDiagram(source)) return;
  try {
    await initializeMermaid();
    const { svg } = await window.mermaid.render(`oc-chat-${createRandomId()}`, source);
    if (!node.isConnected) return;
    const fragment = window.DOMPurify.sanitize(svg, {
      RETURN_DOM_FRAGMENT: true, USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "a", "script"], FORBID_ATTR: ["href", "xlink:href", "onclick", "onload"],
      ALLOW_DATA_ATTR: false,
    });
    const diagram = fragment.querySelector("svg");
    if (!diagram) throw new Error("Diagram SVG was rejected");
    // The intrinsic width stays in the viewBox; the message column scales it down.
    diagram.removeAttribute("style");
    const update = () => node.replaceChildren(fragment);
    if (app.preserveReadingLayout) await app.preserveReadingLayout(update); else update();
  } catch {
    if (node.isConnected) showDiagramFallback(node, source, app, false);
  }
}
export function isUnsafeDiagram(source = "") {
  return /%%\s*\{|^\s*---\s*(?:\r?\n)|\burl\s*\(|@import|@\s*\{[^}]*\b(?:img|image)\s*:/i.test(source);
}
export function showDiagramFallback(node, source, app, loading) {
  node.textContent = "";
  const status = document.createElement("p"); status.className = "diagram-status";
  status.setAttribute("role", "status"); status.textContent = app.t(loading ? "diagramLoading" : "diagramRenderFailed");
  node.append(status);
  if (!loading) {
    // The source block is readable text, not a button: nothing would open.
    node.removeAttribute("tabindex"); node.removeAttribute("role"); node.removeAttribute("aria-label");
    delete node.dataset.i18nAriaLabel;
    const pre = document.createElement("pre"), code = document.createElement("code");
    code.textContent = source; pre.append(code); node.append(pre);
  }
}

// The overlay shows a sanitized copy of the rendered SVG, so the thread keeps its
// diagram and only the scale changes. A full-screen dialog keeps the thread in place.
export function initDiagramViewer(app) {
  const dialog = app.$("#diagramViewer"), body = app.$("#diagramViewerBody"), stage = app.$("#diagramViewerStage");
  if (!dialog || !body || !stage) return;
  const level = app.$("#diagramZoomLevel"), zoomOut = app.$("#btnDiagramZoomOut"), zoomIn = app.$("#btnDiagramZoomIn"), fitButton = app.$("#btnDiagramFit");
  zoomOut?.append(iconNode("subtract"));
  zoomIn?.append(iconNode("add"));
  let trigger = null, scale = 1, fitScale = 1, stageWidth = 0, stageHeight = 0, panX = 0, panY = 0, limitX = 0, limitY = 0, drag = null;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function computeFit() {
    if (!stageWidth || !stageHeight) return 1;
    const width = Math.max(1, body.clientWidth - FIT_PADDING * 2);
    const height = Math.max(1, body.clientHeight - FIT_PADDING * 2);
    return clamp(Math.min(width / stageWidth, height / stageHeight), MIN_SCALE, MAX_SCALE);
  }
  function layout() {
    limitX = Math.max(0, (stageWidth * scale - body.clientWidth) / 2);
    limitY = Math.max(0, (stageHeight * scale - body.clientHeight) / 2);
    panX = clamp(panX, -limitX, limitX); panY = clamp(panY, -limitY, limitY);
    stage.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${scale})`;
    body.classList.toggle("is-pannable", limitX > .5 || limitY > .5);
    if (level) level.textContent = `${Math.round(scale * 100)}%`;
    if (zoomOut) zoomOut.disabled = scale <= MIN_SCALE + .001;
    if (zoomIn) zoomIn.disabled = scale >= MAX_SCALE - .001;
  }
  function zoomTo(next, x, y) {
    const target = clamp(next, MIN_SCALE, MAX_SCALE);
    if (Math.abs(target - scale) < .001) return;
    const box = body.getBoundingClientRect();
    const centerX = box.left + box.width / 2, centerY = box.top + box.height / 2;
    const ratio = target / scale;
    // Keep the point under the pointer fixed while the diagram scales.
    panX = x - centerX - (x - centerX - panX) * ratio;
    panY = y - centerY - (y - centerY - panY) * ratio;
    scale = target;
    layout();
  }
  function zoomBy(factor) {
    const box = body.getBoundingClientRect();
    zoomTo(scale * factor, box.left + box.width / 2, box.top + box.height / 2);
  }
  function resetZoom() {
    fitScale = computeFit(); scale = fitScale; panX = 0; panY = 0; layout();
  }
  function openDiagram(sourceSvg, sourceText) {
    if (!sourceSvg) return;
    const size = diagramSize(sourceSvg), clone = cloneDiagram(sourceSvg, size);
    // A rejected copy still shows the source instead of an empty overlay.
    if (!clone && !sourceText) return;
    stageWidth = size.width; stageHeight = size.height;
    stage.style.width = `${stageWidth}px`; stage.style.height = `${stageHeight}px`;
    if (clone) stage.replaceChildren(clone);
    else {
      const pre = document.createElement("pre");
      pre.className = "diagram-viewer-source";
      pre.textContent = String(sourceText);
      stage.replaceChildren(pre);
    }
    trigger = sourceSvg.closest(".mermaid-diagram") || sourceSvg;
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("diagram-viewer-open");
    resetZoom();
  }
  const close = () => { if (dialog.open) dialog.close(); };
  function cloneDiagram(svg, size) {
    try {
      const markup = new XMLSerializer().serializeToString(svg);
      const fragment = window.DOMPurify.sanitize(markup, {
        RETURN_DOM_FRAGMENT: true, USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["foreignObject", "a", "script"], FORBID_ATTR: ["href", "xlink:href", "onclick", "onload"],
        ALLOW_DATA_ATTR: false,
      });
      const clone = fragment.querySelector("svg");
      if (!clone) return null;
      clone.removeAttribute("style");
      clone.setAttribute("width", String(size.width));
      clone.setAttribute("height", String(size.height));
      return clone;
    } catch { return null; }
  }
  function diagramSize(svg) {
    const box = svg.viewBox?.baseVal;
    let width = box?.width || 0, height = box?.height || 0;
    if (!(width > 0) || !(height > 0)) {
      width = parseFloat(svg.getAttribute("width")) || 0;
      height = parseFloat(svg.getAttribute("height")) || 0;
    }
    return { width: width > 0 ? width : 640, height: height > 0 ? height : 420 };
  }
  const outside = (target) => target?.closest?.(".diagram-viewer-toolbar");
  // Only a press that began on the backdrop closes; a drag out of the canvas does not.
  let dismissPress = false;
  dialog.addEventListener("pointerdown", (event) => { dismissPress = event.target === dialog; });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && dismissPress) close();
    dismissPress = false;
  });
  dialog.addEventListener("wheel", (event) => {
    if (!dialog.open) return;
    event.preventDefault();
    if (outside(event.target)) return;
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomTo(scale * Math.exp(-delta * .0015), event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener("dblclick", (event) => { event.preventDefault(); resetZoom(); });
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (limitX <= 0 && limitY <= 0)) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
    stage.setPointerCapture(event.pointerId);
    body.classList.add("is-dragging");
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    panX = drag.panX + event.clientX - drag.x; panY = drag.panY + event.clientY - drag.y;
    layout();
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null; body.classList.remove("is-dragging");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  app.$("#btnCloseDiagram")?.addEventListener("click", close);
  // The viewer sits above the document pane; Esc must close this layer only.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dialog.open) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }, true);
  fitButton?.addEventListener("click", resetZoom);
  zoomIn?.addEventListener("click", () => zoomBy(ZOOM_STEP));
  zoomOut?.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
  dialog.addEventListener("close", () => {
    document.body.classList.remove("diagram-viewer-open");
    stage.replaceChildren();
    scale = 1; panX = 0; panY = 0;
    const target = trigger; trigger = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });
  window.addEventListener("resize", () => {
    if (!dialog.open) return;
    const wasFit = Math.abs(scale - fitScale) < .001 && panX === 0 && panY === 0;
    fitScale = computeFit();
    if (wasFit) { scale = fitScale; panX = 0; panY = 0; }
    else scale = Math.max(scale, MIN_SCALE);
    layout();
  });
  // Theme and language changes must repaint diagrams, including the document preview.
  const rerenderDiagrams = () => {
    for (const node of document.querySelectorAll(".mermaid-diagram")) {
      const source = diagramSources.get(node);
      if (source === undefined || !node.querySelector("svg")) continue;
      void renderDiagram(node, source, app);
    }
  };
  new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "data-theme" || record.attributeName === "lang")) rerenderDiagrams();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "lang"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((document.documentElement.dataset.theme || "system") === "system") rerenderDiagrams();
  });
  app.openDiagram = openDiagram;
}