// Command palette controller attached to ChatApp. Kept in its own file so the
// terminal core stays under the project line budget.
import { buildCommands, filterCommands, nextScope, scopeSources, searchMessages } from "./palette.mjs";
import { mergeMessages, oldestSeq } from "./messages.mjs";

const SEARCH_PAGES = 2;

export function attachPalette(Class) {
  Object.assign(Class.prototype, {
    openPalette({ slash = false } = {}) {
      this.historyPages.clear();
      this.state.help = false;
      // Same rule as the web palette: only "/" means commands; empty input
      // waits for a search query instead of showing a command wall.
      this.state.palette = {
        mode: slash ? "commands" : "search",
        query: slash ? "/" : "",
        scope: "room",
        selected: 0,
        results: [],
        prompt: null,
        searching: false,
        error: "",
        commands: buildCommands({
          rooms: this.state.rooms,
          current: this.state.current,
          joined: this.state.joined,
          help: this.state.help,
        }),
      };
      this.touch();
    },

    closePalette() {
      this.state.palette = null;
      this.state.focus = "composer";
      this.touch();
    },

    paletteCommands() {
      const palette = this.state.palette;
      const query = palette?.mode === "commands" ? String(palette.query ?? "").replace(/^\s*\//, "") : "";
      const commands = palette?.commands ?? buildCommands({
        rooms: this.state.rooms,
        current: this.state.current,
        joined: this.state.joined,
        help: this.state.help,
      });
      return filterCommands(commands, query);
    },

    paletteItems() {
      const palette = this.state.palette;
      if (!palette) return [];
      if (palette.mode === "search") return palette.results;
      if (palette.mode === "commands") return this.paletteCommands();
      if (palette.mode === "info") return palette.items ?? [];
      return [];
    },

    paletteScopeRooms(scope) {
      if (scope === "all") return this.state.rooms.filter((room) => room.joined);
      return this.state.current && this.state.joined ? [this.state.current] : [];
    },

    refreshPaletteResults() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "search") return;
      palette.results = searchMessages(palette.query, scopeSources({
        rooms: this.state.rooms,
        current: this.state.current,
        scope: palette.scope,
        cache: this.cache,
      }));
      palette.selected = Math.min(palette.selected, Math.max(0, palette.results.length - 1));
      this.touch();
    },

    async ensureSearchHistory() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "search" || typeof this.api.history !== "function") return;
      const jobs = this.paletteScopeRooms(palette.scope).filter((room) =>
        (this.historyPages.get(room.id) ?? 0) < SEARCH_PAGES
        && this.historyMore.get(room.id) !== false
        && !this.historyInflight.has(room.id));
      if (!jobs.length) return;
      palette.searching = true;
      this.touch();
      for (const room of jobs) {
        this.historyInflight.add(room.id);
        try {
          await this.fetchHistoryPage(room.id);
          // A failed page must not consume the room's search budget.
          this.historyPages.set(room.id, (this.historyPages.get(room.id) ?? 0) + 1);
        } catch (error) {
          if (this.state.palette === palette) palette.error = `history: ${error.message ?? error}`;
        } finally {
          this.historyInflight.delete(room.id);
        }
        if (this.state.palette === palette) this.refreshPaletteResults();
      }
      if (this.state.palette === palette) {
        palette.searching = this.historyInflight.size > 0;
        this.refreshPaletteResults();
      }
    },

    async fetchHistoryPage(roomID) {
      const beforeSeq = this.historyCursor.get(roomID);
      const result = await this.api.history(roomID, this.sessionID, beforeSeq);
      const messages = Array.isArray(result) ? result : result?.messages ?? result?.items ?? [];
      mergeMessages(this.historyList(roomID), messages);
      this.historyMore.set(roomID, result?.hasMore === true);
      const next = result?.nextBeforeSeq ?? result?.beforeSeq ?? oldestSeq(this.historyList(roomID));
      if (typeof next === "number" && Number.isFinite(next)) this.historyCursor.set(roomID, next);
    },

    movePalette(delta) {
      const items = this.paletteItems();
      if (!items.length) return;
      const palette = this.state.palette;
      palette.selected = Math.min(items.length - 1, Math.max(0, palette.selected + delta));
      this.touch();
    },

    async runPaletteSelection() {
      const palette = this.state.palette;
      if (!palette) return;
      if (palette.mode === "prompt") {
        await this.submitPalettePrompt();
        return;
      }
      if (palette.mode === "info") {
        await this.runInfoSelection();
        return;
      }
      if (palette.mode === "confirm") {
        await this.runConfirm();
        return;
      }
      if (palette.mode === "detail") return;
      if (palette.mode === "commands") {
        const command = this.paletteCommands()[palette.selected];
        if (command) await this.runPaletteCommand(command);
        return;
      }
      const result = palette.results[palette.selected];
      if (result) await this.activateResult(result);
    },

    async submitPalettePrompt() {
      const palette = this.state.palette;
      const value = palette?.prompt?.value ?? "";
      if (!palette?.prompt) return;
      if (palette.prompt.action && palette.prompt.action !== "new-room") {
        await this.submitCommandPrompt(palette.prompt, value);
        return;
      }
      await this.createRoomFromPrompt();
    },

    async runPaletteCommand(command) {
      const palette = this.state.palette;
      switch (command.id) {
        case "refresh":
          this.closePalette();
          await this.refreshRooms();
          return;
        case "new-room":
          palette.mode = "prompt";
          palette.prompt = { label: "New room name", value: "", action: "new-room", data: {} };
          palette.selected = 0;
          palette.error = "";
          this.touch();
          return;
        case "toggle-help":
          this.state.help = !this.state.help;
          this.state.palette = null;
          this.state.focus = "rooms";
          this.touch();
          return;
        case "leave-room":
          this.closePalette();
          await this.leaveCurrent();
          return;
        case "search-room":
        case "search-all":
          palette.mode = "search";
          palette.scope = command.id === "search-all" ? "all" : "room";
          palette.query = "";
          palette.results = [];
          palette.selected = 0;
          palette.error = "";
          this.touch();
          void this.ensureSearchHistory();
          return;
        case "members":
          await this.openMembers();
          return;
        case "join-requests":
          await this.openJoinRequests();
          return;
        case "announcements":
          await this.openAnnouncements();
          return;
        case "questions":
          await this.openQuestions();
          return;
        case "files":
          await this.openFiles();
          return;
        case "reminders":
          await this.openReminders();
          return;
        case "settings":
          this.openSettings();
          return;
        case "room-settings":
          await this.openRoomSettings();
          return;
        case "delete-room":
          await this.openRoomSettings();
          this.askDeleteRoom();
          return;
        case "recall-message":
          this.startMessageRecall();
          return;
        case "reveal-message":
          this.startMessageReveal();
          return;
        case "reply-message":
          this.startMessageReply();
          return;
        case "ask-question":
          this.startAskQuestion();
          return;
        case "quit":
          this.closePalette();
          this.quit();
          return;
        default:
          if (command.roomId) {
            const index = this.state.rooms.findIndex((room) => room.id === command.roomId);
            this.closePalette();
            if (index >= 0) await this.openRoom(index);
          }
      }
    },

    async activateResult(result) {
      const index = this.state.rooms.findIndex((room) => room.id === result.roomId);
      this.closePalette();
      if (index >= 0 && this.state.current?.id !== result.roomId) await this.openRoom(index);
      this.state.highlight = result.message.id;
      this.state.focus = "composer";
      this.touch();
    },

    async createRoomFromPrompt() {
      const palette = this.state.palette;
      const name = String(palette?.prompt?.value ?? "").trim();
      if (!name) {
        palette.error = "enter a room name";
        this.touch();
        return;
      }
      palette.searching = true;
      palette.error = "";
      this.touch();
      try {
        const created = await this.api.createRoom(name, this.sessionID, this.participant);
        const roomID = created?.room?.id ?? created?.id;
        await this.refreshRooms(true);
        const index = this.state.rooms.findIndex((room) => room.id === roomID);
        this.closePalette();
        if (index >= 0) await this.openRoom(index);
        else this.setStatus(`created #${name}`, "success");
      } catch (error) {
        if (this.state.palette) {
          this.state.palette.searching = false;
          this.state.palette.error = error.message ?? String(error);
          this.touch();
        }
      }
    },

    async leaveCurrent() {
      const room = this.state.current;
      if (!room || !this.state.joined) {
        this.setStatus("not joined to a room", "error");
        return;
      }
      try {
        await this.api.leave(room.id, this.sessionID);
        this.stopPolling();
        this.state.joined = false;
        const summary = this.state.rooms.find((item) => item.id === room.id);
        if (summary) summary.joined = false;
        await this.refreshRooms(true);
        this.setStatus(`left #${room.name}`, "success");
      } catch (error) {
        this.setStatus(`could not leave: ${error.message ?? error}`, "error");
      }
    },

    setPaletteQuery(value) {
      const palette = this.state.palette;
      if (!palette || (palette.mode !== "commands" && palette.mode !== "search")) return;
      const query = String(value ?? "");
      palette.error = "";
      if (!query.trim()) {
        palette.mode = "search";
        palette.query = "";
        palette.results = [];
        palette.selected = 0;
        palette.searching = false;
        this.touch();
        return;
      }
      if (query.trimStart().startsWith("/")) {
        palette.mode = "commands";
        palette.query = query;
        palette.results = [];
        palette.searching = false;
        palette.selected = 0;
        this.touch();
        return;
      }
      palette.mode = "search";
      palette.query = query;
      palette.selected = 0;
      this.refreshPaletteResults();
      void this.ensureSearchHistory();
    },

    setPalettePrompt(value) {
      const palette = this.state.palette;
      if (palette?.prompt) palette.prompt.value = String(value ?? "");
    },

    togglePaletteScope() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "search") return;
      palette.scope = nextScope(palette.scope);
      palette.selected = 0;
      palette.error = "";
      this.refreshPaletteResults();
      void this.ensureSearchHistory();
    },
  });
}