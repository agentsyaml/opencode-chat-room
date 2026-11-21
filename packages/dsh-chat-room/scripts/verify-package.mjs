// Verify the package the way a consumer receives it: pack list, clean temp copy,
// Node import through package exports. Run after `bun run build`.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
if (manifest.private === true) throw new Error("package must be publishable");
if (manifest.main !== "./dist/index.js") throw new Error(`unexpected main: ${manifest.main}`);
if (manifest.exports?.["."]?.default !== "./dist/index.js") throw new Error("exports must point at dist/index.js");

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: pkgDir,
  encoding: "utf8",
}))[0];
const files = packed.files.map((file) => file.path);
for (const required of ["dist/index.js", "dist/index.d.ts", "cordis.patch.yml", "package.json"]) {
  if (!files.includes(required)) throw new Error(`packed files miss ${required}`);
}

const dir = await mkdtemp(path.join(tmpdir(), "dsh-chat-room-verify-"));
try {
  const installed = path.join(dir, "node_modules", "@alexsun-top", "dsh-chat-room");
  for (const file of files) {
    const target = path.join(installed, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(pkgDir, file), target);
  }
  // The copy has no install step: supply declared runtime dependencies from this repo.
  const require = createRequire(import.meta.url);
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    const target = path.join(dir, "node_modules", dep);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.dirname(require.resolve(`${dep}/package.json`)), target, { recursive: true });
  }
  const script = `
const m = await import('@alexsun-top/dsh-chat-room');
if (typeof m.apply !== 'function') throw new Error('apply export missing');
if (m.name !== 'dsh-chat-room') throw new Error('plugin name mismatch');
if (!m.ROOM_ACTIONS.includes('join')) throw new Error('room actions missing');
const cfg = m.resolveConfig({ url: 'http://127.0.0.1:4399', token: 't' });
const tool = m.createRoomTool(cfg, new Set());
if (tool.name !== 'room' || tool.parameters.type !== 'object') throw new Error('tool shape wrong');
if (typeof tool.execute !== 'function') throw new Error('tool execute missing');
console.log(JSON.stringify({ import: 'ok', name: m.name, actions: m.ROOM_ACTIONS.length, tool: tool.name }));
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, encoding: "utf8" });
  process.stdout.write(output);
  console.log(`verified ${files.length} packed files in ${dir}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}