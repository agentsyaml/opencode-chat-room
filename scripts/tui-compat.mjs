// Cross-runtime smoke check: imports the shared modules and exercises only
// pure paths, so Node, Bun and Deno run it without network access.
import { resolveTuiConfig } from "../src/tui/config.mjs";
import { loadSession, saveSession } from "../src/tui/session.mjs";
import { ApiError, createApi } from "../src/tui/http.mjs";

const runtime = globalThis.Deno ? "deno" : globalThis.Bun ? "bun" : "node";
const config = resolveTuiConfig({
  HOME: process.env.HOME || "/tmp",
  XDG_CONFIG_HOME: "/nonexistent/chatroom-config",
  XDG_STATE_HOME: "/nonexistent/chatroom-state",
  CHAT_ROOM_SERVER_URL: "http://127.0.0.1:1",
  CHAT_ROOM_SERVER_TOKEN: "compat-token",
  CHAT_ROOM_TUI_NAME: "compat",
}, process.cwd());
const api = createApi(config);

if (config.url !== "http://127.0.0.1:1" || config.participant !== "compat") {
  throw new Error("config resolution failed");
}
if (typeof api.poll !== "function" || typeof loadSession !== "function" || typeof saveSession !== "function") {
  throw new Error("missing exports");
}
const error = new ApiError("boom", 500);
if (!(error instanceof Error) || error.status !== 500) throw new Error("ApiError is broken");
if (runtime === "bun") {
  const opentui = await import("@opentui/core");
  if (typeof opentui.createCliRenderer !== "function") throw new Error("OpenTUI native core did not load");
}

console.log(JSON.stringify({ ok: true, runtime }));