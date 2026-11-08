import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { uploadAgentResource } from "./resource-upload";

test("upload requires central mode and host read permission before touching the file", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "resource-tool-"));
  const file = path.join(dir, "private.bin");
  await fs.writeFile(file, "private");
  const context = { directory: dir, worktree: dir, ask: async () => { throw new Error("permission denied"); } };
  try {
    await expect(uploadAgentResource({ center: "", token: "" }, "room", file, "session", context)).resolves.toContain("error: resource uploads require");
    await expect(uploadAgentResource({ center: "http://127.0.0.1:1", token: "" }, "room", file, "session", context)).rejects.toThrow("permission denied");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("checks symlink target permission and leaves size enforcement to the server", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "resource-symlink-"));
  const worktree = path.join(root, "worktree"), outside = path.join(root, "outside");
  await fs.mkdir(worktree); await fs.mkdir(outside);
  const target = path.join(outside, "secret.bin"), link = path.join(worktree, "link.bin");
  await fs.writeFile(target, "0123456789abcdef"); await fs.symlink(target, link);
  const actualTarget = await fs.realpath(target);
  const asked: string[] = [];
  const context = { directory: worktree, worktree, ask: async (input: { metadata: Record<string, unknown> }) => {
    const filepath = String(input.metadata.filepath ?? ""); asked.push(filepath);
    if (filepath === actualTarget) throw new Error("target permission denied");
  } };
  const oldLimit = process.env.CHAT_ROOM_MAX_FILE_SIZE_MB;
  const originalFetch = globalThis.fetch;
  process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = "0.000001";
  let uploaded = false;
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    uploaded = true;
    const bytes = await new Response(init?.body).arrayBuffer();
    expect(bytes.byteLength).toBe(16);
    return Response.json({ resource: { id: "resource-id" } }, { status: 201 });
  }, { preconnect: originalFetch.preconnect });
  try {
    await expect(uploadAgentResource({ center: "http://center", token: "" }, "room", link, "session", context)).rejects.toThrow("target permission denied");
    expect(asked).toContain(actualTarget);
    expect(uploaded).toBe(false);
    const normal = { ...context, ask: async () => {} };
    const result = await uploadAgentResource({ center: "http://center", token: "" }, "room", target, "session", normal);
    expect(result).toContain("resource-id");
    expect(uploaded).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldLimit === undefined) delete process.env.CHAT_ROOM_MAX_FILE_SIZE_MB; else process.env.CHAT_ROOM_MAX_FILE_SIZE_MB = oldLimit;
    await fs.rm(root, { recursive: true, force: true });
  }
});
