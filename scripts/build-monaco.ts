// Builds the self-hosted Monaco editor and its workers under server/assets/monaco.
// Run with: bun scripts/build-monaco.ts
import { build } from "bun";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "server/assets/monaco");
const monaco = path.join(root, "node_modules/monaco-editor");

async function compile(config: Parameters<typeof build>[0]) {
  const result = await build(config);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await compile({
  entrypoints: [path.join(root, "src/web/integration-rules.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
});

await compile({
  entrypoints: [
    path.join(root, "src/web/editor.worker.ts"),
    path.join(root, "src/web/json.worker.ts"),
  ],
  outdir: out,
  target: "browser",
  format: "iife",
  minify: true,
});

await copyFile(path.join(monaco, "LICENSE"), path.join(out, "LICENSE"));
await copyFile(path.join(monaco, "ThirdPartyNotices.txt"), path.join(out, "ThirdPartyNotices.txt"));

const required = ["integration-rules.js", "integration-rules.css", "editor.worker.js", "json.worker.js", "LICENSE"];
const files = (await readdir(out)).sort();
for (const file of required) {
  if (!files.includes(file)) {
    console.error(`Missing build output: ${file}`);
    process.exit(1);
  }
}

const quiet = process.argv.includes("--quiet");
const rows: Array<{ file: string; raw: number; gzip: number }> = [];
for (const file of files) {
  const full = path.join(out, file);
  const info = await stat(full);
  if (!info.isFile()) continue;
  const bytes = new Uint8Array(await Bun.file(full).arrayBuffer());
  rows.push({ file, raw: info.size, gzip: gzipSync(bytes).length });
}
if (!quiet) {
  const total = rows.reduce((sum, row) => sum + row.raw, 0);
  const gzipped = rows.reduce((sum, row) => sum + row.gzip, 0);
  for (const row of rows) {
    console.log(`${row.file}: ${(row.raw / 1024).toFixed(1)} KiB raw, ${(row.gzip / 1024).toFixed(1)} KiB gzip`);
  }
  console.log(`server/assets/monaco: ${(total / 1024 / 1024).toFixed(2)} MiB raw, ${(gzipped / 1024 / 1024).toFixed(2)} MiB gzip`);
}