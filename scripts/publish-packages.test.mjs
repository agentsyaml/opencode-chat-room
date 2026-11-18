import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareVersions, fetchPublishedVersions, parseArgs, planPublish, releasePackages } from "./publish-packages.mjs";

// A regression must not reach the live registry even if it calls npm.
process.env.npm_config_dry_run = "true";

async function withPackage(version, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "publish-packages-test-"));
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@scope/test", version }));
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an unpublished package is published", () => {
  assert.equal(planPublish("0.1.0", []), "publish");
});

test("the same published version is skipped", () => {
  assert.equal(planPublish("0.1.0", ["0.0.9", "0.1.0"]), "skip");
});

test("a newer local version is published", () => {
  assert.equal(planPublish("0.1.1", ["0.1.0"]), "publish");
});

test("a local version below newer registry versions is refused", () => {
  assert.throws(() => planPublish("0.1.0", ["0.1.0", "0.2.0"]), /newer 0\.2\.0/);
});

test("a stable local version is newer than a registry prerelease", () => {
  assert.equal(planPublish("0.2.0", ["0.2.0-beta.1"]), "publish");
});

test("a local prerelease is refused instead of guessed", () => {
  assert.throws(() => planPublish("0.2.0-beta.1", ["0.1.0"]), /non-stable/);
});

test("release packages are publishable", async () => {
  for (const directory of ["codex-chat-room", "dsh-chat-room"]) {
    const manifest = JSON.parse(await readFile(new URL(`../packages/${directory}/package.json`, import.meta.url), "utf8"));
    assert.notEqual(manifest.private, true, `${manifest.name} is private`);
  }
});

test("plan mode is the default and never executes a publisher", async () => {
  await withPackage("0.1.0", async (dir) => {
    const fetchImpl = async () => ({ status: 404, ok: false });
    const result = await releasePackages([dir], { fetchImpl, log: () => {} });
    assert.equal(result.mode, "plan");
    assert.deepEqual(result.packages, [{ name: "@scope/test", version: "0.1.0", action: "publish" }]);
  });
});

test("publish mode executes the newer package exactly once", async () => {
  await withPackage("0.1.0", async (dir) => {
    const calls = [];
    const fetchImpl = async () => ({ status: 404, ok: false });
    const result = await releasePackages([dir], {
      publish: true,
      fetchImpl,
      runPublish: (target, manifest) => calls.push([target, manifest.name]),
      log: () => {},
    });
    assert.equal(result.mode, "publish");
    assert.deepEqual(calls, [[dir, "@scope/test"]]);
  });
});

test("publish mode refuses to run without an explicit runner", async () => {
  await withPackage("0.1.0", async (dir) => {
    const fetchImpl = async () => ({ status: 404, ok: false });
    await assert.rejects(releasePackages([dir], { publish: true, fetchImpl, log: () => {} }), /requires a runner/);
  });
});

test("publish mode never runs for an already published version", async () => {
  await withPackage("0.1.0", async (dir) => {
    const calls = [];
    const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ versions: { "0.1.0": {} } }) });
    await releasePackages([dir], { publish: true, fetchImpl, runPublish: () => calls.push(1), log: () => {} });
    assert.equal(calls.length, 0);
  });
});

test("publish mode never runs after a registry error", async () => {
  await withPackage("0.1.0", async (dir) => {
    const calls = [];
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    await assert.rejects(
      releasePackages([dir], { publish: true, fetchImpl, runPublish: () => calls.push(1), log: () => {} }),
      /registry request failed/,
    );
    assert.equal(calls.length, 0);
  });
});

test("--publish is opt-in and unknown options fail", () => {
  assert.deepEqual(parseArgs(["--publish", "a", "b"]), { publish: true, dirs: ["a", "b"] });
  assert.deepEqual(parseArgs(["a"]), { publish: false, dirs: ["a"] });
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

test("semver ordering handles prerelease identifiers", () => {
  assert.ok(compareVersions("0.2.0-beta.2", "0.2.0-beta.10") < 0);
  assert.ok(compareVersions("0.2.0", "0.2.0-rc.1") > 0);
});

test("a registry document returns its published versions", async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ versions: { "0.1.0": {}, "0.1.1": {} } }) });
  assert.deepEqual(await fetchPublishedVersions("@scope/name", { fetchImpl }), ["0.1.0", "0.1.1"]);
});

test("registry 404 means the package was never published", async () => {
  const fetchImpl = async () => ({ status: 404, ok: false });
  assert.deepEqual(await fetchPublishedVersions("@scope/name", { fetchImpl }), []);
});

test("a registry server error is not treated as 404", async () => {
  const fetchImpl = async () => ({ status: 503, ok: false });
  await assert.rejects(fetchPublishedVersions("@scope/name", { fetchImpl }), /HTTP 503/);
});

test("a network error is not treated as 404", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNRESET");
  };
  await assert.rejects(fetchPublishedVersions("@scope/name", { fetchImpl }), /registry request failed/);
});