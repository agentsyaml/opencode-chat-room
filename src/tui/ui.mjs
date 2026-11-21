// OpenTUI controller: keys, focus, theme changes and view syncing.
// Renderable construction lives in ui-view.mjs, state mapping in ui-content.mjs.
import { CliRenderEvents } from "@opentui/core";
import {
  syncComposer,
  syncFocus,
  syncHeader,
  syncHelp,
  syncLayout,
  syncMessages,
  syncPalette,
  syncRooms,
  syncStatus,
} from "./ui-content.mjs";
import { createTheme } from "./ui-theme.mjs";
import { createView } from "./ui-view.mjs";

const printable = (key) => {
  const char = Array.from(key.sequence ?? "")[0];
  return char !== undefined && char.codePointAt(0) >= 0x20 && char.codePointAt(0) !== 0x7f;
};

export class Tui {
  constructor(renderer, app) {
    this.renderer = renderer;
    this.app = app;
    this.themeState = createTheme(renderer);
    this.theme = this.themeState.theme;
    this.focusKey = null;
    this.roomSignature = "";
    this.messageSignature = "";
    this.helpSignature = "";
    this.selectedRoomID = null;
    this.hoverRoomId = null;
    this.roomRows = new Map();
    this.pendingScrollTo = null;
    this.pendingBottom = false;
    this.pendingRoomScroll = null;
    this.syncingComposer = false;
    this.syncingPalette = false;

    Object.assign(this, createView(renderer, this.theme));
    this.textarea.onContentChange = () => {
      if (this.syncingComposer) return;
      this.app.setDraft(this.textarea.plainText);
    };
    this.paletteInput.onContentChange = () => {
      if (this.syncingPalette) return;
      const palette = this.app.state.palette;
      if (!palette) return;
      if (palette.mode === "prompt") this.app.setPalettePrompt(this.paletteInput.value);
      else this.app.setPaletteQuery(this.paletteInput.value);
    };

    this.onKey = (key) => this.handleKey(key);
    this.onResize = () => this.sync();
    this.onTheme = (mode) => {
      if (!this.themeState.set(mode)) return;
      this.roomSignature = "";
      this.messageSignature = "";
      this.helpSignature = "";
      this.sync();
    };
    this.onFrame = () => {
      let changed = false;
      if (this.pendingRoomScroll) {
        this.roomScroll.scrollChildIntoView(this.pendingRoomScroll);
        this.pendingRoomScroll = null;
        changed = true;
      }
      if (this.pendingScrollTo) {
        this.scrollBox.scrollChildIntoView(this.pendingScrollTo);
        this.pendingScrollTo = null;
        changed = true;
      } else if (this.pendingBottom) {
        this.pendingBottom = false;
        this.scrollBox.scrollTop = Math.max(0, this.messageContent.height - this.scrollBox.viewport.height);
        changed = true;
      }
      if (changed) this.renderer.requestRender();
    };
    renderer.keyInput.on("keypress", this.onKey);
    renderer.on(CliRenderEvents.RESIZE, this.onResize);
    renderer.on(CliRenderEvents.THEME_MODE, this.onTheme);
    renderer.on(CliRenderEvents.FRAME, this.onFrame);
    this.unsubscribe = app.subscribe(() => this.sync());
    this.sync();
  }

  destroy() {
    this.unsubscribe?.();
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize);
    this.renderer.off(CliRenderEvents.THEME_MODE, this.onTheme);
    this.renderer.off(CliRenderEvents.FRAME, this.onFrame);
  }

  scrollToStart() {
    this.app.clearHighlight();
    this.scrollBox.scrollTop = 0;
    this.renderer.requestRender();
  }

  scrollToEnd() {
    this.app.clearHighlight();
    this.scrollBox.scrollTop = Math.max(0, this.messageContent.height - this.scrollBox.viewport.height);
    this.renderer.requestRender();
  }

  handleKey(key) {
    if (key.eventType === "release") return;
    const state = this.app.state;
    const palette = state.palette;

    if (key.name === "c" && key.ctrl) {
      key.preventDefault();
      this.app.quit();
      return;
    }
    if (palette) {
      this.handlePaletteKey(key);
      return;
    }
    if ((key.name === "space" && (key.meta || key.option)) || (key.name === "p" && key.ctrl)) {
      key.preventDefault();
      this.app.openPalette();
      return;
    }
    if (key.name === "r" && key.ctrl) {
      key.preventDefault();
      void this.app.refreshRooms();
      return;
    }
    if (state.help) {
      if (key.name === "escape" || key.sequence === "?") {
        key.preventDefault();
        this.app.toggleHelp();
      } else if (key.name === "tab") {
        key.preventDefault();
        this.app.toggleHelp();
        this.app.toggleFocus();
      }
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      this.app.toggleFocus();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      this.app.clearOrBlur();
      return;
    }
    if ((key.meta || key.option) && key.name === "home") {
      key.preventDefault();
      this.scrollToStart();
      return;
    }
    if ((key.meta || key.option) && key.name === "end") {
      key.preventDefault();
      this.scrollToEnd();
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      this.app.clearHighlight();
      this.scrollBox.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
      this.renderer.requestRender();
      return;
    }

    if (state.focus === "composer") {
      if (key.name === "return") {
        key.preventDefault();
        this.app.setDraft(this.textarea.plainText);
        void this.app.send();
      }
      return;
    }

    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      this.app.moveSelection(key.name === "up" ? -1 : 1);
      return;
    }
    if (key.name === "return") {
      key.preventDefault();
      void this.app.openSelected();
      return;
    }
    if (key.sequence === "?") {
      key.preventDefault();
      this.app.toggleHelp();
      return;
    }
    if (key.sequence === "q") {
      key.preventDefault();
      this.app.quit();
      return;
    }
    if (!key.ctrl && !key.meta && printable(key)) {
      key.preventDefault();
      // Focusing the composer in this handler must not let the same key reach
      // the now-focused textarea twice or split the first character.
      key.stopPropagation();
      this.app.appendDraft(key.sequence);
    }
  }

  handlePaletteKey(key) {
    if ((key.name === "space" && (key.meta || key.option)) || (key.name === "p" && key.ctrl)) {
      key.preventDefault();
      this.app.closePalette();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      this.app.closePalette();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      this.app.togglePaletteScope();
      return;
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      this.app.movePalette(key.name === "up" ? -1 : 1);
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      this.app.movePalette(key.name === "pageup" ? -5 : 5);
      return;
    }
    if (key.name === "return") {
      key.preventDefault();
      void this.app.runPaletteSelection();
      return;
    }
    // Typing and backspace belong to the focused palette input.
  }

  sync() {
    const state = this.app.state;
    syncLayout(this);
    syncHeader(this, state);
    syncRooms(this, state);
    syncMessages(this, state);
    syncComposer(this, state);
    syncStatus(this, state);
    syncPalette(this, state);
    syncHelp(this, state);
    syncFocus(this, state);
    this.renderer.requestRender();
  }
}

export function createTui(renderer, app) {
  return new Tui(renderer, app);
}