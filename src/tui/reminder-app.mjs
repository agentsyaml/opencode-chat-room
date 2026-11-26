// Reminder management on top of the shared palette overlay: list, create,
// pause/resume, edit text and delete. Schedule parsing stays pure in
// info-content.mjs so errors can be tested without a renderer.
import { parseReminderSchedule, reminderRows } from "./info-content.mjs";
import { sanitizeText } from "./messages.mjs";
import { t } from "./i18n.mjs";

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));
const reminderHint = () => t("reminder.hint");

function promptScheduleLabel() {
  return t("reminder.schedulePrompt");
}

export function attachReminders(Class) {
  Object.assign(Class.prototype, {
    openReminders() {
      return this.openInfo("reminders", t("reminder.title"), reminderHint(), async (room) =>
        reminderRows(await this.api.reminders(room.id, this.sessionID)));
    },

    reminderPalette() {
      const palette = this.state.palette;
      return palette?.mode === "info" && palette.kind === "reminders" ? palette : null;
    },

    reminderRoomId(palette) {
      return palette?.roomId || this.state.current?.id;
    },

    selectedReminder() {
      const palette = this.reminderPalette();
      return palette ? this.paletteItems()[palette.selected] : null;
    },

    startReminderCreate() {
      const palette = this.reminderPalette();
      if (!palette) return;
      palette.mode = "prompt";
      palette.error = "";
      palette.prompt = { label: t("reminder.textPrompt"), value: "", action: "reminder-text", data: {} };
      palette.hint = t("palette.enterNextHint");
      this.touch();
    },

    startReminderEdit() {
      const palette = this.reminderPalette();
      const reminder = this.selectedReminder();
      if (!palette || !reminder) return;
      palette.mode = "prompt";
      palette.error = "";
      palette.prompt = {
        label: t("reminder.textPrompt"),
        value: reminder.text,
        action: "reminder-edit-text",
        data: { id: reminder.value },
      };
      palette.hint = t("palette.enterSaveHint");
      this.touch();
    },

    async toggleReminder() {
      const palette = this.reminderPalette();
      const reminder = this.selectedReminder();
      const roomId = this.reminderRoomId(palette);
      if (!palette || !reminder || !roomId) return;
      palette.searching = true;
      palette.error = "";
      this.touch();
      try {
        await this.api.updateReminder(roomId, reminder.value, this.sessionID, { paused: !reminder.paused });
        this.setStatus(t(reminder.paused ? "reminder.resumed" : "reminder.paused"), "success");
        await this.openReminders();
      } catch (error) {
        if (this.state.palette === palette) {
          palette.searching = false;
          palette.error = errorText(error);
          this.touch();
        }
      }
    },

    askDeleteReminder() {
      const palette = this.reminderPalette();
      const reminder = this.selectedReminder();
      if (!palette || !reminder) return;
      palette.mode = "confirm";
      palette.error = "";
      palette.previous = { mode: "info", hint: palette.hint };
      palette.confirm = {
        text: t("reminder.deleteConfirm", { text: sanitizeText(reminder.text).slice(0, 50) }),
        action: "reminder-delete",
        data: { id: reminder.value },
      };
      palette.hint = t("palette.deleteHint");
      this.touch();
    },

    async submitReminderPrompt(prompt, value) {
      const palette = this.state.palette;
      const roomId = this.reminderRoomId(palette);
      if (!palette || palette.mode !== "prompt") return;
      if (!roomId) {
        palette.error = t("info.joinFirst");
        this.touch();
        return;
      }
      if (prompt.action === "reminder-text") {
        const text = String(value ?? "").trim();
        if (!text) {
          palette.error = t("reminder.textRequired");
          this.touch();
          return;
        }
        palette.prompt = {
          label: promptScheduleLabel(),
          value: "",
          action: "reminder-schedule",
          data: { text },
        };
        palette.hint = t("reminder.scheduleHint");
        palette.error = "";
        this.touch();
        return;
      }
      if (prompt.action === "reminder-schedule") {
        let schedule;
        try {
          schedule = parseReminderSchedule(value);
        } catch (error) {
          palette.error = errorText(error);
          this.touch();
          return;
        }
        palette.searching = true;
        palette.error = "";
        this.touch();
        try {
          await this.api.createReminder(roomId, this.sessionID, prompt.data.text, schedule);
          this.setStatus(t("reminder.created"), "success");
          await this.openReminders();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
        return;
      }
      if (prompt.action === "reminder-edit-text") {
        const text = String(value ?? "").trim();
        if (!text) {
          palette.error = t("reminder.textRequired");
          this.touch();
          return;
        }
        palette.searching = true;
        palette.error = "";
        this.touch();
        try {
          await this.api.updateReminder(roomId, prompt.data.id, this.sessionID, { text });
          this.setStatus(t("reminder.updated"), "success");
          await this.openReminders();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
      }
    },

    async runReminderConfirm(confirm) {
      const palette = this.state.palette;
      const roomId = this.reminderRoomId(palette);
      if (!palette || !roomId) return;
      palette.searching = true;
      this.touch();
      try {
        await this.api.deleteReminder(roomId, confirm.data.id, this.sessionID);
        this.setStatus(t("reminder.deleted"), "success");
        await this.openReminders();
      } catch (error) {
        if (this.state.palette === palette) {
          palette.searching = false;
          palette.error = errorText(error);
          this.touch();
        }
      }
    },
  });
}