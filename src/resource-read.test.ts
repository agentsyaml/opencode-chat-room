import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readAgentResource, ResourceReadError, resourceReadFailure } from "./resource-read";

const roomID = "123e4567-e89b-42d3-a456-426614174000";
const id = "123e4567-e89b-42d3-a456-426614174001";
const png = new Uint8Array([137,80,78,71,13,10,26,10]);

test("keeps classified failures actionable and hides raw errors", () => {
  expect(resourceReadFailure(new ResourceReadError("aborted", "resource download was canceled"))).toBe("resource download was canceled");
  expect(resourceReadFailure(new Error("https://u:secret@host/?token=secret"))).toBe("resource read failed");
});

test("reads bounded image bytes only after host webfetch permission", async () => {
  const original = globalThis.fetch, calls: string[] = [], permissions: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    if (calls.length === 1) return Response.json({ maxFileSizeBytes: 1000 });
    if (calls.length === 2) return Response.json({ resource: { id, roomID, mimeType: "image/png", size: png.length, name: "x.png" } });
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  }, { preconnect: original.preconnect });
  try {
    const result = await readAgentResource({ center: "https://chat.example", token: "secret" }, roomID, id, {
      ask: async ({ permission }) => { permissions.push(permission); },
    });
    expect(permissions).toEqual(["webfetch", "external_directory", "edit", "read"]);
    expect(calls).toEqual(["https://chat.example/resources/config", `https://chat.example/rooms/${roomID}/resources/${id}`, `https://chat.example/rooms/${roomID}/resources/${id}/content`]);
    const filepath = result.match(/ to (.+); used/)?.[1]!;
    expect(await fs.readFile(filepath)).toEqual(Buffer.from(png));
    expect((await fs.stat(filepath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(filepath))).mode & 0o777).toBe(0o700);
    expect(result).not.toContain(Buffer.from(png).toString("base64"));
    await fs.rm(path.dirname(filepath), { recursive: true, force: true });
  } finally { globalThis.fetch = original; }
});

test("rejects invalid ids before permission or network access", async () => {
  let asked = false;
  await expect(readAgentResource({ center: "https://chat.example", token: "" }, "bad", id, {
    ask: async () => { asked = true; },
  })).rejects.toThrow("invalid roomId");
  expect(asked).toBe(false);
});

test("saves arbitrary binary types without returning file content", async () => {
  const original = globalThis.fetch, bytes = new Uint8Array([0, 255, 10, 13, 128]); let call = 0;
  globalThis.fetch = Object.assign(async () => {
    call++;
    if (call === 1) return Response.json({ maxFileSizeBytes: 100 });
    if (call === 2) return Response.json({ resource: { id, roomID, mimeType: "application/octet-stream", size: bytes.length, name: "raw.bin" } });
    return new Response(bytes);
  }, { preconnect: original.preconnect });
  try {
    const result = await readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, { ask: async () => {} });
    const filepath = result.match(/ to (.+); used/)?.[1]!;
    expect(await fs.readFile(filepath)).toEqual(Buffer.from(bytes));
    expect(result).toContain("application/octet-stream");
    expect(result).not.toContain(Buffer.from(bytes).toString("base64"));
    await fs.rm(path.dirname(filepath), { recursive: true, force: true });
  } finally { globalThis.fetch = original; }
});


test("permission denial prevents every request", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; return new Response(); }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, {
      ask: async () => { throw new Error("denied"); },
    })).rejects.toThrow("denied");
    expect(calls).toBe(0);
  } finally { globalThis.fetch = original; }
});

test("classifies room 404s", async () => {
  const original = globalThis.fetch; let call = 0;
  globalThis.fetch = Object.assign(async () => {
    call++;
    if (call === 1) return Response.json({ maxFileSizeBytes: 100 });
    return new Response(null, { status: 404 });
  }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, { ask: async () => {} }))
      .rejects.toThrow("resource not found in this room");
    expect(call).toBe(2);
  } finally { globalThis.fetch = original; }
});

test("uses native edit permission and does not fetch content when denied", async () => {
  const original = globalThis.fetch; let call = 0;
  globalThis.fetch = Object.assign(async () => {
    call++;
    return call === 1 ? Response.json({ maxFileSizeBytes: 100 }) : Response.json({ resource: { id, roomID, mimeType: "application/octet-stream", size: 1, name: "x.bin" } });
  }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, {
      ask: async ({ permission }) => { if (permission === "edit") throw new Error("deny"); },
    })).rejects.toThrow("host denied edit permission");
    expect(call).toBe(2);
  } finally { globalThis.fetch = original; }
});

