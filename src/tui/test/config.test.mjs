import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { resolveTuiConfig } from "../config.mjs";
import { loadSession } from "../session.mjs";

const roots = [];

function temp() {
  const root = mkdtempSync(path.join(tmpdir(), "tui-chatroom-config-"));
  roots.push(root);
  return root;
}

function write(root, name, content) {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function envFor(root, extra = {}) {
  return {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...extra,
  };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("resolves JSON with client overrides, defaults and state path", () => {
  const root = temp();
  const file = write(root, "chatroom.json", JSON.stringify({
    url: "https://top.example",
    token: "top-token",
    client: {
      url: "https://client.example/",
      token: "client-token",
      participant: "alex",
      requestTimeoutMs: 2500,
    },
  }));
  const config = resolveTuiConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
  assert.deepEqual(config, {
    url: "https://client.example",
    token: "client-token",
    participant: "alex",
    requestTimeoutMs: 2500,
    stateFile: path.join(root, "state", "chatroom-tui", "session.json"),
  });
});

test("parses JSONC comments, trailing commas and // inside strings", () => {
  const root = temp();
  const file = write(root, "chatroom.jsonc", `{
    // shared center
    "url": "https://jsonc.example//path",
    "client": {
      "token": "jsonc-token", /* inline comment */
      "participant": "tester",
    },
  }`);
  const config = resolveTuiConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
  assert.equal(config.url, "https://jsonc.example//path");
  assert.equal(config.token, "jsonc-token");
  assert.equal(config.participant, "tester");
});

test("parses YAML config", () => {
  const root = temp();
  const file = write(root, "chatroom.yaml", `url: https://yaml.example
client:
  token: yaml-token
  requestTimeoutMs: 3000
`);
  const config = resolveTuiConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
  assert.equal(config.url, "https://yaml.example");
  assert.equal(config.token, "yaml-token");
  assert.equal(config.requestTimeoutMs, 3000);
});

test("discovers config in cwd first, then the XDG config home", () => {
  const root = temp();
  write(root, "chatroom.yml", "url: https://cwd.example\n");
  const cwdConfig = resolveTuiConfig(envFor(root), root);
  assert.equal(cwdConfig.url, "https://cwd.example");

  const emptyCwd = path.join(root, "work");
  mkdirSync(emptyCwd);
  const homeFile = write(root, "config/chatroom/chatroom.json", JSON.stringify({ url: "https://home.example" }));
  assert.equal(resolveTuiConfig(envFor(root), emptyCwd).url, "https://home.example");
  assert.equal(path.basename(homeFile), "chatroom.json");
});

test("environment overrides the config file", () => {
  const root = temp();
  const file = write(root, "chatroom.json", JSON.stringify({
    url: "https://file.example",
    token: "file-token",
    client: { participant: "file-name" },
  }));
  const env = envFor(root, {
    CHAT_ROOM_CONFIG: file,
    CHAT_ROOM_SERVER_URL: "https://env.example/",
    CHAT_ROOM_SERVER_TOKEN: "env-token",
    CHAT_ROOM_TUI_NAME: "env-name",
    CHAT_ROOM_TUI_STATE: "runtime/session.json",
  });
  const config = resolveTuiConfig(env, root);
  assert.equal(config.url, "https://env.example");
  assert.equal(config.token, "env-token");
  assert.equal(config.participant, "env-name");
  assert.equal(config.stateFile, path.join(root, "runtime", "session.json"));
});

test("missing explicit config file is an error", () => {
  const root = temp();
  const missing = path.join(root, "nope.json");
  assert.throws(
    () => resolveTuiConfig({ ...envFor(root), CHAT_ROOM_CONFIG: missing }, root),
    /CHAT_ROOM_CONFIG file does not exist/,
  );
});

test("empty or non-http URL names both configuration sources", () => {
  const root = temp();
  assert.throws(() => resolveTuiConfig(envFor(root), root), /CHAT_ROOM_SERVER_URL.*client\.url/);
  const file = write(root, "chatroom.json", JSON.stringify({ url: "ftp://example" }));
  assert.throws(
    () => resolveTuiConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root),
    /http\(s\).*CHAT_ROOM_SERVER_URL.*client\.url/,
  );
});

test("parse errors never echo token values or file contents", () => {
  const root = temp();
  const file = write(root, "chatroom.json", '{"token":"super-secret-token", oops}');
  let message = "";
  try {
    resolveTuiConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /not valid JSON\/YAML/);
  assert.doesNotMatch(message, /super-secret-token/);
});

test("session file keeps the ID across runs and follows the fallback name", () => {
  const root = temp();
  const file = path.join(root, "state", "session.json");
  const first = loadSession(file, "alex");
  assert.match(first.sessionID, /^[0-9a-f-]{36}$/);
  assert.equal(first.name, "alex");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const renamed = loadSession(file, "other");
  assert.equal(renamed.sessionID, first.sessionID);
  assert.equal(renamed.name, "other");

  const stable = loadSession(file, "other");
  assert.deepEqual(stable, renamed);
});

test("corrupt session file starts a fresh session without crashing", () => {
  const root = temp();
  const file = path.join(root, "state", "session.json");
  write(root, "state/session.json", "{not json");
  const first = loadSession(file, "alex");
  assert.equal(first.name, "alex");
  assert.match(first.sessionID, /^[0-9a-f-]{36}$/);
  const second = loadSession(file, "alex");
  assert.equal(second.sessionID, first.sessionID);
});