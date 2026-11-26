// OpenTUI controller: keys, focus, theme changes and view syncing.
// Renderable construction lives in ui-view.mjs, state mapping in ui-content.mjs.
import { CliRenderEvents } from "@opentui/core";
import {
  syncComposer,
  syncFocus,
  syncHeader,
  syncLayout,
  syncMessages,
  syncPalette,
  syncRooms,
  syncStatus,
} from "./ui-content.mjs";
import { createTheme } from "./ui-theme.mjs";
import { syncHelp } from "./ui-help.mjs";
import { createView } from "./ui-view.mjs";
import { handleSuggestKey, syncSuggest } from "./ui-suggest.mjs";
import { syncMentionHighlights } from "./ui-mentions.mjs";
import { setLanguage } from "./i18n.mjs";

const printable = (key) => {
  const char = Array.from(key.sequence ?? "")[0];
  return char !== undefined && char.codePointAt(0) >= 0x20 && char.codePointAt(0) !== 0x7f;
};

export class Tui {
  constructor(renderer, app) {
    this.renderer = renderer;
    this.app = app;
    this.themeState = createTheme(renderer, app.state.theme);
    this.theme = this.themeState.theme;
    app.state.theme = this.themeState.mode;
    this.focusKey = null;
    this.roomSignature = "";
    this.messageSignature = "";
    this.helpSignature = "";
    this.syntaxStyles = new Map();
    this.messageBlocks = [];
    this.selectedRoomID = null;
    this.hoverRoomId = null;
    this.roomRows = new Map();
    this.pendingScrollTo = null;
    this.pendingBottom = false;
    this.pendingRoomScroll = null;
    this.syncingComposer = false;
    this.syncingPalette = false;
    this.paletteInputMode = false;
    this.detailSignature = "";
    this.suggestKind = null;
    this.suggestSnapshot = null;
    this.suggestItems = [];
    this.suggestSelected = 0;
    this.suggestTrigger = null;
    this.suggestQuery = "";
    this.suggestDismissed = null;
    this.mentionStyles = new Map();
    this.mentionSignature = "";
    this.mentionTypeId = null;

    Object.assign(this, createView(renderer, this.theme));
    this.textarea.onContentChange = () => {
      if (this.syncingComposer) return;
      this.app.setDraft(this.textarea.plainText);
      syncSuggest(this, this.app.state);
      syncMentionHighlights(this, this.app.state);
      this.renderer.requestRender();
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
      this.app.state.theme = this.themeState.mode;
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
    if (state.focus === "composer" && handleSuggestKey(this, key, state)) return;
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
    const palette = this.app.state.palette;
    if (!palette) return;
    if ((key.name === "space" && (key.meta || key.option)) || (key.name === "p" && key.ctrl)) {
      key.preventDefault();
      this.app.closePalette();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (palette.mode === "confirm") this.app.cancelConfirm();
      else if (palette.mode === "detail") this.app.backFromDetail();
      else this.app.closePalette();
      return;
    }
    if (palette.mode === "confirm") {
      if (key.name === "return" || key.sequence === "y") {
        key.preventDefault();
        void this.app.runConfirm();
      } else if (key.sequence === "n") {
        key.preventDefault();
        this.app.cancelConfirm();
      }
      return;
    }
    if (palette.mode === "detail") {
      if (key.name === "up" || key.name === "pageup") {
        key.preventDefault();
        this.paletteDetailScroll.scrollBy(-0.5, "viewport");
        this.renderer.requestRender();
      } else if (key.name === "down" || key.name === "pagedown") {
        key.preventDefault();
        this.paletteDetailScroll.scrollBy(0.5, "viewport");
        this.renderer.requestRender();
      } else if (key.sequence === "d" && palette.kind === "announcements") {
        key.preventDefault();
        this.app.askDeleteAnnouncement(palette.detail?.title);
      } else if (key.sequence === "e" && palette.kind === "settings") {
        key.preventDefault();
        this.app.openSettingsEditor();
      } else if (palette.kind === "room-settings") {
        if (key.sequence === "r") {
          key.preventDefault();
          this.app.startRoomRename();
        } else if (key.sequence === "d") {
          key.preventDefault();
          this.app.startRoomDescription();
        } else if (key.sequence === "j") {
          key.preventDefault();
          this.app.askRoomJoinPolicy();
        } else if (key.sequence === "x") {
          key.preventDefault();
          this.app.askDeleteRoom();
        }
      } else if (key.name === "return") {
        key.preventDefault();
      }
      return;
    }
    if (palette.mode === "info") {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        this.app.movePalette(key.name === "up" ? -1 : 1);
      } else if (key.name === "pageup" || key.name === "pagedown") {
        key.preventDefault();
        this.app.movePalette(key.name === "pageup" ? -5 : 5);
      } else if (key.name === "return") {
        key.preventDefault();
        void this.app.runPaletteSelection();
      } else if (key.sequence === "n" && palette.kind === "announcements") {
        key.preventDefault();
        this.app.startAnnouncementCreate();
      } else if (key.sequence === "d" && palette.kind === "announcements") {
        key.preventDefault();
        this.app.askDeleteAnnouncement();
      } else if (key.sequence === "u" && palette.kind === "files") {
        key.preventDefault();
        this.app.startFileUpload();
      } else if (key.sequence === "d" && palette.kind === "files") {
        key.preventDefault();
        this.app.askDeleteFile();
      } else if (key.sequence === "d" && palette.kind === "join-requests") {
        key.preventDefault();
        this.app.askJoinDecision("deny");
      } else if (palette.kind === "reminders") {
        if (key.sequence === "n") {
          key.preventDefault();
          this.app.startReminderCreate();
        } else if (key.sequence === "p") {
          key.preventDefault();
          void this.app.toggleReminder();
        } else if (key.sequence === "e") {
          key.preventDefault();
          this.app.startReminderEdit();
        } else if (key.sequence === "d") {
          key.preventDefault();
          this.app.askDeleteReminder();
        }
      }
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
    setLanguage(state.language);
    if (state.theme !== this.themeState.mode && this.themeState.set(state.theme)) {
      this.roomSignature = "";
      this.messageSignature = "";
      this.helpSignature = "";
      this.detailSignature = "";
    }
    syncLayout(this);
    syncHeader(this, state);
    syncRooms(this, state);
    syncMessages(this, state);
    syncComposer(this, state);
    syncStatus(this, state);
    this.overlayBackdrop.visible = Boolean(state.palette || state.help);
    syncPalette(this, state);
    syncHelp(this, state);
    syncFocus(this, state);
    syncSuggest(this, state);
    this.renderer.requestRender();
  }
}

export function createTui(renderer, app) {
  return new Tui(renderer, app);
}