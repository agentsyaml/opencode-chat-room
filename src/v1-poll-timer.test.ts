import { expect, test } from "bun:test";
import { createV1Server } from "./v1-plugin";

test("V1 central timer also polls observed inboxes", async () => {
  let wakeCalls = 0, inboxCalls = 0;
  const hooks = await createV1Server({
    runtime: () => ({ protocol: "v1", selfServerUrl: "", selfDirectory: "", transport: {}, center: { center: "", token: "" } }) as any,
    run: (_runtime, callback) => callback(),
    room: {} as any,
    observe: async () => {},
    checkInbox: async () => { inboxCalls++; },
    wake: async () => { wakeCalls++; },
    central: true,
  })({ serverUrl: new URL("http://v1.example"), directory: "/tmp" } as any);
  try {
    await hooks["chat.message"]!({ sessionID: "__Test_v1_timer" } as any, {} as any);
    wakeCalls = 0; inboxCalls = 0;
    await Bun.sleep(10_500);
    expect(wakeCalls).toBeGreaterThan(0);
    expect(inboxCalls).toBeGreaterThan(0);
  } finally {
    await hooks.dispose?.();
  }
}, 20000);