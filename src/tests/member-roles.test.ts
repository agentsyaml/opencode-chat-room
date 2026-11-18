import { expect, test } from "bun:test";
import { memberRole } from "../../server/assets/chat/admin-badge.js";

const app = (room: Record<string, unknown> = {}) => ({
  state: { room: { ownerId: "Alice", adminIds: ["Bob"], adminSessionID: "agent-admin", ...room } },
});

test("member roles prioritize the owner, then human administrators, then the agent", () => {
  expect(memberRole(app(), { name: "Alice", sessionID: "alice" })).toBe("owner");
  expect(memberRole(app(), { name: "Bob", sessionID: "bob" })).toBe("admin");
  expect(memberRole(app(), { name: "Agent", sessionID: "agent-admin" })).toBe("agent");
  expect(memberRole(app(), { name: "Carol", sessionID: "carol" })).toBe("");
});

test("a member gets one label even when roles overlap", () => {
  expect(memberRole(app({ adminIds: ["Alice"] }), { name: "Alice", sessionID: "alice" })).toBe("owner");
  expect(memberRole(app({ adminSessionID: "alice" }), { name: "Alice", sessionID: "alice" })).toBe("owner");
  expect(memberRole(app({ adminSessionID: "bob" }), { name: "Bob", sessionID: "bob" })).toBe("admin");
});

test("direct rooms show no management role badges", () => {
  expect(memberRole(app({ kind: "direct" }), { name: "Alice", sessionID: "alice" })).toBe("");
  expect(memberRole(app({ kind: "direct" }), { name: "Bob", sessionID: "bob" })).toBe("");
});

test("no room or member means no role", () => {
  expect(memberRole({ state: {} }, { name: "Alice", sessionID: "alice" })).toBe("");
  expect(memberRole(app(), null)).toBe("");
});