test("rejects wrong metadata ids before content fetch", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    return calls === 1 ? Response.json({ maxFileSizeBytes: 100 }) : Response.json({ resource: { id: roomID, roomID, mimeType: "image/png", size: 8, name: "wrong.png" } });
  }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, { ask: async () => {} }))
      .rejects.toThrow("metadata is invalid");
    expect(calls).toBe(2);
  } finally { globalThis.fetch = original; }
});

test("uses the capped fallback when configuration is unavailable", async () => {
  const original = globalThis.fetch; let call = 0;
  globalThis.fetch = Object.assign(async () => {
    call++;
    if (call === 1) throw new Error("https://private:secret@example.invalid");
    if (call === 2) return Response.json({ resource: { id, roomID, mimeType: "application/x-binary", size: 1, name: "x.bin" } });
    return new Response(new Uint8Array([1]));
  }, { preconnect: original.preconnect });
  try {
    const result = await readAgentResource({ center: "https://chat.example", token: "secret-token" }, roomID, id, { ask: async () => {} });
    expect(result).toContain("512 MiB safety cap (server limit unavailable)");
    expect(result).not.toContain("secret");
    const filepath = result.match(/ to (.+); used/)?.[1]!;
    await fs.rm(path.dirname(filepath), { recursive: true, force: true });
  } finally { globalThis.fetch = original; }
});

test("aborts downloads and rejects embedded credentials and redirects", async () => {
  const original = globalThis.fetch; let calls = 0, redirect = "";
  globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++; redirect = init?.redirect ?? "";
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return Response.json({ resource: { id, roomID, mimeType: "image/png", size: 8 } });
  }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://user:password@chat.example", token: "" }, roomID, id, { ask: async () => {} }))
      .rejects.toThrow("invalid chat server URL");
    const controller = new AbortController(); controller.abort();
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, { ask: async () => {} }, controller.signal)).rejects.toThrow();
    expect(redirect).toBe("error");
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

test("enforces actual streaming limit when metadata underreports size", async () => {
  const original = globalThis.fetch; let call = 0;
  globalThis.fetch = Object.assign(async () => {
    call++;
    if (call === 1) return Response.json({ maxFileSizeBytes: 4 });
    if (call === 2) return Response.json({ resource: { id, roomID, mimeType: "image/png", size: 4, name: "x.png" } });
    return new Response(new Uint8Array(5));
  }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, { ask: async () => {} }))
      .rejects.toThrow("exceeds the configured safe limit");
  } finally { globalThis.fetch = original; }
});

test("streams files larger than the former 20 MiB limit to disk", async () => {
  const original = globalThis.fetch, size = 24 * 1024 * 1024; let call = 0;
  globalThis.fetch = Object.assign(async () => {
    call++;
    if (call === 1) return Response.json({ maxFileSizeBytes: 32 * 1024 * 1024 });
    if (call === 2) return Response.json({ resource: { id, roomID, mimeType: "application/octet-stream", size, name: "large.dat" } });
    return new Response(new ReadableStream({ start(controller) {
      for (let sent = 0; sent < size; sent += 1024 * 1024) controller.enqueue(new Uint8Array(1024 * 1024).fill(66));
      controller.close();
    } }));
  }, { preconnect: original.preconnect });
  try {
    const result = await readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, { ask: async () => {} });
    const filepath = result.match(/ to (.+); used/)?.[1]!;
    expect((await fs.stat(filepath)).size).toBe(size);
    expect(result).not.toContain("data:");
    await fs.rm(path.dirname(filepath), { recursive: true, force: true });
  } finally { globalThis.fetch = original; }
});

test("does not follow resource redirects", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++; expect(init?.redirect).toBe("error"); throw new TypeError("redirect blocked");
  }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, { ask: async () => {} }))
      .rejects.toThrow("resource server request failed or timed out");
    expect(calls).toBe(2);
  } finally { globalThis.fetch = original; }
});

test("removes the private directory when an in-flight download aborts", async () => {
  const original = globalThis.fetch, controller = new AbortController(); let call = 0, filepath = "";
  globalThis.fetch = Object.assign(async () => {
    call++;
    if (call === 1) return Response.json({ maxFileSizeBytes: 100 });
    if (call === 2) return Response.json({ resource: { id, roomID, mimeType: "application/octet-stream", size: 5, name: "x.bin" } });
    controller.abort(); throw new DOMException("aborted", "AbortError");
  }, { preconnect: original.preconnect });
  try {
    await expect(readAgentResource({ center: "https://chat.example", token: "" }, roomID, id, {
      ask: async ({ permission, patterns }) => { if (permission === "edit") filepath = patterns[0]!; },
    }, controller.signal)).rejects.toThrow();
    expect(await fs.stat(path.dirname(filepath)).catch(() => undefined)).toBeUndefined();
  } finally { globalThis.fetch = original; }
});
