// Message actions on top of the palette prompts: recall and reveal by id with
// confirmation, and a prompt-based reply flow that uses api.send's replyTo.
import { mergeMessages } from "./messages.mjs";
import { canonicalizeMentions } from "./mentions.mjs";
import { t } from "./i18n.mjs";

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));

export function attachMessageActions(Class) {
  Object.assign(Class.prototype, {
    messageActionPalette(title, label, action, data = {}) {
      const palette = this.state.palette;
      if (!palette || !this.state.current || !this.state.joined) {
        this.state.palette = null;
        this.setStatus(t("info.joinFirst"), "error");
        return null;
      }
      palette.mode = "prompt";
      palette.roomId = this.state.current.id;
      palette.roomParticipants = [...(this.state.current.participants || [])];
      palette.title = title;
      palette.subtitle = `#${this.state.current.name}`;
      palette.error = "";
      palette.prompt = { label, value: "", action, data };
      palette.hint = t("palette.enterNextHint");
      this.touch();
      return palette;
    },

    startMessageRecall() {
      return this.messageActionPalette(t("message.recallTitle"), t("message.recallPrompt"), "message-recall-id");
    },

    startMessageReveal() {
      return this.messageActionPalette(t("message.revealTitle"), t("message.revealPrompt"), "message-reveal-id");
    },

    startMessageReply() {
      return this.messageActionPalette(t("message.replyTitle"), t("message.replyPrompt"), "message-reply-id");
    },

    startAskQuestion() {
      return this.messageActionPalette(t("message.askTitle"), t("message.askPrompt"), "message-ask");
    },

    async submitMessagePrompt(prompt, value) {
      const palette = this.state.palette;
      const roomId = palette?.roomId || this.state.current?.id;
      const participants = palette?.roomParticipants || this.state.current?.participants;
      if (!palette || palette.mode !== "prompt") return;
      if (!roomId) {
        palette.error = t("info.joinFirst");
        this.touch();
        return;
      }
      if (prompt.action === "message-ask") {
        const question = canonicalizeMentions(String(value ?? "").trim(), participants);
        if (!question) {
          palette.error = t("message.questionRequired");
          this.touch();
          return;
        }
        palette.searching = true;
        palette.error = "";
        this.touch();
        try {
          const result = await this.api.send(roomId, this.sessionID, question, { isQuestion: true });
          if (Array.isArray(result?.messages)) mergeMessages(this.state.messages, result.messages);
          else if (result?.id) mergeMessages(this.state.messages, [result]);
          this.state.connection = "online";
          this.closePalette();
          this.setStatus(t("message.questionSent"), "success");
          this.markRead();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
        return;
      }
      const id = String(value ?? "").trim();
      if (!id) {
        palette.error = t("message.idRequired");
        this.touch();
        return;
      }
      if (prompt.action === "message-recall-id" || prompt.action === "message-reveal-id") {
        const recall = prompt.action === "message-recall-id";
        palette.mode = "confirm";
        palette.previous = { mode: "prompt", hint: palette.hint };
        palette.confirm = {
          text: recall ? t("message.recallConfirm", { id }) : t("message.revealConfirm", { id }),
          action: recall ? "message-recall" : "message-reveal",
          data: { id },
        };
        palette.hint = t("palette.confirmHint");
        palette.error = "";
        this.touch();
        return;
      }
      if (prompt.action === "message-reply-id") {
        palette.prompt = {
          label: t("message.replyLabel", { id }),
          value: "",
          action: "message-reply-text",
          data: { id },
        };
        palette.hint = t("message.replyHint");
        palette.error = "";
        this.touch();
        return;
      }
      if (prompt.action === "message-reply-text") {
        const text = canonicalizeMentions(String(value ?? "").trim(), participants);
        if (!text) {
          palette.error = t("message.replyRequired");
          this.touch();
          return;
        }
        palette.searching = true;
        palette.error = "";
        this.touch();
        try {
          const result = await this.api.send(roomId, this.sessionID, text, { replyToMessageID: prompt.data.id });
          if (!this.isCurrent(roomId)) return;
          if (Array.isArray(result?.messages)) mergeMessages(this.state.messages, result.messages);
          else if (result?.id) mergeMessages(this.state.messages, [result]);
          this.state.connection = "online";
          this.closePalette();
          this.setStatus(t("message.replySent"), "success");
          this.markRead();
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
      }
    },

    async runMessageConfirm(confirm) {
      const palette = this.state.palette;
      const roomId = palette?.roomId || this.state.current?.id;
      if (!palette || !roomId) return;
      const id = confirm.data.id;
      palette.searching = true;
      palette.error = "";
      this.touch();
      try {
        if (confirm.action === "message-recall") {
          await this.api.recall(roomId, id, this.sessionID);
          const target = this.state.messages.find((message) => message.id === id);
          if (target) target.recalledAt = Date.now();
          this.closePalette();
          this.setStatus(t("message.recalledStatus", { id }), "success");
          return;
        }
        const revealed = await this.api.reveal(roomId, id, this.sessionID);
        palette.mode = "detail";
        palette.title = t("message.revealed");
        palette.confirm = null;
        palette.detail = {
          title: t("message.revealed"),
          markdown: String(revealed?.text ?? t("message.empty")),
          kind: "revealed-message",
        };
        palette.hint = t("palette.closeHint");
        palette.searching = false;
        this.touch();
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