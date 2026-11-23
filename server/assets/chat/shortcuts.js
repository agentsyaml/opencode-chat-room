// The shortcut sheet lists genuine ChatRoom shortcuts. Alt+/ opens it; the
// composer keeps one visible entry and no per-control badges.
export function initShortcuts(app) {
  const dialog = app.$("#shortcutsDialog");
  if (!dialog) return;
  const heading = app.$("#shortcutsHeading");
  const thread = app.$("#thread");
  const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "Option" : "Alt";
  document.body.classList.toggle("is-mac", modifier === "Option");
  document.querySelectorAll(".shortcut-mod").forEach((key) => { key.textContent = modifier; });
  const lead = app.$("#shortcutsLead");
  if (lead) {
    lead._i18nValues = { modifier };
    lead.textContent = app.t("shortcutsLead", { modifier });
  }

  const openSheet = () => {
    if (dialog.open || document.querySelector("dialog[open]")) return;
    app.closePanels?.();
    app.closeMention?.();
    dialog.showModal();
    heading?.focus();
  };

  app.$("#btnShortcuts")?.addEventListener("mousedown", (event) => event.preventDefault());
  app.$("#btnShortcuts")?.addEventListener("click", openSheet);
  app.$("#btnCloseShortcuts")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => requestAnimationFrame(() => app.focusComposer?.()));
  let scrollFrame = 0;
  let scrollGeneration = 0;
  let pageTarget = null;
  let pageFrame = 0;
  const cancelScroll = () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    scrollGeneration++;
  };
  const cancelPageScroll = () => {
    cancelAnimationFrame(pageFrame);
    pageFrame = 0;
    pageTarget = null;
  };
  const animateScroll = (target) => {
    if (!thread) return;
    cancelPageScroll();
    const max = Math.max(0, thread.scrollHeight - thread.clientHeight);
    const end = Math.max(0, Math.min(max, target));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cancelScroll();
      thread.scrollTop = end;
      return;
    }
    cancelScroll();
    const generation = scrollGeneration;
    const from = thread.scrollTop;
    const distance = end - from;
    const duration = Math.min(300, Math.max(140, Math.abs(distance) * 0.3));
    const start = performance.now();
    const step = (now) => {
      if (generation !== scrollGeneration) {
        scrollFrame = 0;
        return;
      }
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      thread.scrollTop = from + distance * eased;
      if (progress < 1) scrollFrame = requestAnimationFrame(step);
      else scrollFrame = 0;
    };
    scrollFrame = requestAnimationFrame(step);
  };
  const pageScrollBy = (delta) => {
    if (!thread) return;
    cancelScroll();
    const max = Math.max(0, thread.scrollHeight - thread.clientHeight);
    const clamp = (value) => Math.max(0, Math.min(max, value));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cancelPageScroll();
      thread.scrollTop = clamp(thread.scrollTop + delta);
      return;
    }
    const base = pageTarget ?? thread.scrollTop;
    pageTarget = clamp(base + delta);
    if (pageFrame) return;
    const step = () => {
      if (pageTarget === null) {
        pageFrame = 0;
        return;
      }
      const remaining = pageTarget - thread.scrollTop;
      if (Math.abs(remaining) <= 0.6) {
        thread.scrollTop = pageTarget;
        pageTarget = null;
        pageFrame = 0;
        return;
      }
      thread.scrollTop += remaining * 0.28;
      pageFrame = requestAnimationFrame(step);
    };
    pageFrame = requestAnimationFrame(step);
  };
  const cancelThreadScroll = () => {
    cancelScroll();
    cancelPageScroll();
  };
  app.cancelThreadScrollAnimation = cancelThreadScroll;
  thread?.addEventListener("wheel", cancelThreadScroll, { passive: true });
  thread?.addEventListener("touchmove", cancelThreadScroll, { passive: true });
  thread?.addEventListener("pointerdown", cancelThreadScroll, { passive: true });
  app.animateThreadScrollTo = animateScroll;
  app.animateThreadScrollBy = pageScrollBy;
  const scrollToEdge = (bottom) => {
    if (!thread) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    app.state.userScrollIntentUntil = performance.now() + 700;
    if (!bottom) {
      app.state.jumpToLoadedTop = true;
      clearTimeout(app.state.jumpToLoadedTopTimer);
      app.state.jumpToLoadedTopTimer = setTimeout(() => { app.state.jumpToLoadedTop = false; }, reduced ? 150 : 800);
    }
    animateScroll(bottom ? thread.scrollHeight : 0);
  };
  app.animateRoomSwitch = (direction) => {
    // Fluent motion lives in the selected indicator: the old bar collapses toward
    // the direction of travel while the new bar expands from the opposite edge.
    const oldId = app.state.previousRoomId;
    const oldRows = oldId ? document.querySelectorAll(`#roomListChat .room-row[data-room-id="${CSS.escape(oldId)}"]`) : [];
    for (const row of oldRows) {
      row.classList.remove("room-switch-leave");
      row.style.setProperty("--room-switch-origin", direction > 0 ? "bottom" : "top");
      void row.offsetWidth;
      row.classList.add("room-switch-leave");
      setTimeout(() => row.classList.remove("room-switch-leave"), 220);
    }
    for (const row of document.querySelectorAll("#roomListChat .room-row.selected")) {
      row.classList.remove("room-switch-enter");
      row.style.setProperty("--room-switch-origin", direction > 0 ? "top" : "bottom");
      void row.offsetWidth;
      row.classList.add("room-switch-enter");
      setTimeout(() => row.classList.remove("room-switch-enter"), 220);
      row.scrollIntoView({ block: "nearest" });
    }
  };
  app.switchRoom = (roomId, direction) => {
    const list = app.$("#msgList");
    const transition = app.LS.contentTransition && list && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!transition || app.state.contentSwitching) {
      if (app.state.contentSwitching) return;
      app.activateRoom(roomId);
      app.animateRoomSwitch?.(direction);
      return;
    }
    const out = direction > 0 ? "room-content-out-next" : "room-content-out-prev";
    const into = direction > 0 ? "room-content-in-next" : "room-content-in-prev";
    app.state.contentSwitching = true;
    list.classList.add(out);
    setTimeout(() => {
      app.activateRoom(roomId);
      app.animateRoomSwitch?.(direction);
      list.classList.remove(out, "room-content-in-next", "room-content-in-prev");
      void list.offsetWidth;
      list.classList.add(into);
      setTimeout(() => {
        list.classList.remove(into);
        app.state.contentSwitching = false;
      }, 220);
    }, 140);
  };
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Home" || event.code === "Home") { event.preventDefault(); scrollToEdge(false); return; }
    if (event.key === "End" || event.code === "End") { event.preventDefault(); scrollToEdge(true); return; }
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
    if (digit) {
      const rows = Array.from(document.querySelectorAll("#roomListChat .room-row.joined"));
      const target = rows[Number(digit) - 1];
      if (!target) return;
      event.preventDefault();
      const current = rows.findIndex((row) => row.dataset.roomId === app.state.room?.id);
      const targetIndex = Number(digit) - 1;
      if (targetIndex === current) return;
      const direction = current < 0 || targetIndex > current ? 1 : -1;
      const roomId = target.dataset.roomId;
      if (roomId) {
        if (app.switchRoom) app.switchRoom(roomId, direction);
        else { app.activateRoom(roomId); app.animateRoomSwitch?.(direction); }
      }
      return;
    }
    if (event.key !== "/" && event.code !== "Slash") return;
    event.preventDefault();
    openSheet();
  });
}