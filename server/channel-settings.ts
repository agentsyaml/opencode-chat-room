// Admin-side Channel D helpers: response sanitization, optional room-config
// persistence, and control-request body parsing. These stay out of the relay
// route file so a failed admin request can never leak adapter details.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { findRoomConfigFile } from "../src/config/file-config.ts";

export type ChannelSettingsPatch = { enabled: boolean; config?: string };

/** Admin responses never echo credentials or the feature's internal name. */
export function adminMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const clean = message
    .replace(/channeld/gi, "relay")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(secret|token|password|passwd|authorization|api[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 300);
  return clean || "relay request failed";
}

/** Best effort: rewrite channel settings in an existing JSON room config. */
export async function persistRoomSettings(
  env: NodeJS.ProcessEnv,
  next: ChannelSettingsPatch,
): Promise<boolean> {
  try {
    const file = findRoomConfigFile(env);
    const extension = file ? path.extname(file).toLowerCase() : "";
    if (!file || !(extension === ".json" || extension === ".yaml" || extension === ".yml")) return false;
    const text = readFileSync(file, "utf8");
    const parsed: unknown = extension === ".json" ? JSON.parse(text) : parseYaml(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const root = parsed as Record<string, unknown>;
    const server = root.server && typeof root.server === "object" && !Array.isArray(root.server)
      ? root.server as Record<string, unknown>
      : {};
    const current = server.channeld && typeof server.channeld === "object" && !Array.isArray(server.channeld)
      ? server.channeld as Record<string, unknown>
      : {};
    const channeld: Record<string, unknown> = { ...current, enabled: next.enabled };
    if (next.config !== undefined) channeld.config = next.config;
    server.channeld = channeld;
    root.server = server;
    writeFileSync(file, extension === ".json" ? `${JSON.stringify(root, null, 2)}\n` : stringifyYaml(root));
    return true;
  } catch {
    return false;
  }
}

export async function readAdminBody(
  req: Request,
): Promise<{ ok: true; config?: string } | { ok: false }> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > 64 * 1024) return { ok: false };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false };
  }
  if (text.length > 64 * 1024) return { ok: false };
  if (!text.trim()) return { ok: true };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    const config = (value as Record<string, unknown>).config;
    if (config === undefined) return { ok: true };
    if (typeof config !== "string" || !config.trim()) return { ok: false };
    return { ok: true, config: config.trim() };
  } catch {
    return { ok: false };
  }
}