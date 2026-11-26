import { existsSync } from "node:fs";
import { PgDatabase } from "./pg-database.ts";
import { Database, type SQLQueryBindings } from "./sqlite.ts";
import { closeStateDatabases, initializeAdminSchema, initializeReminderSchema, openStateDatabase } from "./sqlite-state.ts";

// One-shot SQLite -> PostgreSQL copy. PostgreSQL support is experimental and
// single-instance in 0.8.1; the target connection holds the same session lock
// as the server, so a running server makes this command fail before writing.

export type MigrationOptions = {
  sourcePath: string;
  assumeYes?: boolean;
  log?: (line: string) => void;
};

export type MigrationReport = { tables: Array<{ table: string; rows: number }>; messages: number };

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function backupGuidance(sourcePath: string): string[] {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return [
    "PostgreSQL state is experimental and single-instance in 0.8.1.",
    "Stop the chat-room server before migrating; this command takes a SQLite write lock,",
    "but only --yes confirms that the server is actually stopped.",
    "",
    "Make a WAL-safe SQLite backup first (do not copy only chat-room.sqlite while WAL is active):",
    `  sqlite3 ${JSON.stringify(sourcePath)} ".backup '${sourcePath}.backup-${stamp}'"`,
    "",
    "Rollback: unset CHAT_ROOM_DATABASE_URL and start the old server again. Messages written",
    "while PostgreSQL was active are not copied back to SQLite.",
  ];
}

function orderTables(tables: string[], parents: Map<string, Set<string>>): string[] {
  const remaining = new Set(tables);
  const ordered: string[] = [];
  while (remaining.size) {
    let progressed = false;
    for (const table of [...remaining]) {
      const blockers = [...(parents.get(table) ?? [])].filter((parent) => parent !== table && remaining.has(parent));
      if (blockers.length) continue;
      ordered.push(table);
      remaining.delete(table);
      progressed = true;
    }
    if (!progressed) throw new Error(`cannot migrate: foreign key cycle among ${[...remaining].join(", ")}`);
  }
  return ordered;
}

function copyTable(
  source: Database,
  target: Awaited<ReturnType<typeof openStateDatabase>>,
  table: string,
  columns: string[],
): number {
  if (!columns.length) return 0;
  const batch = Math.max(1, Math.min(500, Math.floor(2_000 / columns.length)));
  const selection = columns.map(quote).join(",");
  const insert = `INSERT INTO ${quote(table)} (${selection}) VALUES `;
  let lastRowid = 0;
  let copied = 0;
  for (;;) {
    const rows = source.query(`SELECT rowid AS __rowid,${selection} FROM ${quote(table)} WHERE rowid>? ORDER BY rowid LIMIT ?`)
      .all(lastRowid, batch) as Array<Record<string, unknown>>;
    if (!rows.length) break;
    lastRowid = Number(rows[rows.length - 1]!.__rowid);
    const placeholders = `(${columns.map(() => "?").join(",")})`;
    const values: unknown[] = [];
    for (const row of rows) for (const column of columns) values.push(row[column]);
    target.query(`${insert}${Array.from({ length: rows.length }, () => placeholders).join(",")}`)
      .run(...(values as SQLQueryBindings[]));
    copied += rows.length;
  }
  return copied;
}

export async function migrateToPostgres(options: MigrationOptions): Promise<MigrationReport> {
  const log = options.log ?? console.log;
  const url = process.env.CHAT_ROOM_DATABASE_URL?.trim();
  if (!url) throw new Error("CHAT_ROOM_DATABASE_URL is required; point it at an empty PostgreSQL database");
  if (!existsSync(options.sourcePath)) throw new Error(`SQLite state database not found: ${options.sourcePath}`);
  for (const line of backupGuidance(options.sourcePath)) log(line);
  if (!options.assumeYes) throw new Error("refusing to migrate without --yes after stopping the server and making a backup");

  const source = new Database(options.sourcePath, { create: false });
  source.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  let report: MigrationReport | undefined;
  try {
    // Probe before any schema/administration migration can touch the target.
    const probe = new PgDatabase(url);
    try {
      const nonEmpty: string[] = [];
      const existing = probe.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()").all() as Array<{ table_name: string }>;
      for (const { table_name: table } of existing) {
        const count = Number((probe.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number }).count);
        if (count > 0) nonEmpty.push(`${table} (${count})`);
      }
      if (nonEmpty.length) throw new Error(`target database is not empty: ${nonEmpty.join(", ")}; migrate into a fresh database`);
    } finally {
      probe.close();
    }

    // Opening the PostgreSQL state database also acquires the process-wide
    // single-instance lock, so a running server blocks the migration here.
    const target = await openStateDatabase(options.sourcePath);
    await initializeAdminSchema(options.sourcePath);
    await initializeReminderSchema(options.sourcePath);
    target.exec("CREATE TABLE IF NOT EXISTS server_admin_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)");

    const targetColumns = new Map<string, Set<string>>();
    for (const row of target.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY ordinal_position")
      .all() as Array<{ table_name: string; column_name: string }>) {
      const columns = targetColumns.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      targetColumns.set(row.table_name, columns);
    }

    // Keep one read snapshot and stop SQLite writers for the duration of the copy.
    source.transaction(() => {
      const tables = (source.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
        .map((row) => row.name);
      const parents = new Map<string, Set<string>>();
      for (const table of tables) {
        const rows = source.query(`PRAGMA foreign_key_list(${quote(table)})`).all() as Array<{ table: string }>;
        parents.set(table, new Set(rows.map((row) => row.table).filter((parent) => tables.includes(parent))));
      }
      const ordered = orderTables(tables, parents);

      const counts = new Map<string, number>();
      for (const table of tables) counts.set(table, Number((source.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number }).count));
      const copied: Array<{ table: string; rows: number }> = [];

      target.transaction(() => {
        for (const table of ordered) {
          const available = targetColumns.get(table);
          if (!available) {
            log(`  skip ${table}: table does not exist in PostgreSQL`);
            continue;
          }
          const sourceColumns = (source.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map((row) => row.name);
          const columns = sourceColumns.filter((column) => available.has(column));
          if (columns.length !== sourceColumns.length) {
            log(`  ${table}: ignoring source-only columns ${sourceColumns.filter((column) => !available.has(column)).join(", ")}`);
          }
          const rows = copyTable(source, target, table, columns);
          copied.push({ table, rows });
          log(`  ${table}: ${rows} rows`);
        }

        // Explicit seq values bypass the identity sequence; move it past the
        // largest copied value so the next insert continues the history.
        target.query("SELECT setval(pg_get_serial_sequence('messages','seq'),COALESCE(MAX(seq),0)+1,false) AS value FROM messages").get();

        for (const { table, rows } of copied) {
          const expected = counts.get(table) ?? 0;
          const actual = Number((target.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number }).count);
          if (actual !== expected || rows !== expected) {
            throw new Error(`row count mismatch for ${table}: source ${expected}, copied ${rows}, target ${actual}`);
          }
        }
        return copied;
      }).immediate();

      report = { tables: copied, messages: counts.get("messages") ?? 0 };
    }).immediate();
  } finally {
    source.close();
    await closeStateDatabases();
  }
  if (!report) throw new Error("migration did not complete");
  log(`migrated ${report.messages} messages across ${report.tables.length} tables`);
  return report;
}