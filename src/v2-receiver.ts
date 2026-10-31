import { backgroundOwnSession, discoverVerifiedHost } from "./background";
import { createHash } from "node:crypto";
import { receiverOwnerID } from "./receiver-owner";
import { loadRegistry } from "./store";
import { request, type CenterOpts } from "./center-client";
import type { QueueTransport } from "./queue-transport";
import { locallyOwnedSessions, reportAgentPresence } from "./agent-presence";
import { flushReceiptCandidates, receiptDestination } from "./agent-receipts";

export type Attachment = {
  sessions: ReadonlySet<string>;
  version: string;
  transport: QueueTransport;
  center: CenterOpts;
  poll(ids: ReadonlySet<string>, transport: QueueTransport, center: CenterOpts): Promise<void>;
};
export function groupByCenter<T extends { center: CenterOpts }>(values: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const base = value.center.center ? new URL(value.center.center).href.replace(/\/+$/, "") : `local:${receiptDestination("")}`;
    const key = createHash("sha256").update(JSON.stringify([base, value.center.center ? value.center.token : ""])).digest("hex");
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
const attached = new Set<Attachment>();
let timer: ReturnType<typeof setInterval> | undefined;
let sweeping = false;

export function receiverState() { return { attachments: attached.size, timerRunning: timer !== undefined }; }

export function attachV2Receiver(value: Attachment): () => void {
  attached.add(value);
  if (!timer) timer = setInterval(() => void sweep(), 5000);
  return () => {
    attached.delete(value);
    if (!attached.size && timer) { clearInterval(timer); timer = undefined; }
  };
}

export async function pollAttachmentGroup(
  members: readonly Attachment[],
  memberships: (attachment: Attachment) => Promise<Set<string>>,
  restore: (owned: Set<string>, restored: Set<string>, attachment: Attachment) => Promise<void>,
): Promise<void> {
  const live = members.filter((member) => attached.has(member));
  const primary = live[0];
  if (!primary) return;
  let owned: Set<string>;
  try { owned = await memberships(primary); }
  catch { await pollObserved(members.filter((member) => attached.has(member)), new Set()); return; }
  const current = members.filter((member) => attached.has(member));
  const activePrimary = current[0];
  if (!activePrimary) return;
  const observed = new Set(current.flatMap((member) => [...member.sessions]));
  const restored = new Set([...owned].filter((id) => !observed.has(id)));
  try { await restore(owned, restored, activePrimary); } catch { /* Never redeliver owned sessions on restore failure. */ }
  await pollObserved(current, owned);
}

export async function pollAttachmentsByCenter(
  members: readonly Attachment[],
  memberships: (attachment: Attachment) => Promise<Set<string>>,
  restore: (owned: Set<string>, restored: Set<string>, attachment: Attachment) => Promise<void>,
): Promise<void> {
  await Promise.all([...groupByCenter(members).values()].map((group) => pollAttachmentGroup(group, memberships, restore)));
}

async function sweep(): Promise<void> {
  if (sweeping || !attached.size) return;
  sweeping = true;
  let values = [...attached];
  let observedPolled = false;
  try {
    values = [...attached];
    const host = await discoverVerifiedHost(values[0]!.version);
    if (!host) { await pollObserved(values, new Set()); observedPolled = true; return; }
    const ownerID = await receiverOwnerID(host.origin);
    if (!ownerID) { await pollObserved(values, new Set()); observedPolled = true; return; }
    await pollAttachmentsByCenter(values, async (attachment) => {
      if (attachment.center.center) {
        const result = await request(attachment.center, `/receiver/memberships?ownerID=${encodeURIComponent(ownerID)}`, "GET") as { sessionIDs?: string[] };
        return new Set(result.sessionIDs ?? []);
      }
      const registry = await loadRegistry();
      return locallyOwnedSessions(registry, ownerID);
    }, async (owned, restored, attachment) => {
      await reportAgentPresence({ host, ownerID, center: attachment.center, sessionIDs: owned,
        current: async () => {
          const current = await discoverVerifiedHost(attachment.version);
          if (!current || current.origin !== host.origin) return false;
          const info = await current.client.server.info({ signal: AbortSignal.timeout(1500) });
          return info.pid === process.pid && info.version === attachment.version;
        } });
      const target: QueueTransport = {
        ...attachment.transport, directory: undefined, receiverOwnerID: ownerID,
        backgroundSession: (id) => backgroundOwnSession(id, attachment.version),
        promptQueue: async (sessionID, id, text, delivery) => {
          const info = await host.client.server.info({ signal: AbortSignal.timeout(1500) });
          if (info.pid !== process.pid || info.version !== attachment.version) throw Error("OpenCode service changed");
          return host.client.session.prompt({ sessionID, id, text, delivery, resume: true }, { signal: AbortSignal.timeout(1500) });
        }, mentionOnlySessions: restored,
      };
      await pollOwnedSessions(owned, (ids) => attached.has(attachment)
        ? attachment.poll(ids, target, attachment.center) : Promise.resolve());
      if (!owned.size) await flushReceiptCandidates({ destination: receiptDestination(attachment.center.center), receiverOwnerID: ownerID,
        ...(attachment.center.center ? { center: attachment.center.center, token: attachment.center.token } : {}) }).catch(() => {});
    });
    observedPolled = true;
  } catch {
    if (!observedPolled) await pollObserved(values, new Set()).catch(() => {});
  } finally { sweeping = false; }
}

export async function pollOwnedSessions(
  ids: ReadonlySet<string>, poll: (ids: ReadonlySet<string>) => Promise<void>,
): Promise<void> {
  if (ids.size) await poll(ids);
}

async function pollObserved(values: Attachment[], owned: ReadonlySet<string>): Promise<void> {
  const seen = new Set<string>();
  for (const value of values) {
    if (!attached.has(value)) continue;
    const local = new Set([...value.sessions].filter((id) => !owned.has(id) && !seen.has(id)));
    local.forEach((id) => seen.add(id));
    if (local.size) await value.poll(local, value.transport, value.center).catch(() => {});
  }
}
