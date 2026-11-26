// ponytail: central chat-room server. One HTTP service holding the
// authoritative room database (SQLite by default, PostgreSQL optional);
// plugins (central mode) talk to it via CHAT_ROOM_SERVER_URL. Optional bearer
// token (CHAT_ROOM_SERVER_TOKEN).
import { startServer } from "../src/platform/http-server.ts";
import { createApp } from "./app.ts";
import type { ChannelController } from "./channels.ts";
import { startRoomReminderScheduler } from "./room-reminders.ts";
import { loadServerBootstrap, startChannelLifecycle } from "./startup.ts";
import { wakeMentionedSessions } from "./wake.ts";

const bootstrap = await loadServerBootstrap();
// Set before the request handler runs; the controller reads its runtime lazily.
let channels: ChannelController | undefined;
const handle = createApp({
  here: bootstrap.here,
  token: bootstrap.token,
  serveWakeUrl: bootstrap.serveWakeUrl,
  channeld: () => channels,
});
const config = {
  hostname: bootstrap.hostname,
  port: bootstrap.port,
  fetch: handle,
  idleTimeout: 60,
  maxRequestBodySize: bootstrap.maxRequestBodySize,
};
export default config;

// A missing Channel D config aborts startup; a failed adapter start only logs
// and leaves the forward routes absent. Signal shutdown drains channels first.
await startChannelLifecycle(bootstrap.settings, (controller) => {
  channels = controller;
});

// Bun auto-serves the default export when this file is the entrypoint. Node and
// Deno have no such convention, so they start the shared adapter explicitly.
if (import.meta.main && typeof Bun === "undefined") await startServer(config);

console.log(
  `chat-room center listening on http://${bootstrap.displayHostname}:${bootstrap.port}${bootstrap.token ? " (token auth on)" : ""}`,
);
startRoomReminderScheduler((roomId, roomName, text, message) => wakeMentionedSessions(bootstrap.serveWakeUrl, roomId, roomName, text, "", message));
if (!bootstrap.token) {
  console.warn(
    "chat-room center has NO token auth — set CHAT_ROOM_SERVER_TOKEN if this port is reachable from other hosts",
  );
}