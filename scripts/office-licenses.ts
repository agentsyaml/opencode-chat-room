// License selection for the generated Office preview bundles.
// Kept separate so the Linux readdir-order regression is testable.
import { readdir } from "node:fs/promises";
import path from "node:path";

export function licenseRank(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "license" || lower === "licence") return 0;
  if (lower === "copying") return 1;
  if (/^licen[cs]e/.test(lower)) return 2;
  return 99;
}

export async function collectLicenseFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const licenses = entries
    .filter((entry) => entry.isFile() && licenseRank(entry.name) < 99)
    .sort((left, right) => licenseRank(left.name) - licenseRank(right.name) || left.name.localeCompare(right.name))
    .map((entry) => path.join(dir, entry.name));
  const notices = entries
    .filter((entry) => entry.isFile() && /^notice/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => path.join(dir, entry.name));
  const nestedDirs = entries
    .filter((entry) => entry.isDirectory() && /^licen[cs]es$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const nested: string[] = [];
  for (const entry of nestedDirs) nested.push(...await collectLicenseFiles(path.join(dir, entry.name)));
  return [...licenses, ...nested, ...notices];
}

export function assertEchartsLicense(text: string): void {
  // Linux readdir order can put echarts/NOTICE before LICENSE; never publish
  // the 168-byte notice as if it were the Apache License.
  if (!/Apache License/i.test(text) || Buffer.byteLength(text) < 10_000) {
    throw new Error("Office prepack copied the echarts NOTICE instead of its Apache License");
  }
}