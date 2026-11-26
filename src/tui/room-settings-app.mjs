// Room settings over the shared detail overlay. Reads the room payload and
// member list, shows owner/admin/successor/management-agent roles, and applies
// name, description and join-policy patches through api.updateRoom.
import { roomSettingsMarkdown } from "./info-content.mjs";
import { createInfoPalette } from "./info-app.mjs";
import { t } from "./i18n.mjs";

const errorText = (error) => (error instanceof Error ? error.message : String(error ?? "unknown error"));

export function attachRoomSettings(Class) {
  Object.assign(Class.prototype, {
    async openRoomSettings() {
      const current = this.state.current;
      if (!current || !this.state.joined) {
        this.state.palette = null;
        this.setStatus(t("info.joinFirst"), "error");
        return;
      }
      this.roomSettings = null;
      const palette = {
        ...createInfoPalette("room-settings", t("room.title"), `#${current.name}`),
        mode: "detail",
        detail: { title: t("room.title"), markdown: t("common.loading"), kind: "room-settings" },
        hint: t("palette.detailHint"),
      };
      this.state.palette = palette;
      this.touch();
      try {
        const [room, members] = await Promise.all([
          this.api.getRoom(current.id),
          this.api.members(current.id).catch(() => []),
        ]);
        if (this.state.palette !== palette) return;
        const owner = room.ownerId === this.participant;
        const admin = owner || (room.adminIds ?? []).includes(this.participant);
        const canEdit = Boolean(admin) && typeof this.api.updateRoom === "function";
        const canDelete = owner && typeof this.api.deleteRoom === "function";
        const agent = (members ?? []).find((member) => member.sessionID === room.adminSessionID);
        this.roomSettings = { room, canEdit, canDelete };
        palette.roomMeta = room;
        palette.detail = {
          title: t("room.title"),
          markdown: roomSettingsMarkdown(room, {
            participant: this.participant,
            sessionID: this.sessionID,
            canEdit,
            agentName: agent ? `${agent.name} (agent)` : "",
          }),
          kind: "room-settings",
        };
        palette.hint = canEdit ? t("room.editHint") : t("room.readOnlyHint");
        if (canDelete) {
          palette.hint = canEdit ? t("room.editDeleteHint") : t("room.deleteOnlyHint");
        }
        palette.error = "";
        this.touch();
      } catch (error) {
        if (this.state.palette !== palette) return;
        this.roomSettings = null;
        palette.detail = {
          title: t("room.title"),
          markdown: `${t("room.loadFailed")}\n\n${errorText(error)}`,
          kind: "room-settings",
        };
        palette.error = errorText(error);
        palette.hint = t("room.readOnlyHint");
        this.touch();
      }
    },

    roomSettingsGuard() {
      const palette = this.state.palette;
      const settings = this.roomSettings;
      if (
        palette?.kind !== "room-settings"
        || !settings?.canEdit
        || settings.room.id !== this.state.current?.id
      ) {
        if (palette) {
          palette.error = t("room.guardEdit");
          this.touch();
        }
        return null;
      }
      return settings;
    },

    startRoomRename() {
      const settings = this.roomSettingsGuard();
      const palette = this.state.palette;
      if (!settings || !palette) return;
      palette.mode = "prompt";
      palette.prompt = { label: t("room.namePrompt"), value: settings.room.name, action: "room-name", data: {} };
      palette.error = "";
      palette.hint = t("palette.enterSaveHint");
      this.touch();
    },

    startRoomDescription() {
      const settings = this.roomSettingsGuard();
      const palette = this.state.palette;
      if (!settings || !palette) return;
      palette.mode = "prompt";
      palette.prompt = {
        label: t("room.descriptionPrompt"),
        value: settings.room.description ?? "",
        action: "room-description",
        data: {},
      };
      palette.error = "";
      palette.hint = t("room.descriptionHint");
      this.touch();
    },

    askRoomJoinPolicy() {
      const settings = this.roomSettingsGuard();
      const palette = this.state.palette;
      if (!settings || !palette) return;
      const next = settings.room.joinPolicy === "approval" ? "open" : "approval";
      palette.mode = "confirm";
      palette.previous = { mode: "detail", hint: palette.hint };
      palette.confirm = {
        text: t("room.policyConfirm", { policy: next }),
        action: "room-join-policy",
        data: { joinPolicy: next },
      };
      palette.error = "";
      palette.hint = t("room.policyHint");
      this.touch();
    },

    askDeleteRoom() {
      const settings = this.roomSettings;
      const palette = this.state.palette;
      const current = this.state.current?.id;
      if (
        !settings?.canDelete
        || !palette
        || settings.room.id !== current
        || palette.kind !== "room-settings"
      ) {
        if (palette) {
          palette.error = t("room.guardDelete");
          this.touch();
        }
        return;
      }
      palette.mode = "confirm";
      palette.previous = { mode: "detail", hint: palette.hint };
      palette.confirm = {
        text: t("room.deleteConfirm", { name: settings.room.name }),
        action: "room-delete",
        data: { id: settings.room.id, name: settings.room.name },
      };
      palette.error = "";
      palette.hint = t("palette.deleteHint");
      this.touch();
    },

    async submitRoomSettingsPrompt(prompt, value) {
      const settings = this.roomSettingsGuard();
      const palette = this.state.palette;
      if (!settings || !palette) return;
      if (prompt.action === "room-name") {
        const name = String(value ?? "").trim();
        if (!name || Array.from(name).length > 64) {
          palette.error = t("room.nameInvalid");
          this.touch();
          return;
        }
        await this.applyRoomPatch({ name }, t("room.renamed", { name }));
        return;
      }
      if (prompt.action === "room-description") {
        const description = String(value ?? "").trim();
        if (Array.from(description).length > 2000) {
          palette.error = t("room.descriptionInvalid");
          this.touch();
          return;
        }
        await this.applyRoomPatch({ description }, t("room.descriptionUpdated"));
      }
    },

    async applyRoomPatch(patch, status) {
      const settings = this.roomSettingsGuard();
      const palette = this.state.palette;
      if (!settings || !palette) return;
      palette.searching = true;
      palette.error = "";
      this.touch();
      try {
        const result = await this.api.updateRoom(settings.room.id, this.sessionID, patch);
        if (patch.name) {
          const name = String(result?.name ?? patch.name);
          this.state.current.name = name;
          const summary = this.state.rooms.find((item) => item.id === settings.room.id);
          if (summary) summary.name = name;
        }
        this.setStatus(status, "success");
        await this.openRoomSettings();
      } catch (error) {
        if (this.state.palette === palette) {
          palette.searching = false;
          palette.error = errorText(error);
          this.touch();
        }
      }
    },

    async runRoomSettingsConfirm(confirm) {
      if (confirm.action === "room-delete") {
        const palette = this.state.palette;
        const settings = this.roomSettings;
        if (
          !palette
          || !settings?.canDelete
          || settings.room.id !== this.state.current?.id
          || settings.room.id !== confirm.data.id
        ) return;
        palette.searching = true;
        palette.error = "";
        this.touch();
        try {
          await this.api.deleteRoom(confirm.data.id, this.sessionID);
          this.stopPolling();
          this.state.rooms = this.state.rooms.filter((room) => room.id !== confirm.data.id);
          this.state.current = null;
          this.state.joined = false;
          this.state.messages = [];
          this.state.pending = null;
          this.state.selected = Math.min(this.state.selected, Math.max(0, this.state.rooms.length - 1));
          this.closePalette();
          this.setStatus(t("room.deleted", { name: confirm.data.name }), "success");
        } catch (error) {
          if (this.state.palette === palette) {
            palette.searching = false;
            palette.error = errorText(error);
            this.touch();
          }
        }
        return;
      }
      if (confirm.action !== "room-join-policy") return;
      await this.applyRoomPatch(
        { joinPolicy: confirm.data.joinPolicy },
        t("room.policySet", { policy: confirm.data.joinPolicy }),
      );
    },
  });
}