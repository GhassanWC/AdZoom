import "server-only";

/**
 * One wrapper every `/api/admin/*` GET route goes through.
 *
 * It guarantees three things that were previously re-implemented (and
 * occasionally forgotten) per route:
 *
 *  1. `requireAdmin` runs BEFORE any Firestore read. Not "before returning" —
 *     before reading, so an unauthorized caller can never cause a data access.
 *  2. A missing index becomes a friendly HTTP 200 `{ indexBuilding: true }`
 *     instead of a 500, because a newly deployed composite index takes minutes
 *     to build and the dashboard should say so.
 *  3. Failures are logged with the route label and the error MESSAGE only, and
 *     the client gets a generic string. Firestore errors can quote document
 *     paths (`users/<uid>/exports/<id>`) and field values, so echoing them to
 *     the browser would leak user identifiers into the admin UI and any log
 *     drain in front of it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, type AdminIdentity } from "./auth";
import { isIndexError } from "./scan";

export type AdminHandler<T> = (
  req: NextRequest,
  admin: AdminIdentity
) => Promise<T>;

/**
 * Wrap an admin route body. `label` appears in server logs (e.g. "exports")
 * and must never contain user data.
 */
export function adminRoute<T extends object>(label: string, handler: AdminHandler<T>) {
  return async function GET(req: NextRequest): Promise<NextResponse> {
    const admin = await requireAdmin(req);
    // `requireAdmin` returns a ready 401/403 response when the caller is not an
    // admin. Returning it here means no handler body — and so no Firestore
    // read — ever runs for an unauthorized caller.
    if (admin instanceof NextResponse) return admin;

    try {
      const data = await handler(req, admin);
      return NextResponse.json(data);
    } catch (err) {
      if (isIndexError(err)) {
        // Surface the index URL to the SERVER log only — it is safe (no user
        // data) and it is what an operator needs to create the index.
        console.warn(
          `[admin/${label}] index missing or building:`,
          err instanceof Error ? err.message : String(err)
        );
        return NextResponse.json({ indexBuilding: true }, { status: 200 });
      }
      console.error(
        `[admin/${label}] request failed:`,
        err instanceof Error ? err.message : "unknown error"
      );
      return NextResponse.json(
        { error: `Failed to load ${label}. Check server logs for details.` },
        { status: 500 }
      );
    }
  };
}
