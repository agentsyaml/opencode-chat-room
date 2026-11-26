// Server startup: config resolution, environment publication, storage
// readiness and the Channel D lifecycle.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoomConfig, resolveServerSettings, type ServerSettings } from "../src/config/file-config.ts";
import { maxResourceBytes } from "../src/rooms/resources.ts";
import { resourceStorage } from "../src/rooms/storage.ts";
import { maxRoomTasks } from "../src/rooms/tasks.ts";
import { createChannelController, type ChannelController } from "./channels.ts";

export type ServerBootstrap = {
  settings: ServerSettings;
  here: string;
  hostname: string;
  displayHostname: string;
  port: number;
  token?: string;
  serveWakeUrl: string;
  maxRequestBodySize: number;
};

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid server port "${value}": expected an integer from 1 to 65535`,
    );
  }
  return port;
}

export async function loadServerBootstrap(): Promise<ServerBootstrap> {
  // The bundled CLI lives in dist/, while its published server files stay in server/.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const here = existsSync(path.join(moduleDir, "chat.html")) ? moduleDir : path.resolve(moduleDir, "../server");
  const settings = resolveServerSettings(loadRoomConfig());
  // A malformed limit stops startup instead of silently clamping.
  maxRoomTasks();
  const hostname = settings.host;
  const displayHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  const port = parsePort(settings.port);
  const token = settings.token;
  // The state directory and upload limit are read lazily from the environment;
  // publish the file values before the first database or upload call.
  if (!process.env.CHAT_ROOM_STATE_DIR && settings.stateDir) process.env.CHAT_ROOM_STATE_DIR = settings.stateDir;
  if (!process.env.CHAT_ROOM_MAX_FILE_SIZE_MB && settings.maxFileSizeMb !== undefined) {
    process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = String(settings.maxFileSizeMb);
  }
  // Storage validation and the S3 HeadBucket check run before the server listens.
  // A bucket, credential, or network failure stops startup; there is no local fallback.
  await resourceStorage().ready();
  // Deployment-configured wake URL: an @mention wakes an exited session
  // immediately (no polling delay). Without it the plugin timer is the fallback.
  // This is explicit configuration, not a guess that OpenCode exists.
  return {
    settings,
    here,
    hostname,
    displayHostname,
    port,
    token,
    serveWakeUrl: settings.wakeServeUrl,
    maxRequestBodySize: Math.max(128 * 1024 * 1024, maxResourceBytes()),
  };
}

// Channel D is opt-in. A missing config aborts startup; a failed adapter start
// only logs and leaves the forward routes absent. Admin routes can swap the
// runtime later without restarting the main server.
export async function startChannelLifecycle(
  settings: ServerSettings,
  assign: (controller: ChannelController) => void,
): Promise<void> {
  const channelController = createChannelController(settings);
  assign(channelController);
  await channelController.start();
  let stopping: Promise<void> | undefined;
  const stopChannelsNow = () => {
    stopping ??= channelController.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", stopChannelsNow);
  process.once("SIGTERM", stopChannelsNow);
}