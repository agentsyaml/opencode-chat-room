// Keyboard tags label every visible control with the keys that reach and use
// it. Generic controls say Tab then Enter/Space; only real shortcuts get a
// dedicated badge. Tags start on and follow scrolling; the '?' trigger opens
// the full shortcut sheet, and the legend can turn the tags off.
const FOCUSABLE = [
  "a[href]", "button", "input:not([type='hidden'])", "select", "textarea", "summary",
  "[contenteditable='true']", "[role='button']", "[role='link']", "[role='switch']",
  "[role='checkbox']", "[role='radio']", "[role='tab']", "[role='menuitem']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function initShortcuts(app) {
  const dialog = app.$("#shortcutsDialog"), heading = app.$("#shortcutsHeading");
  const overlay = app.$("#keyboardHints"), marks = app.$("#keyboardHintMarks"), legend = overlay?.querySelector(".keys-legend");
  if (!dialog || !overlay || !marks || !legend) return;
  const triggers = [...document.querySelectorAll("[data-shortcuts]")];
  const sheetToggle = app.$("#btnToggleHints");
  let active = false, badges = [], frame = 0, observer = null, controller = null;

  const syncSheetToggle = () => {
    if (sheetToggle) app.setText(sheetToggle, active ? "hintsHide" : "hintsShow");
  };
  const syncLegendVisibility = () => {
    const next = Boolean(document.querySelector("#roomRail.drawer-open, .panel:not([hidden]), #readerPanel:not([hidden])"));
    if (legend.hidden !== next) legend.hidden = next;
  };
  const syncVisibility = () => {
    overlay.hidden = !active || Boolean(document.querySelector("dialog[open]"));
    syncLegendVisibility();
  };

  const openSheet = () => {
    if (dialog.open || document.querySelector("dialog[open]")) return;
    app.closePanels?.();
    app.closeMention?.();
    dialog.showModal();
    heading.focus();
  };

  const realKeys = (node) => {
    if (node.matches("#roomListChat .room-row.joined[data-room-id]")
        && innerWidth > 760 && document.querySelectorAll("#roomListChat .room-row.joined").length > 1) return ["↑", "↓"];
    if (node.id === "msgInput" || node.matches("#msgList img[tabindex], #attachmentList img[tabindex], .chat-resource img[tabindex]")) return ["Enter"];
    if (node.id === "btnCloseReaders") return ["Esc"];
    return null;
  };
  const genericLabel = (node) => {
    const switchKey = node.matches("input[type='checkbox'], input[type='radio'], [role='switch'], [role='checkbox'], [role='radio']") ? "Space" : "↵";
    return node.getBoundingClientRect().width < 60 ? (switchKey === "Space" ? "Tab Space" : "Tab↵") : `Tab › ${switchKey}`;
  };

  const badgeFor = (node) => {
    const real = realKeys(node);
    const badge = document.createElement("span");
    badge.className = real ? "keys-badge is-real" : "keys-badge is-generic";
    if (node.id) badge.dataset.hintTarget = node.id;
    if (!real) {
      badge.textContent = genericLabel(node);
      return badge;
    }
    real.forEach((key, index) => {
      const separator = document.createElement("span");
      if (index) { separator.className = "keys-badge-sep"; separator.textContent = "›"; badge.append(separator); }
      const cap = document.createElement("kbd");
      cap.className = "keys-key";
      cap.textContent = key;
      badge.append(cap);
    });
    return badge;
  };

  const usable = (node) => {
    // The trigger already shows its own "?", and overlay chrome is not a target.
    if (node.closest("#keyboardHints, #shortcutsDialog, [inert], [hidden], [data-shortcuts]")) return false;
    if (node.id === "roomDrawerBackdrop" || node.tabIndex < 0) return false;
    if (node.matches(":disabled, [aria-disabled='true']")) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (node.checkVisibility && !node.checkVisibility({ checkVisibilityCSS: true })) return false;
    // Collect off-screen controls too: scrolling then only moves existing badges.
    const onScreen = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    if (!onScreen) return true;
    const left = Math.max(rect.left, 0), top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, innerWidth), bottom = Math.min(rect.bottom, innerHeight);
    if (right - left < 2 || bottom - top < 2) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return Boolean(hit) && (hit === node || node.contains(hit));
  };

  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  const textRect = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };

  const textObstacles = () => {
    const rects = [];
    const skip = new Set(["SCRIPT", "STYLE", "SVG", "TEXTAREA", "SELECT"]);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || skip.has(parent.tagName) || parent.closest("#keyboardHints")) return NodeFilter.FILTER_REJECT;
        if (parent.checkVisibility && !parent.checkVisibility({ checkVisibilityCSS: true })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight) rects.push(rect);
      }
    }
    // The legend covers content too, so tags keep clear of it.
    if (!legend.hidden) rects.push(legend.getBoundingClientRect());
    return rects;
  };

  const place = () => {
    if (!active) return;
    syncLegendVisibility();
    const obstacles = textObstacles();
    const occupied = [];
    const boxes = [];
    const modal = document.querySelector("#roomRail.drawer-open, .panel:not([hidden]), #readerPanel:not([hidden])");
    for (const { node, badge } of badges) {
      const box = node.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) boxes.push([node, box]);
    }
    for (const { node, badge } of badges) {
      if (!node.isConnected) { badge.remove(); continue; }
      if (modal && !modal.contains(node)) { badge.hidden = true; continue; }
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) { badge.hidden = true; continue; }
      const leftEdge = Math.max(rect.left, 0), topEdge = Math.max(rect.top, 0);
      const rightEdge = Math.min(rect.right, innerWidth), bottomEdge = Math.min(rect.bottom, innerHeight);
      const hit = rightEdge - leftEdge > 1 && bottomEdge - topEdge > 1
        ? document.elementFromPoint((leftEdge + rightEdge) / 2, (topEdge + bottomEdge) / 2) : null;
      if (!hit || !(hit === node || node.contains(hit))) { badge.hidden = true; continue; }
      const width = badge.offsetWidth, height = badge.offsetHeight;
      const centerY = rect.top + (rect.height - height) / 2;
      const switchLike = node.matches("input[type='checkbox'], input[type='radio'], [role='switch'], [role='checkbox'], [role='radio']");
      const candidates = [];
      // A tag never covers label text: outside the control first, then a free
      // inside corner, and hidden when neither fits.
      if (switchLike) {
        const label = node.labels?.[0] || node.closest(".join-policy")?.querySelector(".join-policy-label");
        const labelText = label ? textRect(label) : null;
        if (labelText) candidates.push([labelText.right + 8, centerY], [labelText.left, labelText.bottom + 4]);
        candidates.push([rect.left - width - 4, centerY], [rect.right + 4, centerY],
          [rect.right - width, rect.top - height - 4], [rect.right - width, rect.bottom + 4]);
      } else {
        candidates.push([rect.right - width, rect.top - height - 3], [rect.right - width, rect.bottom + 3],
          [rect.right + 4, centerY], [rect.left - width - 4, centerY],
          [rect.left, rect.top - height - 3], [rect.left, rect.bottom + 3],
          [rect.right - width - 2, rect.bottom - height - 2], [rect.left + 2, rect.bottom - height - 2]);
      }
      let chosen = null;
      for (const [left, top] of candidates) {
        const box = { left, top, right: left + width, bottom: top + height };
        if (left < 4 || top < 4 || box.right > innerWidth - 4 || box.bottom > innerHeight - 4) continue;
        if (obstacles.some((other) => overlaps(box, other))) continue;
        if (boxes.some(([other, otherBox]) => other !== node && !other.contains(node) && !node.contains(other) && overlaps(box, otherBox))) continue;
        if (occupied.some((other) => overlaps(box, other))) continue;
        chosen = box; break;
      }
      if (!chosen) { badge.hidden = true; continue; }
      badge.hidden = false;
      badge.style.left = `${Math.round(chosen.left)}px`;
      badge.style.top = `${Math.round(chosen.top)}px`;
      occupied.push(chosen);
    }
    const composer = [...document.querySelectorAll("#chatView .composer")].find((node) => node.offsetParent !== null);
    const bottom = composer ? innerHeight - composer.getBoundingClientRect().top + 10 : 18;
    legend.style.bottom = `${Math.max(12, Math.min(bottom, innerHeight - 90))}px`;
  };

  const collect = () => {
    if (!active) return;
    marks.textContent = "";
    badges = [];
    for (const node of document.querySelectorAll(FOCUSABLE)) {
      if (!usable(node)) continue;
      const badge = badgeFor(node);
      marks.append(badge);
      badges.push({ node, badge });
    }
    place();
  };

  const schedule = (task) => {
    if (!active || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; task(); });
  };

  const setActive = (next) => {
    active = next;
    syncSheetToggle();
    syncVisibility();
    if (!active) {
      controller?.abort(); controller = null;
      observer?.disconnect(); observer = null;
      cancelAnimationFrame(frame); frame = 0;
      marks.textContent = "";
      badges = [];
      return;
    }
    controller = new AbortController();
    const { signal } = controller;
    addEventListener("resize", () => schedule(place), { signal });
    addEventListener("scroll", () => schedule(place), { capture: true, signal });
    addEventListener("click", () => schedule(place), { capture: true, signal });
    // View entrance animations move every control; collect once they settle.
    addEventListener("animationend", (event) => {
      if (event.target === app.$("#joinView") || event.target === app.$("#chatView")) schedule(collect);
    }, { capture: true, signal });
    window.visualViewport?.addEventListener("resize", () => schedule(place), { signal });
    window.visualViewport?.addEventListener("scroll", () => schedule(place), { signal });
    observer = new MutationObserver((records) => {
      if (records.some((record) => record.target instanceof Element && record.target.matches("dialog") && record.attributeName === "open")) syncVisibility();
      syncLegendVisibility();
      if (records.some((record) => !(record.target instanceof Element) || !record.target.closest("#keyboardHints"))) schedule(collect);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled", "aria-disabled", "aria-hidden", "inert", "open"] });
    collect();
  };

  const enable = () => { app.LS.keyHintsOff = false; setActive(true); };
  const disable = () => { app.LS.keyHintsOff = true; setActive(false); };

  triggers.forEach((button) => button.addEventListener("click", () => openSheet()));
  app.$("#btnAllShortcuts")?.addEventListener("click", () => openSheet());
  app.$("#btnToggleHints")?.addEventListener("click", () => (active ? disable() : enable()));
  app.$("#btnCloseHints")?.addEventListener("click", () => {
    disable();
    triggers.find((button) => button.offsetParent !== null)?.focus({ preventScroll: true });
  });
  app.$("#btnCloseShortcuts")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => requestAnimationFrame(() => app.focusComposer?.()));
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "?" && event.key !== "？") return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    openSheet();
  });
  if (app.LS.keyHintsOff) syncSheetToggle(); else setActive(true);
}