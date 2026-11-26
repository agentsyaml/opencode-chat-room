import { DatabaseSync } from "node:sqlite";

export type ChannelAccountState = "started" | "failed" | "disabled" | "unknown";

/** Live state supplied by a running host; stats itself only reads SQLite. */
export interface ChannelAccountRuntime {
  state: ChannelAccountState;
  lastError?: string;
}

export interface ChannelAccountStats {
  account: string;
  state: ChannelAccountState;
  lastError?: string;
  queueDepth: number;
  oldestBacklogAt: number | null;
  unknown: number;
  retryable: number;
  rateLimited: number;
}

export interface ChannelStats {
  generatedAt: number;
  events: number;
  publishedResults: number;
  eventsWithoutDeliveries: number;
  deliveriesWithoutEvent: number;
  receiptsWithoutDelivery: number;
  deliveries: {
    total: number;
    pending: number;
    inFlight: number;
    retryable: number;
    rateLimited: number;
    paused: number;
    unknown: number;
    sent: number;
    failed: number;
  };
  queueDepth: number;
  oldestBacklogAt: number | null;
  oldestBacklogAgeMs: number | null;
  accounts: ChannelAccountStats[];
}

const REQUIRED_TABLES = ["channel_events", "channel_deliveries", "channel_receipts"];
const QUEUE_STATES = new Set(["pending", "retryable", "rate_limited"]);
const MAX_LAST_ERROR = 200;

type Row = Record<string, unknown>;

/** Keep status details short and free of credential-shaped fragments. */
export function sanitizeAccountError(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(secret|token|password|passwd|authorization|api[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redacted.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LAST_ERROR);
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Row;
  return Number(row.count);
}

function accountKey(target: string): string {
  const first = target.indexOf("/");
  if (first < 0) return target;
  const second = target.indexOf("/", first + 1);
  return second === -1 ? target : target.slice(0, second);
}

/**
 * Read queue and integrity counts without touching message content.
 * The database is opened read-only, so a missing state file is never created.
 */
export function readChannelStats(
  path: string,
  now = Date.now(),
  runtime: ReadonlyMap<string, ChannelAccountRuntime> = new Map(),
): ChannelStats {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");

    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) =>
        String(row.name)
      ),
    );
    if (REQUIRED_TABLES.some((table) => !names.has(table))) {
      throw new Error(`channel state not found: ${path}`);
    }

    const stateCounts: Record<string, number> = {};
    const accounts = new Map<string, ChannelAccountStats>();
    let oldestBacklogAt: number | null = null;
    const rows = db.prepare("SELECT target, state, created_at FROM channel_deliveries").all() as Row[];

    for (const row of rows) {
      const state = String(row.state);
      stateCounts[state] = (stateCounts[state] ?? 0) + 1;

      const key = accountKey(String(row.target));
      let account = accounts.get(key);
      if (!account) {
        account = {
          account: key,
          state: "unknown",
          queueDepth: 0,
          oldestBacklogAt: null,
          unknown: 0,
          retryable: 0,
          rateLimited: 0,
        };
        accounts.set(key, account);
      }
      if (state === "unknown") account.unknown += 1;
      if (state === "retryable") account.retryable += 1;
      if (state === "rate_limited") account.rateLimited += 1;
      if (QUEUE_STATES.has(state)) {
        const createdAt = Number(row.created_at);
        account.queueDepth += 1;
        if (account.oldestBacklogAt === null || createdAt < account.oldestBacklogAt) {
          account.oldestBacklogAt = createdAt;
        }
        if (oldestBacklogAt === null || createdAt < oldestBacklogAt) {
          oldestBacklogAt = createdAt;
        }
      }
    }

    // Runtime entries add configured accounts without deliveries and override
    // the SQLite-only default of "unknown" for a running host.
    for (const [key, live] of runtime) {
      const account = accounts.get(key) ?? {
        account: key,
        state: "unknown" as const,
        queueDepth: 0,
        oldestBacklogAt: null,
        unknown: 0,
        retryable: 0,
        rateLimited: 0,
      };
      account.state = live.state;
      const lastError = live.lastError ? sanitizeAccountError(live.lastError) : "";
      if (lastError) account.lastError = lastError;
      accounts.set(key, account);
    }

    const pending = stateCounts.pending ?? 0;
    const retryable = stateCounts.retryable ?? 0;
    const rateLimited = stateCounts.rate_limited ?? 0;
    const failed = (stateCounts.permanent ?? 0)
      + (stateCounts.unsupported ?? 0)
      + (stateCounts.exhausted ?? 0);

    return {
      generatedAt: now,
      events: count(db, "SELECT COUNT(*) AS count FROM channel_events"),
      publishedResults: count(
        db,
        "SELECT COUNT(*) AS count FROM channel_events WHERE json_extract(payload, '$.kind') = 'result.published'",
      ),
      eventsWithoutDeliveries: count(
        db,
        `SELECT COUNT(*) AS count FROM channel_events e
         WHERE json_extract(e.payload, '$.kind') IS NOT 'result.published'
           AND NOT EXISTS (SELECT 1 FROM channel_deliveries d WHERE d.event_id = e.event_id)`,
      ),
      deliveriesWithoutEvent: count(
        db,
        `SELECT COUNT(*) AS count FROM channel_deliveries d
         WHERE NOT EXISTS (SELECT 1 FROM channel_events e WHERE e.event_id = d.event_id)`,
      ),
      receiptsWithoutDelivery: count(
        db,
        `SELECT COUNT(*) AS count FROM channel_receipts r
         WHERE NOT EXISTS (SELECT 1 FROM channel_deliveries d WHERE d.delivery_id = r.delivery_id)`,
      ),
      deliveries: {
        total: rows.length,
        pending,
        inFlight: stateCounts.in_flight ?? 0,
        retryable,
        rateLimited,
        paused: stateCounts.paused ?? 0,
        unknown: stateCounts.unknown ?? 0,
        sent: stateCounts.sent ?? 0,
        failed,
      },
      queueDepth: pending + retryable + rateLimited,
      oldestBacklogAt,
      oldestBacklogAgeMs: oldestBacklogAt === null ? null : now - oldestBacklogAt,
      accounts: [...accounts.values()].sort((left, right) =>
        left.account < right.account ? -1 : left.account > right.account ? 1 : 0
      ),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("channel state not found:")) throw error;
    throw new Error(`channel state not found: ${path}`);
  } finally {
    try {
      db?.close();
    } catch {
      // Keep the original result or error.
    }
  }
}