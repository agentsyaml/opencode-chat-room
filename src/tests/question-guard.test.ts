import { expect, test } from "bun:test";
import { createV1Server } from "../runtime/v1-plugin.ts";

function build(hasRooms: (runtime: unknown, sessionID: string) => Promise<boolean>) {
  return createV1Server({
    runtime: () => ({ protocol: "v1", selfServerUrl: "http://127.0.0.1", selfDirectory: process.cwd(), transport: {} as never, center: { center: "http://127.0.0.1", token: "t" } }) as never,
    run: (_runtime, callback) => callback(),
    room: { description: "room", args: {}, execute: async () => "ok" } as never,
    observe: async () => {},
    checkInbox: async () => {},
    wake: async () => {},
    central: false,
    hasRooms: hasRooms as never,
  });
}

const input = { serverUrl: new URL("http://127.0.0.1"), directory: process.cwd() } as never;

test("the host question tool is refused while the session belongs to a room", async () => {
  const hooks = await build(async (_runtime, sessionID) => sessionID === "member")(input);
  const guard = hooks["tool.execute.before"]!;
  await expect(guard({ tool: "question", sessionID: "member", callID: "call-1" }, { args: {} })).rejects.toThrow(/Send the question in the room/);
});

test("other sessions and other tools pass through", async () => {
  const hooks = await build(async () => false)(input);
  const guard = hooks["tool.execute.before"]!;
  await guard({ tool: "question", sessionID: "stranger", callID: "call-2" }, { args: {} });
  await guard({ tool: "room", sessionID: "member", callID: "call-3" }, { args: {} });
});

test("an unreachable center never blocks the tool", async () => {
  const hooks = await build(async () => { throw new Error("center down"); })(input);
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "member", callID: "call-4" }, { args: {} });
});