import { expect, test } from "bun:test";
import { explicitlyAddresses, explicitlyMentions } from "./mentions";
import type { QueueItem } from "./queue";

const item = (id: string | undefined, text: string): QueueItem => ({ id, senderId: "system", text, createdAt: 1 });

test("only reminder system messages support explicit mentions", () => {
  expect(explicitlyMentions(item("ordinary", "@Alice"), "Alice")).toBe(false);
  expect(explicitlyMentions(item("reminder:123", "@Alice"), "Alice")).toBe(true);
  expect(explicitlyMentions(item("reminder:123", "@all"), "Alice")).toBe(true);
  expect(explicitlyAddresses(item("reminder:123", "Reminder without a name"), "Alice", "alice", "direct")).toBe(false);
  expect(explicitlyAddresses(item("reminder:123", "@Alice"), "Alice", "alice", "direct")).toBe(true);
  expect(explicitlyAddresses(item("reminder:123", "@all"), "Alice", "alice", "direct")).toBe(true);
  expect(explicitlyAddresses(item("ordinary", "@Alice"), "Alice", "alice", "direct")).toBe(false);
});
