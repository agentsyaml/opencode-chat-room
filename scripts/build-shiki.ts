// Builds the lazy Shiki bundle served at /assets/shiki.bundle.js.
// Run with: bun scripts/build-shiki.ts
import { build } from "bun";
import { stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const output = path.join(root, "server/assets/shiki.bundle.js");

const result = await build({
  entrypoints: [path.join(import.meta.dir, "shiki-entry.ts")],
  target: "browser",
  format: "esm",
  minify: true,
  outdir: path.dirname(output),
  naming: path.basename(output),
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const { size } = await stat(output);
console.log(`${path.relative(root, output)}: ${(size / 1024).toFixed(0)} KB (${(size / 1024 / 1024).toFixed(2)} MiB)`);