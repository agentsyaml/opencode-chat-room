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

test("the Monaco editor assets ship with their license", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const manifest = JSON.parse(await Bun.file(path.join(root, "package.json")).text()) as {
    files: string[];
    scripts?: Record<string, string>;
  };
  expect(manifest.files).toContain("server/assets");
  expect(manifest.scripts?.prepack).toContain("scripts/build-monaco.ts --quiet");
  for (const file of ["integration-rules.js", "integration-rules.css", "editor.worker.js", "json.worker.js", "LICENSE", "ThirdPartyNotices.txt"]) {
    expect(await Bun.file(path.join(root, "server/assets/monaco", file)).exists()).toBe(true);
  }
  expect(await Bun.file(path.join(root, "server/assets/monaco/LICENSE")).text()).toContain("MIT License");
});

test("the server package lists channel runtime modules", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const manifest = JSON.parse(await Bun.file(path.join(root, "package.json")).text()) as {
    files: string[];
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  expect(manifest.files).toContain("server/channels.ts");
  expect(manifest.files).toContain("server/assets");
  expect(manifest.scripts?.prepack).toContain("scripts/build-monaco.ts --quiet");
  expect(manifest.files).toContain("packages/chat-room-channeld/src");
  expect(manifest.files).toContain("packages/chat-room-channeld/dist/mock-adapter.js");
  expect(manifest.files?.some((entry) => entry.startsWith("plugins/"))).toBe(false);
  expect(manifest.files).not.toContain("plugins/feishu/dist/feishu-adapter.js");
  expect(manifest.files).not.toContain("packages/chat-room-channeld/dist/feishu-adapter.js");
  expect(manifest.files).not.toContain("packages/chat-room-channeld/dist/feishu-adapter.ts");
  expect(manifest.scripts?.prepack).toContain("build:channeld-mock");
  expect(manifest.scripts?.prepack).not.toContain("build:adapter-feishu");
  expect(manifest.scripts?.["build:adapter-feishu"]).toContain("scripts/build-feishu-adapter.ts");
  expect(manifest.scripts?.["build:adapter-feishu"]).not.toContain("bun build");
  expect(manifest.scripts?.prepack).not.toContain("build:channeld-feishu");
  expect(manifest.dependencies ?? {}).not.toHaveProperty("@alexsun-top/chat-room-channeld");
  expect(manifest.files.some((file) => file.includes("@alexsun-top/chat-room-adapter-feishu"))).toBe(false);
  expect(manifest.dependencies ?? {}).not.toHaveProperty("@alexsun-top/chat-room-adapter-feishu");
  const source = await Bun.file(path.join(root, "server/channels.ts")).text();
  // A bare specifier would become an undeclared runtime dependency.
  expect(source).toContain('from "../packages/chat-room-channeld/src/host.ts"');
  expect(source).not.toContain('from "@alexsun-top/chat-room-channeld');
});
