import { expect, test } from "bun:test";
import { createV2Setup } from "./v2-plugin";

test("V2 admin tool uses native session and verified owner context", async () => {
  let registered: Array<Record<string, any>> = [];
  const hooks: Record<string, (input: any) => Promise<void>> = {};
  const setup = createV2Setup({
    runtime: (directory, transport) => ({ protocol: "v2", selfServerUrl: "", selfDirectory: directory, transport, center: { center: "https://center.example", token: "" } }),
    run: (_runtime, callback) => callback(), execute: async () => "", observe: async () => {}, poll: async () => {},
    resolveOwner: async () => "verified-owner", admin: async (_args, sessionID, transport) => `${sessionID}:${transport.receiverOwnerID}`,
    attachReceiver: () => () => {},
  });
  const dispose = async () => {};
  const context = {
    location: { directory: "/isolated/project" }, app: {},
    session: { hook: async (name: string, handler: (input: any) => Promise<void>) => { hooks[name] = handler; return { dispose }; }, prompt: async () => ({}) },
    skill: { transform: async (callback: any) => { callback({ get: () => undefined, add: () => {} }); return { dispose }; } },
    tool: { transform: async (callback: any) => { callback({ add: (tool: Record<string, any>) => { registered.push(tool); } }); return { dispose }; } },
    command: { transform: async () => ({ dispose }) }, permission: { assert: async () => {} },
  };
  const stop = await setup(context as never);
  try {
    await hooks.context!({ sessionID: "native-session", messages: [] });
    const admin = registered.find((tool) => tool.name === "admin");
    expect(admin).toBeDefined();
    const result = await admin!.execute({ action: "admin_claim", roomId: "admin" }, { sessionID: "native-session" });
    expect(result.content[0].text).toBe("native-session:verified-owner");
  } finally { await stop(); }
});
