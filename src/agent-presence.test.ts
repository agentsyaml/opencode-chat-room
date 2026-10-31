import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const prior = process.env.XDG_STATE_HOME;
const stateHome = mkdtempSync(path.join(tmpdir(), "agent-presence-"));
process.env.XDG_STATE_HOME = stateHome;
const { locallyOwnedSessions, reportAgentPresence } = await import("./agent-presence");
const center = { center: "http://presence.invalid", token: "" };
const ownerID = () => crypto.randomUUID();
const host = (active: () => Promise<unknown>) => ({ client: { session: { active } } });
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (prior === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prior;
  rmSync(stateHome, { recursive: true, force: true });
});

test("local heartbeat selection excludes unowned and non-V2 registry entries", () => {
  const entry = (owner: string, protocol: "v1" | "v2") => ({ serverUrl: "", apiPrefix: "", name: "agent", protocol, receiverOwnerID: owner });
  const registry = { room: { owned: entry("owner", "v2"), other: entry("other", "v2"), legacy: entry("owner", "v1") } };
  expect([...locallyOwnedSessions(registry, "owner")]).toEqual(["owned"]);
});

test("reports working and idle from active map, unknown on API failure; upload failure is harmless", async () => {
  const bodies: Array<{ sessions: Array<{ sessionID: string; state: string }> }> = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const current = async () => true;
  await reportAgentPresence({ host: host(async () => ({ busy: { type: "running" } })), ownerID: ownerID(), center, sessionIDs: new Set(["busy", "idle"]), current });
  await reportAgentPresence({ host: host(async () => { throw new Error("offline"); }), ownerID: ownerID(), center, sessionIDs: new Set(["unknown"]), current });
  await reportAgentPresence({ host: host(async () => []), ownerID: ownerID(), center, sessionIDs: new Set(["malformed"]), current });
  expect(bodies.map((body) => body.sessions.map((session) => session.state))).toEqual([["working", "idle"], ["unknown"], ["unknown"]]);
});

test("splits reports into backend-sized batches with independent sequences", async () => {
  const batches: Array<{ sequence: number; sessions: unknown[] }> = [];
  globalThis.fetch = (async (_url, init) => { batches.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }) as typeof fetch;
  await reportAgentPresence({ host: host(async () => ({})), ownerID: ownerID(), center, sessionIDs: new Set(Array.from({ length: 201 }, (_, i) => `s${i}`)), current: async () => true });
  expect(batches.map(({ sequence, sessions }) => [sequence, sessions.length])).toEqual([[1, 200], [2, 1]]);
});

test("a superseded slow reporter cannot upload after lease expiry", async () => {
  const savedNow = Date.now;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let finishFirst!: (value: unknown) => void;
  const slow = new Promise<unknown>((resolve) => { finishFirst = resolve; });
  const payloads: Array<{ sequence: number }> = [];
  globalThis.fetch = (async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }) as typeof fetch;
  const owner = ownerID();
  let calls = 0;
  const active = () => ++calls === 1 ? (started(), slow) : Promise.resolve({});
  try {
    const a = reportAgentPresence({ host: host(active), ownerID: owner, center, sessionIDs: new Set(["s"]), current: async () => true });
    await startedPromise;
    Date.now = () => savedNow() + 21_000;
    await reportAgentPresence({ host: host(active), ownerID: owner, center, sessionIDs: new Set(["s"]), current: async () => true });
    finishFirst({});
    await a;
    expect(payloads.map((payload) => payload.sequence)).toEqual([2]);
  } finally { Date.now = savedNow; }
});
