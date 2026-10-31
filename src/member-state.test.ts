import { expect, test } from "bun:test";
import { memberActivity, presenceOwnerMatches, receiptOwnerMatches, PRESENCE_TTL_MS } from "./member-state";

test("presence reports distinguish unknown, fresh, stale, and owner scopes", () => {
  const base = { serverUrl: "", apiPrefix: "/api", name: "agent" };
  expect(memberActivity(base, 10)).toEqual({ state: "unknown", observedAt: null });
  expect(memberActivity({ ...base, lastSeenAt: 1, workState: "idle" }, 1 + PRESENCE_TTL_MS - 1)).toEqual({ state: "idle", observedAt: 1 });
  expect(memberActivity({ ...base, lastSeenAt: 1, workState: "working" }, 1 + PRESENCE_TTL_MS)).toEqual({ state: "offline", observedAt: 1 });
  expect(presenceOwnerMatches({ protocol: "v2", receiverOwnerID: "owner-a" } as any, "owner-a")).toBe(true);
  expect(presenceOwnerMatches({ protocol: "v2", receiverOwnerID: "owner-a" } as any, "owner-b")).toBe(false);
  expect(presenceOwnerMatches({ protocol: "v1" } as any)).toBe(true);
  expect(presenceOwnerMatches({ protocol: undefined, serverUrl: "http://local" } as any)).toBe(true);
  expect(presenceOwnerMatches({ protocol: undefined, serverUrl: "" } as any)).toBe(false);
  expect(presenceOwnerMatches({ protocol: "v1" } as any, "owner-a")).toBe(false);
  expect(receiptOwnerMatches({ protocol: "v2" } as any)).toBe(true);
  expect(receiptOwnerMatches({ protocol: "v2" } as any, "owner-a")).toBe(false);
  expect(receiptOwnerMatches({ protocol: "v2", receiverOwnerID: "owner-a" } as any, "owner-a")).toBe(true);
  expect(receiptOwnerMatches({ protocol: "v2", receiverOwnerID: "owner-a" } as any, "owner-b")).toBe(false);
  expect(receiptOwnerMatches({ protocol: "v2", receiverOwnerID: "owner-a" } as any)).toBe(false);
  expect(receiptOwnerMatches({ protocol: "v1", receiverOwnerID: "owner-a" } as any, "owner-a")).toBe(false);
});
