/**
 * Migrations.
 *
 * Drizzle's own `migrate()` helpers are driver-specific and the proxy driver
 * has no bundled runner, so this is the minimal correct thing: apply the
 * ordered SQL files from ./migrations exactly once each, inside a transaction,
 * recording what ran in `_migrations`.
 *
 * The SQL is GENERATED from schema.ts (`npm run db:generate` → drizzle-kit) —
 * never hand-edit an already-applied file, add a new one.
 */
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

export interface MigrationResult {
  applied: string[];
  alreadyCurrent: number;
}

/**
 * `resolveFile` turns a migration's file name into its contents. It is injected
 * so the packaged app can read from its resources directory while tests read
 * from disk — and so the bundler doesn't need to resolve paths at build time.
 */
export function runMigrations(
  raw: DatabaseSync,
  resolveFile: (name: string) => string
): MigrationResult {
  raw.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`
  );
  const done = new Set(
    (raw.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name)
  );

  const applied: string[] = [];
  for (const name of MIGRATIONS) {
    if (done.has(name)) continue;
    const sql = resolveFile(name);
    raw.exec("BEGIN");
    try {
      raw.exec(sql);
      raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
        name,
        Date.now()
      );
      raw.exec("COMMIT");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(err as Error).message}`);
    }
    applied.push(name);
  }
  return { applied, alreadyCurrent: done.size };
}

/** Read migration SQL from a directory (the default resolver). */
export function fileResolver(dir: string): (name: string) => string {
  return (name) => readFileSync(`${dir}/${name}`, "utf8");
}
