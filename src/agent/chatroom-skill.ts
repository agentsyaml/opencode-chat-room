import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Bundled into dist/cli.js the module sits one level shallower than in src/agent,
// so try both layouts instead of hard-coding a single relative path.
const candidates = [
  new URL("../../skills/chatroom/SKILL.md", import.meta.url),
  new URL("../skills/chatroom/SKILL.md", import.meta.url),
].map((url) => fileURLToPath(url));
const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
const source = readFileSync(path, "utf8");
const [, metadata = "", content = source] = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/) ?? [];
const description = metadata.match(/^description:\s*(.+)$/m)?.[1]?.trim();

export const chatroomSkill = {
  id: "chatroom",
  name: "chatroom",
  description,
  path,
  content,
};
