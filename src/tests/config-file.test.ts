import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findRoomConfigFile,
  loadRoomConfig,
  resolveClientSettings,
  resolveServerSettings,
} from "../config/file-config.ts";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "chatroom-config-test-"));
  roots.push(root);
  return root;
};
const envFor = (root: string): NodeJS.ProcessEnv => ({
  HOME: path.join(root, "home"),
  XDG_CONFIG_HOME: path.join(root, "config"),
});
const write = (root: string, name: string, content: string) => {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("chatroom config files", () => {
  test("reads JSON with server, client, and peer settings", () => {
    const root = temp();
    const file = write(root, "chatroom.json", JSON.stringify({
      url: "https://chat.example",
      token: "top-token",
      server: { host: "127.0.0.1", port: 5001, stateDir: "/data", maxFileSizeMb: 25 },
      client: { participant: "alice", deliveryIntervalMs: 2000, requestTimeoutMs: 3000 },
      p2p: { enabled: true, peers: { beta: { url: "https://beta.example/", token: "peer-token" } } },
    }));
    const config = loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
    expect(config?.url).toBe("https://chat.example");
    expect(config?.token).toBe("top-token");
    expect(config?.server?.port).toBe(5001);
    expect(config?.server?.stateDir).toBe("/data");
    expect(config?.client?.participant).toBe("alice");
    expect(config?.client?.deliveryIntervalMs).toBe(2000);
    expect(config?.p2p?.enabled).toBe(true);
    expect(config?.p2p?.peers?.beta).toEqual({ url: "https://beta.example", token: "peer-token" });
  });

  test("reads JSONC comments and trailing commas", () => {
    const root = temp();
    const file = write(root, "chatroom.jsonc", `{
      // shared center
      "url": "https://chat.example",
      "client": { "participant": "alice", },
      /* trailing commas are accepted */
      "server": { "port": 5002, },
    }`);
    const config = loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
    expect(config?.url).toBe("https://chat.example");
    expect(config?.client?.participant).toBe("alice");
    expect(config?.server?.port).toBe(5002);
  });

  test("reads YAML", () => {
    const root = temp();
    const file = write(root, "chatroom.yaml", `url: https://yaml.example
token: yaml-token
client:
  participant: bob
  requestTimeoutMs: 4000
`);
    const config = loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
    expect(config?.url).toBe("https://yaml.example");
    expect(config?.token).toBe("yaml-token");
    expect(config?.client?.participant).toBe("bob");
    expect(config?.client?.requestTimeoutMs).toBe(4000);
  });

  test("prefers chatroom.json over yaml in the working directory", () => {
    const root = temp();
    write(root, "chatroom.yaml", "url: https://yaml.example\n");
    write(root, "chatroom.json", JSON.stringify({ url: "https://json.example" }));
    const env = envFor(root);
    expect(findRoomConfigFile(env, root)).toBe(path.join(root, "chatroom.json"));
    expect(loadRoomConfig(env, root)?.url).toBe("https://json.example");
  });

  test("uses the user config directory when the working directory has none", () => {
    const root = temp();
    const dir = path.join(root, "config", "chatroom");
    write(dir, "chatroom.yml", "url: https://user.example\n");
    const env = envFor(root);
    expect(findRoomConfigFile(env, path.join(root, "project"))).toBe(path.join(dir, "chatroom.yml"));
    expect(loadRoomConfig(env, path.join(root, "project"))?.url).toBe("https://user.example");
  });

  test("environment overrides the file for clients and servers", () => {
    const root = temp();
    const file = write(root, "chatroom.json", JSON.stringify({
      url: "https://file.example",
      token: "file-token",
      server: { host: "file-host", port: 5003, wakeServeUrl: "https://file-wake.example" },
      client: { token: "client-file-token", wakeServeUrl: "https://client-wake.example" },
    }));
    const env = {
      ...envFor(root),
      CHAT_ROOM_CONFIG: file,
      CHAT_ROOM_SERVER_URL: "https://env.example",
      CHAT_ROOM_SERVER_TOKEN: "env-token",
      CHAT_ROOM_WAKE_SERVE_URL: "https://env-wake.example",
      CHAT_ROOM_SERVER_HOST: "env-host",
      CHAT_ROOM_SERVER_PORT: "5004",
    };
    const config = loadRoomConfig(env, root);
    expect(resolveClientSettings(config, env)).toEqual({
      url: "https://env.example",
      token: "env-token",
      wakeServeUrl: "https://env-wake.example",
    });
    expect(resolveServerSettings(config, env)).toMatchObject({
      host: "env-host",
      port: "5004",
      token: "env-token",
      wakeServeUrl: "https://env-wake.example",
    });
  });

  test("explicit config path must exist", () => {
    const root = temp();
    expect(() => loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: path.join(root, "missing.json") }, root))
      .toThrow("CHAT_ROOM_CONFIG file does not exist");
  });

  test("malformed config does not echo its contents", () => {
    const root = temp();
    const file = write(root, "chatroom.json", `{ "token": "super-secret",`);
    try {
      loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root);
      throw new Error("expected malformed config to fail");
    } catch (error) {
      expect((error as Error).message).toContain("not valid JSON/YAML");
      expect((error as Error).message).not.toContain("super-secret");
    }
  });

  test("rejects invalid known fields", () => {
    const root = temp();
    const file = write(root, "chatroom.json", JSON.stringify({ server: { port: 70000 } }));
    expect(() => loadRoomConfig({ ...envFor(root), CHAT_ROOM_CONFIG: file }, root)).toThrow("server.port");
  });
});