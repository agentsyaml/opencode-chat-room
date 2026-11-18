import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const chatDir = path.join(import.meta.dir, "../../server/assets/chat");

test("chat assets never call native confirm, alert, or prompt", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(chatDir).filter((file) => file.endsWith(".js"))) {
    // prompts are named `prompt` in a few call sites; only the browser prompt() is forbidden.
    const source = readFileSync(path.join(chatDir, name), "utf8").replaceAll("prompt.prompt()", "");
    if (/\b(?:confirm|alert|prompt)\s*\(/.test(source)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});