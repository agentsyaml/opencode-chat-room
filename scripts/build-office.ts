// Builds the lazy Office preview bundles under server/assets/office.
// Run with: bun scripts/build-office.ts [--quiet]
import { build } from "bun";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "server/assets/office");
const viewer = path.join(root, "src/web/office-viewer.ts");
const cache = path.join(root, "node_modules/.cache/office-build");
const quiet = process.argv.includes("--quiet");
const entries = { docx: "renderDocx", xlsx: "renderXlsx", pptx: "renderPptx" };
type Meta = { inputs: Record<string, unknown> };

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await rm(cache, { recursive: true, force: true });
await mkdir(cache, { recursive: true });

try {
  for (const [kind, name] of Object.entries(entries)) {
    await writeFile(path.join(cache, `${kind}.ts`), `export { ${name} as render } from ${JSON.stringify(viewer)};\n`);
  }
  // Build each entry alone: one multi-entry Bun build disables tree shaking here
  // and gives every bundle all three libraries.
  const metas: Meta[] = [];
  for (const kind of Object.keys(entries)) {
    const result = await build({
      entrypoints: [path.join(cache, `${kind}.ts`)],
      outdir: out,
      naming: `${kind}.bundle.js`,
      target: "browser",
      format: "esm",
      minify: true,
      splitting: false,
      define: { "process.env.NODE_ENV": '"production"' },
      metafile: true,
    });
    if (!result.success || !result.metafile) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Office bundle build failed: ${kind}`);
    }
    metas.push(result.metafile as Meta);
  }

  const packages = new Set<string>();
  for (const meta of metas) {
    for (const input of Object.keys(meta.inputs)) {
      const match = /node_modules[/\\](?!\.)((?:@[^/\\]+[/\\])?[^/\\]+)[/\\]/.exec(input);
      if (match?.[1]) packages.add(match[1].replaceAll("\\", "/"));
    }
  }
  const licenses = path.join(out, "licenses");
  await mkdir(licenses, { recursive: true });
  const notice = ["Third-party packages bundled into the Office previews.", ""];
  for (const name of [...packages].sort()) {
    const dir = path.join(root, "node_modules", name);
    const info = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { version?: string; license?: string };
    const files = await readdir(dir).catch(() => []);
    const licenseFile = files.find((file) => /^(licen[cs]e|copying|notice)/i.test(file));
    const target = path.join(licenses, `${name.replace("/", "-")}-LICENSE.txt`);
    if (licenseFile) await copyFile(path.join(dir, licenseFile), target);
    else if (name === "pptx-preview") await copyFile(path.join(root, "scripts/office-licenses/pptx-preview-LICENSE.txt"), target);
    else await writeFile(target, `${name} ${info.version}\nLicense: ${info.license || "see package metadata"}\n`);
    const label = name === "pptx-preview" ? "ISC declared; upstream custom terms" : info.license || "unknown";
    notice.push(`${name} ${info.version} (${label}) -> licenses/${path.basename(target)}`);
  }
  await writeFile(path.join(out, "THIRD-PARTY-NOTICES.txt"), `${notice.join("\n")}\n`);

  const files = (await readdir(out)).filter((file) => file.endsWith(".bundle.js")).sort();
  if (files.length !== 3) throw new Error(`Expected 3 bundles, found ${files.length}.`);
  if (!quiet) {
    for (const file of files) {
      const { size } = await stat(path.join(out, file));
      console.log(`${file}: ${(size / 1024).toFixed(1)} KiB`);
    }
  }
} finally {
  await rm(cache, { recursive: true, force: true });
}