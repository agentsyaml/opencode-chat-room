// CLI parity commands: read-only member/question/file/reminder views plus
// announcement and question actions. Reuses the palette overlay as a scrollable
// info/list/detail surface instead of introducing another panel.
import {
  announcementRows,
  fileRows,
  memberRows,
  questionRows,
} from "./info-content.mjs";
import { t } from "./i18n.mjs";
import { sanitizeText } from "./messages.mjs";

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const announcementHint = () => t("info.announcementHint");

export function createInfoPalette(kind, title, subtitle) {
  return {
    mode: "info",
    kind,
    title,
    subtitle,
    roomId: "",
    items: [],
    selected: 0,
    error: "",
    loading: false,
    hint: "",
    query: "",
    scope: "room",
    results: [],
    searching: false,
    prompt: null,
    confirm: null,
    detail: null,
  };
}

export function attachInfo(Class) {
  Object.assign(Class.prototype, {
    currentInfoRoom() {
      if (this.state.current && this.state.joined) return this.state.current;
      this.state.palette = null;
      this.setStatus(t("info.joinFirst"), "error");
      return null;
    },

    // A palette acts on the room it was opened for, even if the rail has since
    // switched rooms; otherwise an announcement prompt could overwrite the new
    // room's same-named announcement.
    paletteRoomId(palette) {
      const roomId = palette.roomId || this.state.current?.id;
      if (!roomId) {
        palette.error = t("info.joinFirst");
        this.touch();
      }
      return roomId;
    },

    async openInfo(kind, title, hint, load) {
      const room = this.currentInfoRoom();
      if (!room) return;
      const palette = createInfoPalette(kind, title, `#${room.name}`);
      palette.roomId = room.id;
      palette.hint = hint;
      palette.loading = true;
      this.state.palette = palette;
      this.touch();
      try {
        const items = await load(room);
        if (this.state.palette !== palette) return;
        palette.items = Array.isArray(items) ? items : [];
        palette.loading = false;
        palette.selected = Math.min(palette.selected, Math.max(0, palette.items.length - 1));
        this.touch();
      } catch (error) {
        if (this.state.palette !== palette) return;
        palette.loading = false;
        palette.error = errorText(error);
        this.touch();
      }
    },

    openMembers() {
      return this.openInfo("members", t("info.members"), t("info.readOnlyHint"), async (room) =>
        memberRows(await this.api.members(room.id), this.sessionID));
    },

    openAnnouncements() {
      return this.openInfo("announcements", t("info.announcements"), announcementHint(), async (room) =>
        announcementRows(await this.api.announcements(room.id)));
    },

    openQuestions() {
      return this.openInfo("questions", t("info.questions"), t("info.questionHint"), async (room) =>
        questionRows(await this.api.questions(room.id), this.state.messages));
    },

    openFiles() {
      return this.openInfo("files", t("info.files"), t("info.fileHint"), async (room) => {
        const result = await this.api.resources(room.id, this.sessionID);
        return fileRows(Array.isArray(result) ? result : result?.resources);
      });
    },

    async runInfoSelection() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "info" || palette.loading) return;
      const item = this.paletteItems()[palette.selected];
      if (!item) return;
      if (palette.kind === "settings") {
        this.editSetting(item);
        return;
      }
      if (palette.kind === "announcements") {
        palette.mode = "detail";
        palette.detail = {
          title: String(item.value),
          markdown: String(item.content ?? "").trim() || t("common.emptyAnnouncement"),
          kind: "announcements",
        };
        palette.hint = t("info.announcementBackHint");
        this.touch();
        return;
      }
      if (palette.kind === "questions" && item.open) {
        palette.mode = "prompt";
        palette.prompt = {
          label: t("info.answerLabel", { text: sanitizeText(item.text).slice(0, 40) }),
          value: "",
          action: "question-answer",
          data: { id: String(item.value) },
        };
        palette.hint = t("palette.enterPostHint");
        this.touch();
        return;
      }
      if (palette.kind === "join-requests") {
        this.askJoinDecision("approve");
        return;
      }
      if (palette.kind === "files") await this.downloadFile(item);
    },

    startAnnouncementCreate() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "info" || palette.kind !== "announcements") return;
      palette.mode = "prompt";
      palette.prompt = { label: t("info.announcementName"), value: "", action: "announcement-name", data: {} };
      palette.error = "";
      palette.hint = t("palette.enterNextHint");
      this.touch();
    },

    askDeleteFile() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "info" || palette.kind !== "files") return;
      const item = this.paletteItems()[palette.selected];
      if (!item?.resource) return;
      palette.mode = "confirm";
      palette.previous = { mode: "info", hint: palette.hint };
      palette.confirm = {
        text: t("info.deleteFile", { name: sanitizeText(item.resource.name) }),
        action: "file-delete",
        data: { id: item.resource.id, name: item.resource.name },
      };
      palette.error = "";
      palette.hint = t("palette.deleteHint");
      this.touch();
    },

    async runFileDeleteConfirm(confirm) {
      const palette = this.state.palette;
      if (!palette) return;
      const roomId = this.paletteRoomId(palette);
      if (!roomId) return;
      palette.searching = true;
      palette.error = "";
      this.touch();
      try {
        await this.api.deleteResource(roomId, confirm.data.id, this.sessionID);
        this.setStatus(t("info.fileDeleted", { name: confirm.data.name }), "success");
        await this.openFiles();
      } catch (error) {
        if (this.state.palette === palette) {
          palette.mode = "info";
          palette.confirm = null;
          palette.previous = null;
          palette.searching = false;
          palette.hint = t("info.fileHint");
          palette.error = errorText(error);
          this.touch();
        }
      }
    },

    startFileUpload() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "info" || palette.kind !== "files") return;
      palette.mode = "prompt";
      palette.prompt = { label: t("info.filePath"), value: "", action: "file-upload", data: {} };
      palette.error = "";
      palette.hint = t("palette.enterUploadHint");
      this.touch();
    },

    askDeleteAnnouncement(name) {
      const palette = this.state.palette;
      const selected = name ?? palette?.items?.[palette.selected]?.value;
      if (!palette || !selected) return;
      palette.mode = "confirm";
      palette.error = "";
      palette.previous = { mode: "info", hint: palette.hint };
      palette.confirm = {
        text: t("info.deleteAnnouncement", { name: sanitizeText(selected) }),
        action: "announcement-delete",
        data: { name: String(selected) },
      };
      palette.hint = t("palette.deleteHint");
      this.touch();
    },

    async runConfirm() {
      const palette = this.state.palette;
      const confirm = palette?.confirm;
      if (!palette || !confirm) return;
      if (typeof confirm.action === "string" && confirm.action.startsWith("message-")) {
        await this.runMessageConfirm(confirm);
        return;
      }
      if (typeof confirm.action === "string" && confirm.action.startsWith("reminder-")) {
        await this.runReminderConfirm(confirm);
        return;
      }
      if (typeof confirm.action === "string" && confirm.action.startsWith("room-")) {
        await this.runRoomSettingsConfirm(confirm);
        return;
      }
      if (typeof confirm.action === "string" && confirm.action.startsWith("join-")) {
        await this.runJoinConfirm(confirm);
        return;
      }
      if (typeof confirm.action === "string" && confirm.action.startsWith("file-")) {
        await this.runFileDeleteConfirm(confirm);
        return;
      }
      if (confirm.action === "announcement-delete") {
        palette.searching = true;
        this.touch();
        try {
          await this.api.deleteAnnouncement(palette.roomId, confirm.data.name, this.sessionID);
          this.setStatus(t("info.announcementDeleted", { name: confirm.data.name }), "success");
          await this.openAnnouncements();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
      }
    },

    cancelConfirm() {
      const palette = this.state.palette;
      if (!palette) return;
      const previous = palette.previous;
      palette.previous = null;
      palette.confirm = null;
      palette.error = "";
      if (previous?.mode) {
        palette.mode = previous.mode;
        palette.hint = previous.hint ?? "";
      } else {
        palette.mode = "info";
        palette.hint = announcementHint();
      }
      this.touch();
    },

    backFromDetail() {
      const palette = this.state.palette;
      if (!palette) return;
      if (palette.previous?.mode === "info") {
        palette.mode = "info";
        palette.detail = null;
        palette.hint = palette.previous.hint ?? t("palette.listHint");
        palette.previous = null;
        this.touch();
        return;
      }
      if (palette.kind !== "announcements") {
        this.closePalette();
        return;
      }
      palette.mode = "info";
      palette.detail = null;
      palette.hint = announcementHint();
      this.touch();
    },

    async downloadFile(item) {
      const palette = this.state.palette;
      const roomId = palette ? this.paletteRoomId(palette) : this.state.current?.id;
      if (!roomId || !item?.resource) return;
      if (palette) palette.searching = true;
      this.touch();
      try {
        const payload = await this.api.resourceContent(roomId, item.resource.id);
        const [{ mkdir, writeFile, access }, path] = await Promise.all([
          import("node:fs/promises"),
          import("node:path"),
        ]);
        await mkdir(this.downloadDir, { recursive: true });
        const base = path.basename(String(item.resource.name || "download")).replace(/[\0\r\n]/g, "_");
        const filename = !base || base === "." || base === ".." ? "download" : base;
        let target = path.join(this.downloadDir, filename);
        try {
          await access(target);
          const extension = path.extname(filename);
          target = path.join(this.downloadDir, `${path.basename(filename, extension)}-${Date.now()}${extension}`);
        } catch {
          // Target does not exist yet.
        }
        await writeFile(target, payload.bytes ?? payload);
        this.closePalette();
        this.setStatus(t("info.fileSaved", { target }), "success");
      } catch (error) {
        if (this.state.palette === palette) {
          palette.searching = false;
          palette.error = errorText(error);
          this.touch();
        }
      }
    },

    async submitCommandPrompt(prompt, value) {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "prompt") return;
      if (typeof prompt.action === "string" && prompt.action.startsWith("settings-")) {
        await this.submitPreferencePrompt(prompt, value);
        return;
      }
      if (typeof prompt.action === "string" && prompt.action.startsWith("reminder-")) {
        await this.submitReminderPrompt(prompt, value);
        return;
      }
      if (typeof prompt.action === "string" && prompt.action.startsWith("room-")) {
        await this.submitRoomSettingsPrompt(prompt, value);
        return;
      }
      if (typeof prompt.action === "string" && prompt.action.startsWith("message-")) {
        await this.submitMessagePrompt(prompt, value);
        return;
      }
      const roomId = this.paletteRoomId(palette);
      if (!roomId) return;
      if (prompt.action === "announcement-name") {
        const name = String(value ?? "").trim();
        if (!name) {
          palette.error = t("info.announcementNameRequired");
          this.touch();
          return;
        }
        palette.prompt = { label: t("info.announcementContent", { name: sanitizeText(name) }), value: "", action: "announcement-content", data: { name } };
        palette.error = "";
        this.touch();
        return;
      }
      if (prompt.action === "announcement-content") {
        const name = prompt.data?.name;
        if (!name) return;
        palette.searching = true;
        this.touch();
        try {
          await this.api.saveAnnouncement(roomId, name, String(value ?? ""), this.sessionID);
          this.setStatus(t("info.announcementSaved", { name }), "success");
          await this.openAnnouncements();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
        return;
      }
      if (prompt.action === "question-answer") {
        const answer = String(value ?? "").trim();
        if (!answer) {
          palette.error = t("info.answerRequired");
          this.touch();
          return;
        }
        palette.searching = true;
        this.touch();
        try {
          await this.api.answerQuestion(roomId, prompt.data?.id, this.sessionID, answer);
          this.setStatus(t("info.answerPosted"), "success");
          await this.openQuestions();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
        return;
      }
      if (prompt.action === "file-upload") {
        const file = String(value ?? "").trim();
        const path = await import("node:path");
        if (!file || !path.isAbsolute(file)) {
          palette.error = t("info.filePathRequired");
          this.touch();
          return;
        }
        palette.searching = true;
        this.touch();
        try {
          const fs = await import("node:fs/promises");
          const info = await fs.stat(file);
          if (info.size > MAX_UPLOAD_BYTES) {
            palette.searching = false;
            palette.error = t("info.fileTooLarge");
            this.touch();
            return;
          }
          const bytes = new Uint8Array(await fs.readFile(file));
          await this.api.uploadResource(roomId, this.sessionID, path.basename(file), bytes);
          this.setStatus(t("info.fileUploaded", { name: path.basename(file) }), "success");
          await this.openFiles();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
      }
    },
  });
}