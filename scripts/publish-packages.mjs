// Plan or publish packages whose local version is newer than the registry.
// The default is read-only; publishing requires --publish.
// A registry 404 means "never published"; any other failure aborts before publish.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY = "https://registry.npmjs.org";

export function parseArgs(argv) {
  const publish = argv.includes("--publish");
  const dirs = argv.filter((arg) => arg !== "--publish");
  const unknown = dirs.find((arg) => arg.startsWith("--"));
  if (unknown) throw new Error(`unknown option ${unknown}`);
  return { publish, dirs };
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error(`unsupported version "${version}"`);
  const pre = match[4]?.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

export function compareVersions(left, right) {
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre || !b.pre) return (a.pre ? -1 : 0) - (b.pre ? -1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const aNumber = typeof a.pre[i] === "number";
    const bNumber = typeof b.pre[i] === "number";
    if (aNumber && bNumber) return a.pre[i] - b.pre[i];
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
}

export function planPublish(localVersion, publishedVersions) {
  if (!/^\d+\.\d+\.\d+$/.test(localVersion)) {
    throw new Error(`refusing non-stable version ${localVersion}; prerelease versions need an explicit dist-tag policy`);
  }
  let newest;
  for (const version of publishedVersions) {
    parse(version);
    if (!newest || compareVersions(version, newest) > 0) newest = version;
  }
  if (newest && compareVersions(localVersion, newest) < 0) {
    throw new Error(`registry has newer ${newest} than local ${localVersion}; refusing to publish a downgrade`);
  }
  if (newest && compareVersions(localVersion, newest) === 0) return "skip";
  return "publish";
}

export async function fetchPublishedVersions(name, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `${REGISTRY}/${encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`registry request failed for ${name}: ${error.message}`);
  }
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status} for ${name}`);
  let document;
  try {
    document = await response.json();
  } catch (error) {
    throw new Error(`registry returned invalid JSON for ${name}: ${error.message}`);
  }
  if (!document?.versions || typeof document.versions !== "object") {
    throw new Error(`registry response for ${name} has no versions`);
  }
  return Object.keys(document.versions);
}

export async function releasePackages(dirs, { publish = false, fetchImpl = fetch, runPublish, log = console.log } = {}) {
  if (dirs.length === 0) throw new Error("usage: node scripts/publish-packages.mjs [--publish] <package-dir>...");
  const targets = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`${dir}/package.json needs name and version`);
    }
    if (manifest.private === true) throw new Error(`${manifest.name} is still private; remove "private": true`);
    const action = planPublish(manifest.version, await fetchPublishedVersions(manifest.name, { fetchImpl }));
    targets.push({ dir, manifest, action });
  }
  const packages = [];
  for (const { dir, manifest, action } of targets) {
    if (action === "skip") {
      log(`skip ${manifest.name}@${manifest.version}: already published`);
    } else if (!publish) {
      log(`would publish ${manifest.name}@${manifest.version} (plan only; pass --publish to publish)`);
    } else {
      if (typeof runPublish !== "function") throw new Error("publish mode requires a runner");
      log(`publish ${manifest.name}@${manifest.version}`);
      runPublish(dir, manifest);
    }
    packages.push({ name: manifest.name, version: manifest.version, action });
  }
  return { mode: publish ? "publish" : "plan", packages };
}

function npmPublish(dir) {
  execFileSync("npm", ["publish", "--access", "public"], { cwd: dir, stdio: "inherit" });
}

async function main(argv) {
  const { publish, dirs } = parseArgs(argv);
  await releasePackages(dirs, { publish, runPublish: npmPublish });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}