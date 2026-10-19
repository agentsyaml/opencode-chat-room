import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { acquireDeliveryLease, ownsDeliveryLease, releaseDeliveryLease, renewDeliveryLease } from "./receiver-state";

const LEASE_MS = 15_000;
const active = new AsyncLocalStorage<{ sessionID: string; holder: string; lost: boolean }>();
const queues = new Map<string, Promise<unknown>>();

async function withLease<T>(sessionID: string, task: () => Promise<T>): Promise<T | undefined> {
  const holder = randomUUID();
  const now = Date.now();
  if (!acquireDeliveryLease(sessionID, holder, now, now + LEASE_MS)) return undefined;
  const lease = { sessionID, holder, lost: false };
  const timer = setInterval(() => {
    if (lease.lost) return;
    const at = Date.now();
    try {
      if (!renewDeliveryLease(sessionID, holder, at, at + LEASE_MS)) lease.lost = true;
    } catch {
      lease.lost = true;
    }
    if (lease.lost) clearInterval(timer);
  }, LEASE_MS / 3);
  timer.unref?.();
  try { return await active.run(lease, task); }
  finally {
    lease.lost = true;
    clearInterval(timer);
    try { releaseDeliveryLease(sessionID, holder); } catch { /* Expiry lets another process reclaim a locked row. */ }
  }
}

export function assertDeliveryLease(): void {
  const lease = active.getStore();
  if (!lease) return;
  if (lease.lost) throw new Error("session delivery lease was lost");
  try {
    if (ownsDeliveryLease(lease.sessionID, lease.holder, Date.now())) return;
  } catch { lease.lost = true; }
  lease.lost = true;
  throw new Error("session delivery lease was lost");
}

export function serializeSessionPush<T>(sessionID: string, task: () => Promise<T>): Promise<T | undefined> {
  const previous = queues.get(sessionID) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => withLease(sessionID, task));
  let current: Promise<T | undefined>;
  current = run.finally(() => { if (queues.get(sessionID) === current) queues.delete(sessionID); });
  queues.set(sessionID, current);
  return current;
}
