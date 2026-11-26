// Headless chat state for the TUI. Kept free of terminal and palette code so
// the reducer can be tested against a fake api. Palette methods are attached
// from palette-app.mjs.
import { attachPalette } from "./palette-app.mjs";
import { attachInfo } from "./info-app.mjs";
import { attachSettings } from "./settings-app.mjs";
import { attachReminders } from "./reminder-app.mjs";
import { attachRoomSettings } from "./room-settings-app.mjs";
import { attachMessageActions } from "./message-app.mjs";
import { attachJoinRequests } from "./join-app.mjs";
import { canonicalizeMentions } from "./mentions.mjs";
import { mergeMessages, messageStamp, oldestSeq } from "./messages.mjs";
import { normalizeLanguage, setLanguage, t } from "./i18n.mjs";
import { normalizeTheme } from "./prefs.mjs";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));

const normalizeRoom = (room) => ({
  id: String(room.id ?? ""),
  name: String(room.name ?? room.id ?? "room"),
  participants: Array.isArray(room.participants) ? room.participants : [],
  joined: room.joined === true,
});

export class ChatApp {
  constructor({ api, sessionID, participant, host = "", autoPoll = true, settings = {}, savePrefs = null, downloadDir = process.cwd(), schedule = (fn, ms) => setTimeout(fn, ms) }) {
    this.api = api;
    this.sessionID = sessionID;
    this.participant = participant;
    this.autoPoll = autoPoll;
    this.schedule = schedule;
    this.savePrefs = typeof savePrefs === "function" ? savePrefs : null;
    this.settings = { ...settings };
    this.token = this.settings.token ?? "";
    delete this.settings.token;
    this.prefs = {
      language: normalizeLanguage(this.settings.language),
      theme: normalizeTheme(this.settings.theme),
      participant: this.settings.participant ?? participant,
      url: this.settings.server ?? "",
    };
    setLanguage(this.prefs.language);
    this.downloadDir = downloadDir;
    this.closed = false;
    this.pollToken = 0;
    this.timers = new Set();
    this.pollAbort = null;
    this.cache = new Map();
    this.historyCursor = new Map();
    this.historyMore = new Map();
    this.historyPages = new Map();
    this.historyInflight = new Set();
    this.listeners = new Set();
    this.state = {
      host,
      participant,
      theme: this.prefs.theme,
      language: this.prefs.language,
      connection: "connecting",
      rooms: [],
      selected: 0,
      current: null,
      joined: false,
      messages: [],
      pending: null,
      focus: "rooms",
      draft: "",
      highlight: null,
      help: false,
      status: "",
      statusKind: "info",
      palette: null,
      quit: false,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  touch() {
    for (const listener of this.listeners) listener(this.state);
  }

  later(fn, ms) {
    if (this.closed) return undefined;
    let timer;
    const run = () => {
      if (timer !== undefined) this.timers.delete(timer);
      return fn();
    };
    timer = this.schedule(run, ms);
    if (timer !== undefined) this.timers.add(timer);
    return timer;
  }

  setStatus(text, kind = "info") {
    this.state.status = text;
    this.state.statusKind = kind;
    this.touch();
  }

  async init() {
    await this.refreshRooms(true);
  }

  async refreshRooms(quiet = false) {
    try {
      const list = await this.api.listRooms(this.sessionID);
      const rooms = (Array.isArray(list) ? list : []).map(normalizeRoom);
      const selectedID = this.state.rooms[this.state.selected]?.id;
      this.state.rooms = rooms;
      const found = selectedID ? rooms.findIndex((room) => room.id === selectedID) : -1;
      this.state.selected = found >= 0 ? found : Math.min(this.state.selected, Math.max(0, rooms.length - 1));
      this.state.connection = "online";
      if (!quiet) {
        this.state.status = t("status.refreshed");
        this.state.statusKind = "info";
      }
      this.touch();
      return true;
    } catch (error) {
      this.state.connection = "offline";
      this.state.status = t("status.refreshFailed", { error: errorText(error) });
      this.state.statusKind = "error";
      this.touch();
      return false;
    }
  }

  isCurrent(roomID) {
    return this.state.current?.id === roomID;
  }

  async openSelected() {
    return this.openRoom(this.state.selected);
  }

  async openRoom(indexOrRoom) {
    const index = typeof indexOrRoom === "number" ? indexOrRoom : this.state.rooms.indexOf(indexOrRoom);
    const summary = this.state.rooms[index];
    if (!summary) return;
    this.state.selected = index;
    this.stopPolling();
    this.state.current = { id: summary.id, name: summary.name, participants: summary.participants };
    this.state.joined = summary.joined;
    this.state.messages = [];
    this.state.pending = null;
    this.state.highlight = null;
    this.state.status = t("status.opening", { name: summary.name });
    this.state.statusKind = "info";
    this.touch();
    if (summary.joined) await this.loadRoom(summary.id);
    else await this.joinRoom(summary.id);
  }

  async joinRoom(roomID) {
    try {
      const result = await this.api.join(roomID, this.sessionID, this.participant);
      if (!this.isCurrent(roomID)) return;
      if (result?.pending) {
        const message = String(result.message ?? t("status.joinPending"));
        this.state.pending = { roomId: roomID, message };
        this.state.joined = false;
        this.state.status = message;
        this.state.statusKind = "info";
        this.touch();
        this.later(() => this.checkJoin(roomID), 1500);
        return;
      }
      this.enterRoom(result?.room ?? result, roomID, true);
    } catch (error) {
      if (this.isCurrent(roomID)) this.setStatus(t("status.joinFailed", { error: errorText(error) }), "error");
    }
  }

  async checkJoin(roomID) {
    if (this.closed || !this.isCurrent(roomID) || this.state.pending?.roomId !== roomID) return;
    try {
      const result = await this.api.joinStatus(roomID, this.sessionID);
      if (!this.isCurrent(roomID) || this.state.pending?.roomId !== roomID) return;
      const status = typeof result === "string" ? result : result?.status;
      if (status === "joined") {
        this.state.pending = null;
        this.setStatus(t("status.joinApproved"), "success");
        await this.loadRoom(roomID);
        return;
      }
      if (status === "pending") {
        this.later(() => this.checkJoin(roomID), 1500);
        return;
      }
      this.state.pending = null;
      this.setStatus(t("status.joinStale"), "error");
    } catch {
      this.later(() => this.checkJoin(roomID), 1500);
    }
  }

  async loadRoom(roomID) {
    try {
      const room = await this.api.getRoom(roomID);
      if (!this.isCurrent(roomID) || !room) return;
      if (room.joined === false) {
        this.notJoined(roomID, t("status.notMember"));
        return;
      }
      this.enterRoom(room, roomID, false);
    } catch (error) {
      if (this.isCurrent(roomID)) this.setStatus(t("status.openFailed", { error: errorText(error) }), "error");
    }
  }

  enterRoom(room, roomID, joinedNow) {
    if (!room || typeof room !== "object") {
      this.setStatus(t("status.roomMissing"), "error");
      return;
    }
    const summary = this.state.rooms.find((item) => item.id === roomID);
    if (summary) {
      summary.joined = true;
      summary.name = String(room.name ?? summary.name);
      if (Array.isArray(room.participants)) summary.participants = room.participants;
    }
    const cache = this.historyList(roomID);
    mergeMessages(cache, room.messages);
    this.state.current = {
      id: roomID,
      name: String(room.name ?? summary?.name ?? roomID),
      participants: Array.isArray(room.participants) ? room.participants : summary?.participants ?? [],
    };
    this.state.joined = true;
    this.state.pending = null;
    this.state.messages = cache;
    this.state.connection = "online";
    this.state.status = joinedNow ? t("status.joined", { name: this.state.current.name }) : "";
    this.state.statusKind = "success";
    if (typeof room.hasMore === "boolean") this.historyMore.set(roomID, room.hasMore);
    const oldest = oldestSeq(cache);
    if (oldest !== undefined) this.historyCursor.set(roomID, oldest);
    this.touch();
    this.markRead();
    if (this.autoPoll) this.startPolling();
  }

  historyList(roomID) {
    let list = this.cache.get(roomID);
    if (!list) {
      list = [];
      this.cache.set(roomID, list);
    }
    return list;
  }

  merge(items) {
    mergeMessages(this.state.messages, items);
  }

  lastTs() {
    return this.state.messages.reduce((max, message) => Math.max(max, messageStamp(message)), 0);
  }

  async pollOnce() {
    const room = this.state.current;
    if (!room || !this.state.joined) return false;
    const roomID = room.id;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    this.pollAbort = controller;
    try {
      const result = await this.api.poll(
        roomID,
        this.sessionID,
        this.lastTs(),
        controller ? { signal: controller.signal } : undefined,
      );
      if (!this.isCurrent(roomID)) return false;
      if (!result || result.member === false) {
        this.notJoined(roomID, t("status.memberLost"));
        return false;
      }
      const wasOffline = this.state.connection !== "online";
      this.merge(result.items);
      this.state.connection = "online";
      if (wasOffline) {
        this.state.status = t("status.reconnected");
        this.state.statusKind = "success";
      }
      this.touch();
      this.markRead();
      return true;
    } catch (error) {
      if (controller?.signal.aborted) return false;
      this.state.connection = "reconnecting";
      this.state.status = t("status.connectionLost", { error: errorText(error) });
      this.state.statusKind = "error";
      this.touch();
      return false;
    } finally {
      if (this.pollAbort === controller) this.pollAbort = null;
    }
  }

  startPolling() {
    const token = ++this.pollToken;
    let delay = 0;
    const step = async () => {
      if (this.closed || token !== this.pollToken || !this.state.joined) return;
      const ok = await this.pollOnce();
      if (this.closed || token !== this.pollToken || !this.state.joined) return;
      delay = ok ? 0 : Math.min(delay ? delay * 2 : BACKOFF_MS[0], BACKOFF_MS.at(-1));
      this.later(step, delay);
    };
    step();
  }

  stopPolling() {
    this.pollToken += 1;
    this.pollAbort?.abort();
  }

  notJoined(roomID, message) {
    if (!this.isCurrent(roomID)) return;
    this.state.joined = false;
    const summary = this.state.rooms.find((room) => room.id === roomID);
    if (summary) summary.joined = false;
    this.setStatus(message, "error");
  }

  markRead() {
    const room = this.state.current;
    const newest = this.lastTs();
    if (!room || !newest) return;
    try {
      const result = this.api.markRead?.(room.id, this.sessionID, newest);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // A read receipt failure must not interrupt the UI.
    }
  }

  async send() {
    const raw = String(this.state.draft ?? "").trim();
    if (!raw) return;
    const room = this.state.current;
    if (!room || !this.state.joined) {
      this.setStatus(t("status.joinBeforeSend"), "error");
      return;
    }
    const text = canonicalizeMentions(raw, room.participants);
    // Reuse the attempt's id when the same failed text is sent again, so a lost
    // response cannot produce two messages.
    const attempt = this.pendingSend && this.pendingSend.text === raw
      ? this.pendingSend
      : { text: raw, clientMessageID: globalThis.crypto.randomUUID() };
    this.pendingSend = attempt;
    this.state.draft = "";
    this.touch();
    try {
      const result = await this.api.send(room.id, this.sessionID, text, { clientMessageID: attempt.clientMessageID });
      if (!this.isCurrent(room.id)) return;
      this.pendingSend = null;
      if (Array.isArray(result?.messages)) this.merge(result.messages);
      else if (result?.id) this.merge([result]);
      this.state.highlight = null;
      this.state.connection = "online";
      this.setStatus(t("status.sent"), "success");
      this.markRead();
    } catch (error) {
      // Keep text typed while the request was in flight; dropping it loses work.
      this.state.draft = this.state.draft ? `${raw}\n${this.state.draft}` : raw;
      this.setStatus(t("status.sendFailed", { error: errorText(error) }), "error");
    }
  }

  setDraft(text) {
    this.state.draft = String(text ?? "");
  }

  appendDraft(text) {
    this.state.draft += String(text ?? "");
    this.state.focus = "composer";
    this.state.help = false;
    this.touch();
  }

  moveSelection(delta) {
    if (!this.state.rooms.length) return;
    this.state.selected = Math.min(
      this.state.rooms.length - 1,
      Math.max(0, this.state.selected + delta),
    );
    this.state.highlight = null;
    this.touch();
  }

  selectRoom(index) {
    if (!this.state.rooms[index]) return;
    this.state.selected = index;
    this.state.highlight = null;
    this.touch();
  }

  toggleFocus() {
    this.state.focus = this.state.focus === "rooms" ? "composer" : "rooms";
    if (this.state.focus === "composer") this.state.help = false;
    this.touch();
  }

  toggleHelp() {
    this.state.help = !this.state.help;
    this.touch();
  }

  clearOrBlur() {
    this.state.draft = "";
    this.state.focus = "rooms";
    this.state.highlight = null;
    this.touch();
  }

  clearHighlight() {
    if (!this.state.highlight) return;
    this.state.highlight = null;
    this.touch();
  }

  quit() {
    this.state.quit = true;
    this.close();
    this.touch();
  }

  close() {
    this.closed = true;
    this.pollToken += 1;
    this.pollAbort?.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

attachPalette(ChatApp);
attachInfo(ChatApp);
attachSettings(ChatApp);
attachReminders(ChatApp);
attachRoomSettings(ChatApp);
attachMessageActions(ChatApp);
attachJoinRequests(ChatApp);

export function createApp(options) {
  return new ChatApp(options);
}