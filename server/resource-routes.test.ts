import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "bun:test";

test("resource API keeps uploads member-gated and serves safe ranged content", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chat-resource-test-"));
  const child = Bun.spawn([process.execPath, "-e", `
    process.env.CHAT_ROOM_STATE_DIR = ${JSON.stringify(dir)};
    process.env.CHAT_ROOM_SERVER_TOKEN = "resource-test-token";
    delete process.env.CHAT_ROOM_MAX_FILE_SIZE_MB;
    const { default: server } = await import(${JSON.stringify(path.resolve("server/chat-server.ts"))});
    const req = (url, method="GET", headers={}, body) => server.fetch(new Request("http://local"+url,{method,headers:{Authorization:"Bearer resource-test-token",...headers},body}));
    const defaultConfig = await req("/resources/config");
    if ((await defaultConfig.json()).maxFileSizeBytes !== 500 * 1024 * 1024) throw new Error("default upload limit was incorrect");
    process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = "3";
    const config = await req("/resources/config");
    if (config.status !== 200 || (await config.json()).maxFileSizeBytes !== 3 * 1024 * 1024 || config.headers.get("Cache-Control") !== "no-store") throw new Error("upload configuration was incorrect");
    if ((await server.fetch(new Request("http://local/resources/config"))).status !== 401) throw new Error("upload configuration bypassed authentication");
    const room = await (await req("/rooms","POST",{"Content-Type":"application/json"},JSON.stringify({name:"__Test_resources",ownerId:"agent",sessionID:"member"}))).json();
    const unauth = await server.fetch(new Request("http://local/rooms/"+room.id+"/resources",{method:"POST",headers:{"X-Session-ID":"member","X-File-Name":"x","Content-Type":"application/octet-stream"},body:new Uint8Array([1])}));
    if (unauth.status !== 401) throw new Error("unauthenticated upload was accepted");
    const denied = await req("/rooms/"+room.id+"/resources","POST",{"X-Session-ID":"outsider","X-File-Name":"x","Content-Type":"application/octet-stream"},new Uint8Array([1]));
    if (denied.status !== 403) throw new Error("nonmember upload was accepted");
    const badName = await req("/rooms/"+room.id+"/resources","POST",{"X-Session-ID":"member","X-File-Name":"%2E%2E%2Fsecret","Content-Type":"application/octet-stream"},new Uint8Array([1]));
    if (badName.status !== 400) throw new Error("unsafe filename was accepted");
    const upload = await req("/rooms/"+room.id+"/resources","POST",{"X-Session-ID":"member","X-File-Name":encodeURIComponent("photo.png"),"Content-Type":"application/octet-stream"},new Uint8Array([137,80,78,71,13,10,26,10,1,2]));
    if (upload.status !== 201) throw new Error("upload failed: "+upload.status+" "+await upload.text());
    const resource = (await upload.json()).resource;
    const unauthGet = await server.fetch(new Request("http://local/rooms/"+room.id+"/resources/"+resource.id));
    if (unauthGet.status !== 401) throw new Error("unauthenticated resource read was accepted");
    const unauthContent = await server.fetch(new Request("http://local/rooms/"+room.id+"/resources/"+resource.id+"/content"));
    if (unauthContent.status !== 401) throw new Error("unauthenticated content read was accepted");
    const metadata = await req("/rooms/"+room.id+"/resources/"+resource.id);
    if (metadata.status !== 200 || (await metadata.json()).resource.id !== resource.id) throw new Error("bearer-only metadata read failed");
    const range = await req("/rooms/"+room.id+"/resources/"+resource.id+"/content","GET",{"Range":"bytes=0-3"});
    if (range.status !== 206 || range.headers.get("Content-Range") !== "bytes 0-3/10" || range.headers.get("X-Content-Type-Options") !== "nosniff") throw new Error("range response was unsafe: "+range.status+" "+range.headers.get("Content-Range")+" "+await range.text());
    if ((await range.arrayBuffer()).byteLength !== 4) throw new Error("range length mismatch");
    const hugeRange = await req("/rooms/"+room.id+"/resources/"+resource.id+"/content","GET",{"Range":"bytes=999999999999999999999-"});
    if (hugeRange.status !== 416) throw new Error("invalid range was not rejected");
    const invalidID = await req("/rooms/"+room.id+"/resources/not-a-uuid","GET",{"X-Session-ID":"member"});
    if (invalidID.status !== 404) throw new Error("invalid resource ID was accepted");
    const empty = await req("/rooms/"+room.id+"/resources","POST",{"X-Session-ID":"member","X-File-Name":"empty.bin","Content-Type":"application/octet-stream"});
    if (empty.status !== 201) throw new Error("empty file upload failed");
    const emptyContent = await req("/rooms/"+room.id+"/resources/"+(await empty.json()).resource.id+"/content");
    if (emptyContent.status !== 200 || (await emptyContent.arrayBuffer()).byteLength !== 0) throw new Error("empty file download failed");
    process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = "0.0000152587890625";
    const oversized = await req("/rooms/"+room.id+"/resources","POST",{"X-Session-ID":"member","X-File-Name":"oversized.bin","Content-Type":"application/octet-stream"},new Uint8Array(17));
    if (oversized.status !== 413) throw new Error("configured upload limit was not enforced");
    const wrongRoom = await req("/rooms/missing/resources/"+resource.id);
    if (wrongRoom.status !== 404) throw new Error("wrong-room resource did not return not found");
  `], { env: process.env, stdout: "pipe", stderr: "pipe" });
  try {
    const code = await child.exited;
    if (code) throw new Error(`${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
