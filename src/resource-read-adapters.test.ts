import { expect, test } from "bun:test";
import { createV1Server } from "./v1-plugin";
import { createV2Setup } from "./v2-plugin";

const saved = "Saved archive.bin (application/octet-stream, 5 bytes) to /private/tmp/file.bin.";
const dispose = { dispose: async () => {} };

test("V1 adapter preserves the string result", async () => {
  const hooks = await createV1Server({
    runtime: () => ({ protocol: "v1", selfServerUrl: "", selfDirectory: "", transport: {} as never, center: { center: "", token: "" } }),
    run: (_runtime, callback) => callback(), room: { execute: async () => saved } as never,
    observe: async () => {}, checkInbox: async () => {}, wake: async () => {}, central: false,
  })({ serverUrl: new URL("http://local"), directory: "/" } as never);
  expect(await hooks.tool!.room!.execute({}, { sessionID: "s" } as never)).toBe(saved);
  await hooks.dispose?.();
});

test("V2 adapter returns only textual Tool.Result content", async () => {
  const { registered, stop } = await registerV2(async () => saved);
  const result = await registered.execute({ action: "read_resource" }, { sessionID: "s", signal: new AbortController().signal });
  expect(Object.keys(result)).toEqual(["content"]);
  expect(result.content).toEqual([{ type: "text", text: saved }]);
  await stop();
});

test("V2 permission denial reaches no network request", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; return new Response(); }, { preconnect: original.preconnect });
  try {
    const { registered, stop } = await registerV2((_args, _session, permission) =>
      import("./resource-read").then(({ readAgentResource }) => readAgentResource(
        { center: "https://chat.example", token: "" }, "123e4567-e89b-42d3-a456-426614174000",
        "123e4567-e89b-42d3-a456-426614174001", permission)), async () => { throw new Error("denied"); });
    const context = { sessionID: "s", signal: new AbortController().signal };
    await expect(registered.execute({ action: "read_resource" }, context)).rejects.toThrow("denied");
    expect(calls).toBe(0);
    await stop();
  } finally { globalThis.fetch = original; }
});

async function registerV2(execute: (...args: any[]) => Promise<unknown>, assert: () => Promise<void> = async () => {}) {
  let registered: any;
  const setup = createV2Setup({
    runtime: (directory, transport) => ({ protocol: "v2", selfServerUrl: "", selfDirectory: directory, transport, center: { center: "", token: "" } }),
    run: (_runtime, callback) => callback(), execute: execute as never,
    observe: async () => {}, poll: async () => {}, attachReceiver: () => () => {},
  });
  const context = {
    location: { directory: "/" }, app: {}, permission: { assert },
    skill: { transform: async (edit: (editor: any) => void) => { edit({ get: () => undefined, add: () => {} }); return dispose; } },
    session: { hook: async () => dispose },
    tool: { transform: async (edit: (editor: any) => void) => { edit({ add: (tool: unknown) => { registered = tool; } }); return dispose; } },
    command: { transform: async (edit: (editor: any) => void) => { edit({ add: () => {} }); return dispose; } },
  } as never;
  const stop = await setup(context);
  return { registered, stop };
}
