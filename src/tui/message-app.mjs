// Message actions on top of the palette prompts: recall and reveal by id with
// confirmation, and a prompt-based reply flow that uses api.send's replyTo.
import { mergeMessages } from "./messages.mjs";
import { canonicalizeMentions } from "./mentions.mjs";

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));

export function attachMessageActions(Class) {
  Object.assign(Class.prototype, {
    messageActionPalette(title, label, action, data = {}) {
      const palette = this.state.palette;
      if (!palette || !this.state.current || !this.state.joined) {
        this.state.palette = null;
        this.setStatus("open a joined room first", "error");
        return null;
      }
      palette.mode = "prompt";
      palette.roomId = this.state.current.id;
      palette.roomParticipants = [...(this.state.current.participants || [])];
      palette.title = title;
      palette.subtitle = `#${this.state.current.name}`;
      palette.error = "";
      palette.prompt = { label, value: "", action, data };
      palette.hint = "Enter next · Esc cancel";
      this.touch();
      return palette;
    },

    startMessageRecall() {
      return this.messageActionPalette("Recall message", "Message ID to recall", "message-recall-id");
    },

    startMessageReveal() {
      return this.messageActionPalette("Reveal message", "Message ID to reveal", "message-reveal-id");
    },

    startMessageReply() {
      return this.messageActionPalette("Reply", "Message ID to reply to", "message-reply-id");
    },

    startAskQuestion() {
      return this.messageActionPalette("Ask question", "Question text", "message-ask");
    },

    async submitMessagePrompt(prompt, value) {
      const palette = this.state.palette;
      const roomId = palette?.roomId || this.state.current?.id;
      const participants = palette?.roomParticipants || this.state.current?.participants;
      if (!palette || palette.mode !== "prompt") return;
      if (!roomId) {
        palette.error = "open a joined room first";
        this.touch();
        return;
      }
      if (prompt.action === "message-ask") {
        const question = canonicalizeMentions(String(value ?? "").trim(), participants);
        if (!question) {
          palette.error = "question text is required";
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
          this.setStatus("question sent", "success");
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
        palette.error = "message ID is required";
        this.touch();
        return;
      }
      if (prompt.action === "message-recall-id" || prompt.action === "message-reveal-id") {
        const recall = prompt.action === "message-recall-id";
        palette.mode = "confirm";
        palette.previous = { mode: "prompt", hint: palette.hint };
        palette.confirm = {
          text: recall ? `Recall message "${id}"?` : `Reveal the original text of "${id}"?`,
          action: recall ? "message-recall" : "message-reveal",
          data: { id },
        };
        palette.hint = "Enter or y confirms · n or Esc cancels";
        palette.error = "";
        this.touch();
        return;
      }
      if (prompt.action === "message-reply-id") {
        palette.prompt = {
          label: `Reply to ${id}`,
          value: "",
          action: "message-reply-text",
          data: { id },
        };
        palette.hint = "Enter send · Esc cancel";
        palette.error = "";
        this.touch();
        return;
      }
      if (prompt.action === "message-reply-text") {
        const text = canonicalizeMentions(String(value ?? "").trim(), participants);
        if (!text) {
          palette.error = "reply text is required";
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
          this.setStatus("reply sent", "success");
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
          this.setStatus(`recalled ${id}`, "success");
          return;
        }
        const revealed = await this.api.reveal(roomId, id, this.sessionID);
        palette.mode = "detail";
        palette.title = "Revealed message";
        palette.confirm = null;
        palette.detail = {
          title: "Revealed message",
          markdown: String(revealed?.text ?? "(empty)"),
          kind: "revealed-message",
        };
        palette.hint = "Esc close";
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