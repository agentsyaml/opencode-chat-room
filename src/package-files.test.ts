import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

test("every server module is listed in the published files", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const files: string[] = JSON.parse(await Bun.file(path.join(root, "package.json")).text()).files;
  const shipped = (await readdir(path.join(root, "server"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => `server/${entry.name}`);
  // A missing import here makes the published server fail to start, which no test loads.
  const missing = shipped.filter((file) => !files.some((entry) => entry === file || file.startsWith(`${entry}/`)));
  expect(missing).toEqual([]);
});
