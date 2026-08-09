/**
 * The local database: Drizzle ORM over Node's built-in `node:sqlite`.
 *
 * Why the proxy driver instead of better-sqlite3: `node:sqlite` ships INSIDE
 * the Electron runtime (Node 24), so the app has ZERO native modules to compile
 * or rebuild per Electron version — no node-gyp, no Visual Studio/Python on a
 * contributor's machine, and nothing to go wrong at packaging time. Drizzle's
 * official `sqlite-proxy` driver is designed for exactly this: it hands us the
 * generated SQL and expects positional rows back, which `StatementSync` returns
 * natively via `setReturnArrays(true)`.
 *
 * Everything is synchronous under the hood (SQLite is), so a query can never
 * interleave with another write — the callbacks are simply wrapped in promises
 * for Drizzle's async API.
 */
import { DatabaseSync } from "node:sqlite";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

export type LocalDb = SqliteRemoteDatabase<typeof schema>;

export interface DbHandle {
  db: LocalDb;
  /** The raw connection — used for migrations and PRAGMA setup only. */
  raw: DatabaseSync;
  close(): void;
}

/**
 * Open (or create) the library database at `file`.
 *
 * WAL + NORMAL synchronous is the right trade for a desktop editor: autosaves
 * are frequent and small, and a crash can lose at most the last in-flight
 * transaction — which the recovery snapshot already covers.
 */
export function openDatabase(file: string): DbHandle {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");

  const db = drizzle(
    async (sql, params, method) => {
      const statement = raw.prepare(sql);
      if (method === "run") {
        statement.run(...(params as never[]));
        return { rows: [] };
      }
      // Positional rows — exactly what the proxy driver maps onto the schema.
      statement.setReturnArrays(true);
      const rows = statement.all(...(params as never[])) as unknown as unknown[][];
      if (method === "get") return { rows: rows[0] ?? [] };
      return { rows };
    },
    { schema }
  );

  return {
    db,
    raw,
    close() {
      try {
        raw.close();
      } catch {
        /* already closed */
      }
    },
  };
}
