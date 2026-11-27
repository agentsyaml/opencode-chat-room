import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertEchartsLicense, collectLicenseFiles, licenseRank } from "../../scripts/office-licenses.ts";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "office-licenses-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("licenses outrank notices regardless of directory order", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "NOTICE"), "notice");
  await writeFile(path.join(root, "LICENSE"), "Apache License");
  await mkdir(path.join(root, "licenses"));
  await writeFile(path.join(root, "licenses", "LICENSE-d3"), "third party license");

  expect(licenseRank("LICENSE")).toBe(0);
  expect(licenseRank("NOTICE")).toBe(99);

  const files = await collectLicenseFiles(root);
  expect(files.map((file) => path.relative(root, file))).toEqual([
    "LICENSE",
    path.join("licenses", "LICENSE-d3"),
    "NOTICE",
  ]);
});

test("the echarts notice is rejected as an Apache license", () => {
  const notice = "node_modules/echarts/NOTICE\n".padEnd(168, " ");
  expect(() => assertEchartsLicense(notice)).toThrow("Apache License");
  expect(() => assertEchartsLicense("Apache License\nVersion 2.0\n".padEnd(11_000, " "))).not.toThrow();
});