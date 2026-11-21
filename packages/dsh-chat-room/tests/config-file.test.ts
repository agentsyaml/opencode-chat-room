import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { loadRoomConfig } from "../src/file-config.ts";

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(path.join(tmpdir(), "dsh-chatroom-config-"));
  roots.push(root);
  return root;
}
function envFor(root: string): NodeJS.ProcessEnv {
  return { HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config") };
}
function write(root: string, name: string, content: string): string {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("dsh chatroom config files", () => {
  test("reads JSON and prefers client settings over top-level", () => {
    const root = temp();
    write(root, "chatroom.json", JSON.stringify({
      url: "https://top.example",
      token: "top-token",
      client: { url: "https://client.example/", token: "client-token", participant: "alice", deliveryIntervalMs: 2000, requestTimeoutMs: 3000 },
    }));
    const file = loadRoomConfig(envFor(root), root);
    expect(file).toEqual({
      url: "https://top.example",
      token: "top-token",
      client: { url: "https://client.example/", token: "client-token", participant: "alice", deliveryIntervalMs: 2000, requestTimeoutMs: 3000 },
    });
    expect(resolveConfig({}, envFor(root), root)).toEqual({
      url: "https://client.example",
      token: "client-token",
      participant: "alice",
      deliveryIntervalMs: 2000,
      requestTimeoutMs: 3000,
    });
  });

  test("reads JSONC comments and trailing commas", () => {
    const root = temp();
    write(root, "chatroom.jsonc", `{
      // shared center
      "url": "https://jsonc.example",
      "client": { "participant": "carol", },
      /* trailing commas are accepted */
    }`);
    const file = loadRoomConfig(envFor(root), root);
    expect(file?.url).toBe("https://jsonc.example");
    expect(file?.client?.participant).toBe("carol");
  });

  test("reads YAML", () => {
    const root = temp();
    write(root, "chatroom.yaml", `url: https://yaml.example
token: yaml-token
client:
  participant: bob
  deliveryIntervalMs: 2500
  requestTimeoutMs: 4000
`);
    expect(loadRoomConfig(envFor(root), root)).toMatchObject({
      url: "https://yaml.example",
      token: "yaml-token",
      client: { participant: "bob", deliveryIntervalMs: 2500, requestTimeoutMs: 4000 },
    });
  });

  test("prefers chatroom.json over chatroom.yaml in the working directory", () => {
    const root = temp();
    write(root, "chatroom.yaml", "url: https://yaml.example\n");
    write(root, "chatroom.json", JSON.stringify({ url: "https://json.example" }));
    expect(loadRoomConfig(envFor(root), root)?.url).toBe("https://json.example");
  });

  test("falls back to the user config directory when the working directory has none", () => {
    const root = temp();
    write(path.join(root, "config", "chatroom"), "chatroom.yml", "url: https://user.example\n");
    expect(loadRoomConfig(envFor(root), root)?.url).toBe("https://user.example");
  });

  test("environment overrides the file", () => {
    const root = temp();
    write(root, "chatroom.json", JSON.stringify({
      url: "https://file.example",
      token: "file-token",
      client: { url: "https://client-file.example", token: "client-file-token", participant: "dave", deliveryIntervalMs: 2000 },
    }));
    const env = {
      ...envFor(root),
      CHAT_ROOM_SERVER_URL: "https://env.example",
      CHAT_ROOM_SERVER_TOKEN: "env-token",
    };
    expect(resolveConfig({}, env, root)).toMatchObject({
      url: "https://env.example",
      token: "env-token",
      participant: "dave",
      deliveryIntervalMs: 2000,
    });
    // An empty environment value is unset, matching the shared loader.
    expect(resolveConfig({}, { ...env, CHAT_ROOM_SERVER_URL: "", CHAT_ROOM_SERVER_TOKEN: "" }, root)).toMatchObject({
      url: "https://client-file.example",
      token: "client-file-token",
    });
  });

  test("explicit input overrides environment and file", () => {
    const root = temp();
    write(root, "chatroom.json", JSON.stringify({
      url: "https://file.example",
      token: "file-token",
      client: { participant: "dave", deliveryIntervalMs: 2000, requestTimeoutMs: 3000 },
    }));
    const env = {
      ...envFor(root),
      CHAT_ROOM_SERVER_URL: "https://env.example",
      CHAT_ROOM_SERVER_TOKEN: "env-token",
    };
    expect(resolveConfig({
      url: "https://input.example/",
      token: "input-token",
      participant: "erin",
      deliveryIntervalMs: 4000,
      requestTimeoutMs: 5000,
    }, env, root)).toEqual({
      url: "https://input.example",
      token: "input-token",
      participant: "erin",
      deliveryIntervalMs: 4000,
      requestTimeoutMs: 5000,
    });
  });

  test("an explicit config path must exist", () => {
    const root = temp();
    expect(() => loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: path.join(root, "missing.json") }, root))
      .toThrow("CHAT_ROOM_CONFIG file does not exist");
  });

  test("invalid config errors do not echo the token", () => {
    const root = temp();
    const malformed = write(root, "chatroom.json", `{ "token": "super-secret",`);
    try {
      loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: malformed }, root);
      throw new Error("expected malformed config to fail");
    } catch (error) {
      expect((error as Error).message).toContain("not valid JSON/YAML");
      expect((error as Error).message).not.toContain("super-secret");
    }

    const invalid = write(root, "bad.json", JSON.stringify({ token: "super-secret", client: { deliveryIntervalMs: 10 } }));
    try {
      loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: invalid }, root);
      throw new Error("expected invalid config to fail");
    } catch (error) {
      expect((error as Error).message).toContain("client.deliveryIntervalMs");
      expect((error as Error).message).not.toContain("super-secret");
    }
  });
});