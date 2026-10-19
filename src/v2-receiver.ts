import { backgroundOwnSession, discoverVerifiedHost } from "./background";
import { receiverOwnerID } from "./receiver-owner";
import { loadRegistry } from "./store";
import { request, type CenterOpts } from "./center-client";
import type { QueueTransport } from "./queue-transport";

type Attachment = {
  sessions: ReadonlySet<string>;
  version: string;
  transport: QueueTransport;
  center: CenterOpts;
  poll(ids: ReadonlySet<string>, transport: QueueTransport, center: CenterOpts): Promise<void>;
};
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
    const primary = values.find((value) => attached.has(value));
    if (!primary) return;
    await pollWithMembershipFallback(async () => {
      const owned = new Set<string>();
      for (const value of values) {
        if (!attached.has(value)) continue;
        if (value.center.center) {
          const result = await request(value.center, `/receiver/memberships?ownerID=${encodeURIComponent(ownerID)}`, "GET") as { sessionIDs?: string[] };
          for (const id of result.sessionIDs ?? []) owned.add(id);
        } else {
          const registry = await loadRegistry();
          for (const entries of Object.values(registry)) for (const [id, entry] of Object.entries(entries)) {
            if (entry.protocol === "v2" && entry.receiverOwnerID === ownerID) owned.add(id);
          }
        }
      }
      return owned;
    }, async (owned) => {
      const observed = new Set(values.flatMap((item) => [...item.sessions]));
      const restored = new Set([...owned].filter((id) => !observed.has(id)));
      if (!attached.size) return;
      const target: QueueTransport = {
        ...primary.transport,
        directory: undefined,
        receiverOwnerID: ownerID,
        backgroundSession: (id) => backgroundOwnSession(id, primary.version),
        promptQueue: async (sessionID, id, text, delivery) => {
          const info = await host.client.server.info({ signal: AbortSignal.timeout(1500) });
          if (info.pid !== process.pid || info.version !== primary.version) throw Error("OpenCode service changed");
          return host.client.session.prompt({ sessionID, id, text, delivery, resume: true }, { signal: AbortSignal.timeout(1500) });
        },
        mentionOnlySessions: restored,
      };
      await pollOwnedSessions(owned, (ids) => attached.has(primary)
        ? primary.poll(ids, target, primary.center) : Promise.resolve());
    }, async (owned) => pollObserved(values, owned), async () => pollObserved(values, new Set()));
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

export async function pollWithMembershipFallback(
  memberships: () => Promise<Set<string>>,
  restore: (ids: Set<string>) => Promise<void>,
  observed: (ids: ReadonlySet<string>) => Promise<void>,
  onMembershipFailure: () => Promise<void>,
): Promise<void> {
  let ids: Set<string>;
  try { ids = await memberships(); }
  catch { await onMembershipFailure(); return; }
  try { if (ids.size) await restore(ids); } catch { /* Observed polling remains independent. */ }
  await observed(ids);
}

async function pollObserved(values: Attachment[], owned: ReadonlySet<string>): Promise<void> {
  const seen = new Set<string>();
  for (const value of values) {
    if (!attached.has(value)) continue;
    const local = new Set([...value.sessions].filter((id) => !owned.has(id) && !seen.has(id)));
    local.forEach((id) => seen.add(id));
    if (local.size) await value.poll(local, value.transport, value.center);
  }
}
