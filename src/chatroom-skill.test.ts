import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { createV1Server } from "./v1-plugin";
import { chatroomSkill } from "./chatroom-skill";

test("V1 adds the packaged skill directory without losing existing skill sources", async () => {
  const plugin = createV1Server({
    runtime: (_input, transport) => ({ protocol: "v1", selfServerUrl: "", selfDirectory: "", transport, center: { center: "", token: "" } }),
    run: (_runtime, callback) => callback(), room: {} as never,
    observe: async () => {}, checkInbox: async () => {}, wake: async () => {}, central: false,
  });
  const hooks = await plugin({ serverUrl: new URL("http://127.0.0.1"), directory: process.cwd() } as never);
  const config = { command: {}, skills: { paths: ["/existing/skills"], urls: ["https://example.test/skills"] } };
  await hooks.config!(config);
  await hooks.config!(config);
  expect(config.skills.paths[0]).toBe("/existing/skills");
  expect(config.skills.paths).toHaveLength(2);
  expect(config.skills.urls).toEqual(["https://example.test/skills"]);
  expect(existsSync(path.join(config.skills.paths[1]!, "chatroom", "SKILL.md"))).toBe(true);
  expect(chatroomSkill.name).toBe("chatroom");
  expect(chatroomSkill.content).toContain('"isQuestion":true');
  expect(chatroomSkill.content).toContain("Do not join any room unless the user explicitly asks");
});
