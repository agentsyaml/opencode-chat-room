// Reminder management on top of the shared palette overlay: list, create,
// pause/resume, edit text and delete. Schedule parsing stays pure in
// info-content.mjs so errors can be tested without a renderer.
import { parseReminderSchedule, reminderRows } from "./info-content.mjs";
import { sanitizeText } from "./messages.mjs";

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));
export const REMINDER_HINT = "n new · p pause/resume · e edit · d delete · Esc close";

function promptScheduleLabel() {
  return 'Schedule: once 2026-11-23T09:00 or cron 0 9 * * *';
}

export function attachReminders(Class) {
  Object.assign(Class.prototype, {
    openReminders() {
      return this.openInfo("reminders", "Reminders", REMINDER_HINT, async (room) =>
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
      palette.prompt = { label: "Reminder text", value: "", action: "reminder-text", data: {} };
      palette.hint = "Enter next · Esc cancel";
      this.touch();
    },

    startReminderEdit() {
      const palette = this.reminderPalette();
      const reminder = this.selectedReminder();
      if (!palette || !reminder) return;
      palette.mode = "prompt";
      palette.error = "";
      palette.prompt = {
        label: "Reminder text",
        value: reminder.text,
        action: "reminder-edit-text",
        data: { id: reminder.value },
      };
      palette.hint = "Enter save · Esc cancel";
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
        this.setStatus(`${reminder.paused ? "resumed" : "paused"} reminder`, "success");
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
        text: `Delete reminder "${sanitizeText(reminder.text).slice(0, 50)}"?`,
        action: "reminder-delete",
        data: { id: reminder.value },
      };
      palette.hint = "Enter or y deletes · n or Esc cancels";
      this.touch();
    },

    async submitReminderPrompt(prompt, value) {
      const palette = this.state.palette;
      const roomId = this.reminderRoomId(palette);
      if (!palette || palette.mode !== "prompt") return;
      if (!roomId) {
        palette.error = "open a joined room first";
        this.touch();
        return;
      }
      if (prompt.action === "reminder-text") {
        const text = String(value ?? "").trim();
        if (!text) {
          palette.error = "reminder text is required";
          this.touch();
          return;
        }
        palette.prompt = {
          label: promptScheduleLabel(),
          value: "",
          action: "reminder-schedule",
          data: { text },
        };
        palette.hint = "once ISO datetime or cron 5 fields · Enter create";
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
          this.setStatus("reminder created", "success");
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
          palette.error = "reminder text is required";
          this.touch();
          return;
        }
        palette.searching = true;
        palette.error = "";
        this.touch();
        try {
          await this.api.updateReminder(roomId, prompt.data.id, this.sessionID, { text });
          this.setStatus("reminder updated", "success");
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
        this.setStatus("reminder deleted", "success");
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