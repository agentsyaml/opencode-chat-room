import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../skills/chatroom/SKILL.md", import.meta.url));
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
