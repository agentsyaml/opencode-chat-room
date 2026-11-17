import { expect, test } from "bun:test";
import { canRemoveMember } from "../../server/assets/chat/admin-badge.js";

const app = (myName: string, extra: Record<string, unknown> = {}) => ({
  state: { myName, room: { kind: "group", ownerId: "Alice", adminIds: ["Bob"], adminSessionID: "agent-admin", ...extra } },
});
const alice = { name: "Alice" }, bob = { name: "Bob" }, carol = { name: "Carol" };

test("human administrators remove members but never the owner", () => {
  expect(canRemoveMember(app("Bob"), carol, false, "bob-session")).toBe(true);
  expect(canRemoveMember(app("Bob"), bob, false, "bob-session")).toBe(true);
  expect(canRemoveMember(app("Bob"), alice, false, "bob-session")).toBe(false);
  expect(canRemoveMember(app("Bob", { kind: "direct" }), carol, false, "bob-session")).toBe(false);
  expect(canRemoveMember(app("Carol"), bob, false, "carol-session")).toBe(false);
});

test("the designated agent administrator removes ordinary members only", () => {
  expect(canRemoveMember(app("Agent"), carol, true, "agent-admin")).toBe(true);
  expect(canRemoveMember(app("Agent"), bob, true, "agent-admin")).toBe(false);
  expect(canRemoveMember(app("Agent"), alice, true, "agent-admin")).toBe(false);
  expect(canRemoveMember(app("Agent"), carol, true, "agent-other")).toBe(false);
  // An agent whose name matches a human administrator is still limited as an agent.
  expect(canRemoveMember(app("Bob"), carol, true, "agent-admin")).toBe(true);
  expect(canRemoveMember(app("Bob"), bob, true, "agent-admin")).toBe(false);
});