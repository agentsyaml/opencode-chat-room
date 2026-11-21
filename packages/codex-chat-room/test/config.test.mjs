import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadRoomConfig, resolveCodexConfig } from "../plugin/lib/config.mjs";

const roots = [];

function temp() {
  const root = mkdtempSync(path.join(tmpdir(), "codex-chatroom-config-"));
  roots.push(root);
  return root;
}

function envFor(root) {
  return {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
}

function write(root, name, content) {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("reads JSON and prefers client settings over top-level values", () => {
  const root = temp();
  const file = write(root, "chatroom.json", JSON.stringify({
    url: "https://top.example",
    token: "top-token",
    client: { url: "https://client.example", token: "client-token", delivery: false, codexBin: "/opt/codex" },
  }));
  const env = { ...envFor(root), CHAT_ROOM_CONFIG: file };
  const config = loadRoomConfig(env, root);
  assert.equal(config.url, "https://top.example");
  assert.deepEqual(config.client, {
    url: "https://client.example",
    token: "client-token",
    delivery: false,
    codexBin: "/opt/codex",
  });
  assert.deepEqual(resolveCodexConfig(env, root), {
    url: "https://client.example",
    token: "client-token",
    delivery: false,
    codexBin: "/opt/codex",
  });
});

test("reads JSONC with comments, trailing commas and // inside strings", () => {
  const root = temp();
  const file = write(root, "chatroom.jsonc", `{
    // shared center
    "url": "https://jsonc.example//path",
    "client": {
      "token": "jsonc-token", /* inline comment */
      "delivery": true,
    },
  }`);
  const resolved = resolveCodexConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
  assert.deepEqual(resolved, {
    url: "https://jsonc.example//path",
    token: "jsonc-token",
    delivery: true,
    codexBin: "codex",
  });
});

test("reads YAML", () => {
  const root = temp();
  const file = write(root, "chatroom.yaml", `url: https://yaml.example
token: yaml-token
client:
  codexBin: /usr/local/bin/codex
  delivery: false
`);
  const resolved = resolveCodexConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
  assert.deepEqual(resolved, {
    url: "https://yaml.example",
    token: "yaml-token",
    delivery: false,
    codexBin: "/usr/local/bin/codex",
  });
});

test("searches the working directory before the user config directory", () => {
  const root = temp();
  write(root, "chatroom.yaml", "url: https://yaml.example\n");
  write(root, "chatroom.json", JSON.stringify({ url: "https://json.example" }));
  assert.equal(resolveCodexConfig(envFor(root), root).url, "https://json.example");

  const project = path.join(root, "project");
  const userDir = path.join(root, "config", "chatroom");
  write(userDir, "chatroom.yml", "url: https://user.example\n");
  assert.equal(resolveCodexConfig(envFor(root), project).url, "https://user.example");
});

test("environment values override the file", () => {
  const root = temp();
  const file = write(root, "chatroom.json", JSON.stringify({
    url: "https://file.example",
    token: "file-token",
    client: { url: "https://client.example", token: "client-token", delivery: true, codexBin: "file-codex" },
  }));
  const env = {
    ...envFor(root),
    CHAT_ROOM_CONFIG: file,
    CHAT_ROOM_SERVER_URL: "https://env.example",
    CHAT_ROOM_SERVER_TOKEN: "env-token",
    CHAT_ROOM_DELIVERY: "0",
    CHAT_ROOM_CODEX_BIN: "/env/codex",
  };
  assert.deepEqual(resolveCodexConfig(env, root), {
    url: "https://env.example",
    token: "env-token",
    delivery: false,
    codexBin: "/env/codex",
  });
});

test("explicit config path must exist", () => {
  const root = temp();
  assert.throws(
    () => loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: path.join(root, "missing.json") }, root),
    /CHAT_ROOM_CONFIG file does not exist/,
  );
});

test("malformed config does not echo its contents", () => {
  const root = temp();
  const file = write(root, "chatroom.json", `{ "token": "super-secret",`);
  assert.throws(
    () => loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root),
    (error) => {
      assert.match(error.message, /not valid JSON\/YAML/);
      assert.equal(error.message.includes("super-secret"), false);
      return true;
    },
  );
});

test("invalid known fields fail without echoing the token", () => {
  const root = temp();
  const file = write(root, "chatroom.json", JSON.stringify({
    token: "super-secret",
    client: { delivery: "yes" },
  }));
  assert.throws(
    () => loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root),
    (error) => {
      assert.match(error.message, /client\.delivery must be true or false/);
      assert.equal(error.message.includes("super-secret"), false);
      return true;
    },
  );
});