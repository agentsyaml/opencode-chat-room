// Pending join-request review for the current room. Reuses the info/confirm
// overlay and maps 403s to the server's reviewer rule in plain language.
import { joinRequestRows } from "./info-content.mjs";

const ADMIN_ERROR = "only a human administrator or the designated management agent may decide";
const REVIEW_HINT = "Enter approve · d deny · Esc close";
const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));

export function attachJoinRequests(Class) {
  Object.assign(Class.prototype, {
    openJoinRequests() {
      return this.openInfo("join-requests", "Join requests", REVIEW_HINT, async (room) => {
        try {
          const result = await this.api.joinRequests(room.id, this.sessionID);
          return joinRequestRows(result.requests);
        } catch (error) {
          if (error?.status === 403) throw new Error(ADMIN_ERROR);
          throw error;
        }
      });
    },

    selectedJoinRequest() {
      const palette = this.state.palette;
      if (!palette || palette.mode !== "info" || palette.kind !== "join-requests") return null;
      return this.paletteItems()[palette.selected] ?? null;
    },

    askJoinDecision(decision) {
      const palette = this.state.palette;
      const request = this.selectedJoinRequest();
      if (!palette || !request) return;
      const name = request.request?.name || request.request?.participantId || request.value;
      palette.mode = "confirm";
      palette.previous = { mode: "info", hint: palette.hint };
      palette.confirm = {
        text: `${decision === "approve" ? "Approve" : "Deny"} "${name}"?`,
        action: `join-${decision}`,
        data: { sessionID: request.value, name },
      };
      palette.error = "";
      palette.hint = "Enter or y confirms · n or Esc cancels";
      this.touch();
    },

    async runJoinConfirm(confirm) {
      const palette = this.state.palette;
      const roomId = palette?.roomId || this.state.current?.id;
      if (!palette || !roomId) return;
      const decision = confirm.action === "join-approve" ? "approve" : "deny";
      palette.searching = true;
      palette.error = "";
      this.touch();
      try {
        await this.api.decideJoin(roomId, confirm.data.sessionID, this.sessionID, decision);
        this.setStatus(`${decision === "approve" ? "approved" : "denied"} ${confirm.data.name}`, "success");
        await this.openJoinRequests();
      } catch (error) {
        if (this.state.palette === palette) {
          palette.mode = "info";
          palette.confirm = null;
          palette.previous = null;
          palette.searching = false;
          palette.hint = REVIEW_HINT;
          palette.error = error?.status === 403 ? ADMIN_ERROR : errorText(error);
          this.touch();
        }
      }
    },
  });
}