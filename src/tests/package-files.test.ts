import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

test("every server module is listed in the published files", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const files: string[] = JSON.parse(await Bun.file(path.join(root, "package.json")).text()).files;
  const shipped = (await readdir(path.join(root, "server"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:ts|js|webmanifest)$/.test(entry.name) && !entry.name.endsWith(".test.ts"))
    .map((entry) => `server/${entry.name}`);
  // A missing import here makes the published server fail to start, which no test loads.
  const missing = shipped.filter((file) => !files.some((entry) => entry === file || file.startsWith(`${entry}/`)));
  expect(missing).toEqual([]);
});

test("the center publishes its channeld sources without a runtime dependency", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const manifest = JSON.parse(await Bun.file(path.join(root, "package.json")).text()) as {
    files: string[];
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  expect(manifest.files).toContain("server/channels.ts");
  expect(manifest.files).toContain("packages/chat-room-channeld/src");
  expect(manifest.files).toContain("packages/chat-room-channeld/dist/mock-adapter.js");
  expect(manifest.files).toContain("packages/chat-room-channeld/dist/feishu-adapter.js");
  expect(manifest.scripts?.prepack).toContain("build:channeld-mock");
  expect(manifest.scripts?.prepack).toContain("build:channeld-feishu");
  expect(manifest.dependencies ?? {}).not.toHaveProperty("@alexsun-top/chat-room-channeld");
  const source = await Bun.file(path.join(root, "server/channels.ts")).text();
  // A bare specifier would become an undeclared runtime dependency.
  expect(source).toContain('from "../packages/chat-room-channeld/src/host.ts"');
  expect(source).not.toContain('from "@alexsun-top/chat-room-channeld');
});
