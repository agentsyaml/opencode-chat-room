import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createV2Setup } from "./v2-plugin";
import { uploadAgentResource } from "./resource-upload";

test("V2 upload bridges native permission assertions and stops on denial", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "v2-resource-permission-"));
  const worktree = path.join(root, "worktree"), outside = path.join(root, "outside");
  await mkdir(worktree); await mkdir(outside);
  const filePath = path.join(outside, "upload.bin");
  await writeFile(filePath, "file");
  const assertions: Array<Record<string, any>> = [];
  let denyRead = false, fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    fetches++;
    expect(init?.redirect).toBe("error");
    return Response.json({ resource: { id: "resource-id" } }, { status: 201 });
  }, { preconnect: originalFetch.preconnect });
  let registered: any;
  const disposable = { dispose: async () => {} };
  const setup = createV2Setup({
    runtime: (directory, transport) => ({ protocol: "v2", selfServerUrl: "", selfDirectory: directory, transport, center: { center: "http://center", token: "" } }),
    run: (_runtime, callback) => callback(),
    execute: (args, sessionID, permissions) => uploadAgentResource({ center: "http://center", token: "" }, args.roomId ?? "", args.filePath ?? "", sessionID, permissions),
    observe: async () => {}, poll: async () => {}, attachReceiver: () => () => {},
  });
  const context = {
    location: { directory: worktree }, app: {},
    permission: { assert: async (input: Record<string, any>) => {
      assertions.push(input);
      if (denyRead && input.action === "read") throw new Error("permission denied");
    } },
    skill: { transform: async (edit: (editor: any) => void) => { edit({ get: () => undefined, add: () => {} }); return disposable; } },
    session: { hook: async () => disposable },
    tool: { transform: async (edit: (editor: any) => void) => { edit({ add: (tool: unknown) => { registered = tool; } }); return disposable; } },
    command: { transform: async (edit: (editor: any) => void) => { edit({ add: () => {} }); return disposable; } },
  } as never;
  try {
    const dispose = await setup(context);
    const toolContext = { sessionID: "session", agent: "agent", messageID: "message", id: "call", signal: new AbortController().signal, progress: async () => {} };
    await registered.execute({ action: "upload_resource", roomId: "room", filePath }, toolContext);
    expect(assertions.map((input) => input.action)).toContain("external_directory");
    expect(assertions.map((input) => input.action)).toContain("read");
    expect(assertions.every((input) => input.sessionID === "session" && input.agent === "agent" && input.source.id === "call")).toBe(true);
    expect(fetches).toBe(1);
    denyRead = true;
    await expect(registered.execute({ action: "upload_resource", roomId: "room", filePath }, toolContext)).rejects.toThrow("permission denied");
    expect(fetches).toBe(1);
    await dispose();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
