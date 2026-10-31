import { randomUUID } from "node:crypto";
import { reportPresence, type PresenceReport, type Registry } from "./store";
import { claimPresenceReport, nextPresenceSequence, acquireDeliveryLease, ownsDeliveryLease, releaseDeliveryLease } from "./receiver-state";

const LEASE_MS = 20_000;
const REPORT_MS = 10_000;
const TIMEOUT_MS = 3_000;
type Center = { center: string; token: string };
type Host = { client: { session: { active(options?: { signal?: AbortSignal }): Promise<unknown> } } };

export function locallyOwnedSessions(registry: Registry, ownerID: string): Set<string> {
  return new Set(Object.values(registry).flatMap((entries) => Object.entries(entries)
    .filter(([, entry]) => entry.protocol === "v2" && entry.receiverOwnerID === ownerID).map(([id]) => id)));
}

export async function reportAgentPresence(input: {
  host: Host;
  ownerID: string;
  center: Center;
  sessionIDs: ReadonlySet<string>;
  current(): Promise<boolean>;
}): Promise<void> {
  const ids = [...new Set(input.sessionIDs)];
  if (!ids.length) return;
  const target = input.center.center ? new URL(input.center.center).origin : "standalone";
  const key = `presence:${input.ownerID}:${target}`;
  const holder = randomUUID();
  const now = Date.now();
  try {
    if (!acquireDeliveryLease(key, holder, now, now + LEASE_MS)) return;
    try {
      if (!claimPresenceReport(input.ownerID, target, now, REPORT_MS)) return;
      const batches = Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) => ids.slice(i * 200, (i + 1) * 200));
      const sequences = batches.map(() => nextPresenceSequence(input.ownerID));
      let active: Record<string, unknown> | undefined;
      try {
        const value = await input.host.client.session.active({ signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (value && typeof value === "object" && !Array.isArray(value) &&
          Object.values(value).every((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "running")) {
          active = value as Record<string, unknown>;
        }
      } catch { /* Unknown is safer than claiming idle when the host API is unavailable. */ }
      const state = (id: string) => active ? Object.hasOwn(active, id) ? "working" : "idle" : "unknown";
      for (let i = 0; i < batches.length; i++) {
        if (!ownsDeliveryLease(key, holder, Date.now()) || !await input.current()) return;
        const sessions = batches[i]!.map((sessionID) => ({ sessionID, receiverOwnerID: input.ownerID, state: state(sessionID) }));
        if (input.center.center) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (input.center.token) headers.Authorization = `Bearer ${input.center.token}`;
          await fetch(`${input.center.center}/presence`, {
            method: "POST", headers,
            body: JSON.stringify({ ownerID: input.ownerID, sequence: sequences[i], sessions }), signal: AbortSignal.timeout(TIMEOUT_MS),
          }).then((response) => { if (!response.ok) throw new Error(`presence ${response.status}`); }).catch(() => {});
        } else {
          await reportPresence(sessions as PresenceReport[], input.ownerID, sequences[i]).catch(() => {});
        }
      }
    } finally { releaseDeliveryLease(key, holder); }
  } catch { /* Presence must never interrupt message delivery. */ }
}
