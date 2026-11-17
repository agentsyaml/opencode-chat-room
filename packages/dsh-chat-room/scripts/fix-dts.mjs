// TypeScript keeps source extensions in declaration emit even with
// rewriteRelativeImportExtensions; dist ships .js, so declarations must say .js.
import { readdir, readFile, writeFile } from "node:fs/promises";

const dir = new URL("../dist/", import.meta.url);
let changed = 0;
for (const name of await readdir(dir)) {
  if (!name.endsWith(".d.ts")) continue;
  const file = new URL(name, dir);
  const text = await readFile(file, "utf8");
  const next = text.replace(/(from\s+"\.{1,2}\/[^"]+)\.ts"/g, '$1.js"');
  if (next !== text) {
    await writeFile(file, next);
    changed++;
  }
}
console.log(`declaration specifiers rewritten: ${changed}`);