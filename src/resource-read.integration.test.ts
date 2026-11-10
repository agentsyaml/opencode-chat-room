import { expect, test } from "bun:test";
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

test("read_resource returns uploaded local-server image bytes through V2", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "resource-read-integration-"));
  const child = Bun.spawn([process.execPath, "-e", `
    process.env.CHAT_ROOM_STATE_DIR = ${JSON.stringify(dir)};
    process.env.CHAT_ROOM_SERVER_TOKEN = "isolated-resource-test-token";
    process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = "2";
    const { default: config } = await import(${JSON.stringify(path.resolve("server/chat-server.ts"))});
    const server = Bun.serve({ ...config, hostname: "127.0.0.1", port: 0 });
    const origin = "http://127.0.0.1:" + server.port, token = "isolated-resource-test-token";
    const fs = await import("node:fs/promises"), path = await import("node:path");
    const auth = { Authorization: "Bearer " + token };
    const req = (url, init={}) => fetch(origin + url, { ...init, headers: { ...auth, ...init.headers } });
    let downloadedDirectory;
    try {
      const created = await req("/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "__Test_read_resource", ownerId: "tester", sessionID: "member" }) });
      if (!created.ok) throw new Error("room setup failed");
      const room = await created.json();
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WioAAAAASUVORK5CYII=", "base64");
      const uploaded = await req("/rooms/" + room.id + "/resources", { method: "POST", headers: { "X-Session-ID": "member", "X-File-Name": "photo.png", "Content-Type": "application/octet-stream" }, body: png });
      if (uploaded.status !== 201) throw new Error("resource upload failed");
      const resource = (await uploaded.json()).resource;
      const metadataResponse = await req("/rooms/" + room.id + "/resources/" + resource.id);
      const metadata = (await metadataResponse.json()).resource;
      if (!metadataResponse.ok || metadata.id !== resource.id || metadata.roomID !== room.id || metadata.mimeType !== "image/png" || metadata.size !== png.length) throw new Error("resource metadata fields mismatch");
      const contentResponse = await req("/rooms/" + room.id + "/resources/" + resource.id + "/content");
      const content = Buffer.from(await contentResponse.arrayBuffer());
      if (!contentResponse.ok || contentResponse.headers.get("Content-Type") !== "image/png" || !content.equals(png)) throw new Error("resource content mismatch");
      const { createV2Setup } = await import(${JSON.stringify(path.resolve("src/v2-plugin.ts"))});
      const { readAgentResource } = await import(${JSON.stringify(path.resolve("src/resource-read.ts"))});
      let registered, permissions = [];
      const disposable = { dispose: async () => {} };
      const setup = createV2Setup({
        runtime: (directory, transport) => ({ protocol: "v2", selfServerUrl: "", selfDirectory: directory, transport, center: { center: origin, token } }),
        run: (_runtime, callback) => callback(),
        execute: async (args, _session, permission) => {
          return readAgentResource({ center: origin, token }, args.roomId, args.resourceId, permission);
        },
        observe: async () => {}, poll: async () => {}, attachReceiver: () => () => {},
      });
      const context = {
        location: { directory: process.env.CHAT_ROOM_STATE_DIR }, app: {}, permission: { assert: async (input) => { permissions.push(input.action); } },
        skill: { transform: async (edit) => { edit({ get: () => undefined, add: () => {} }); return disposable; } },
        session: { hook: async () => disposable },
        tool: { transform: async (edit) => { edit({ add: (tool) => { registered = tool; } }); return disposable; } },
        command: { transform: async (edit) => { edit({ add: () => {} }); return disposable; } },
      };
      const stop = await setup(context);
      const result = await registered.execute({ action: "read_resource", roomId: room.id, resourceId: resource.id }, { sessionID: "model-session", signal: new AbortController().signal });
      if (result.content.length !== 1 || result.content[0].type !== "text") throw new Error("V2 returned non-text attachment content");
      const match = result.content[0].text.match(/ to (.+); used/);
      if (!match || !result.content[0].text.includes("photo.png (image/png, " + png.length + " bytes)")) throw new Error("V2 result did not include expected saved-file metadata");
      downloadedDirectory = path.dirname(match[1]);
      if (!Buffer.from(await fs.readFile(match[1])).equals(png)) throw new Error("V2 saved path did not contain server content");
      if (permissions.join(",") !== "webfetch,external_directory,edit,read") throw new Error("V2 network and filesystem permissions were not requested");
      await stop();
    } finally { if (downloadedDirectory) await fs.rm(downloadedDirectory, { recursive: true, force: true }); server.stop(true); }
  `], { env: process.env, stdout: "pipe", stderr: "pipe" });
  try {
    const code = await child.exited;
    if (code) throw new Error(`${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
