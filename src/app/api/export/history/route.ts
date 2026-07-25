import { NextResponse, type NextRequest } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/export/history
 *
 * Records an IN-BROWSER (editframe) export in the user's `exports` collection so
 * it shows up in Export history like any other render. The client can't write
 * that collection directly (Firestore rules forbid client creates), so it logs
 * through here — the Admin SDK write bypasses the rule, scoped strictly to the
 * authenticated user's own subcollection.
 *
 * This is an AUDIT record only: it touches no usage/minutes/billing. In-browser
 * renders aren't stored (`stored: false`) — the file downloads at completion —
 * so the row shows the activity but offers no re-download.
 *
 * Idempotent: the client sends a stable `exportId` and `startedAt`; start and
 * terminal calls merge into the SAME doc.
 */

const STATUSES = new Set(["exporting", "ready", "failed", "canceled"]);
const ENGINES = new Set(["editframe", "browser"]);

interface Body {
  exportId?: string;
  startedAt?: number;
  projectId?: string;
  projectTitle?: string;
  status?: string;
  engine?: string;
  container?: string;
  resolution?: string;
  fps?: number;
  outputWidth?: number;
  outputHeight?: number;
  errorMessage?: string;
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const { auth, db } = getAdmin();
    let uid: string;
    try {
      uid = (await auth.verifyIdToken(idToken)).uid;
    } catch (err) {
      console.error("[export-history] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const b = (await req.json().catch(() => ({}))) as Body;
    const exportId = typeof b.exportId === "string" ? b.exportId : null;
    const status = typeof b.status === "string" ? b.status : null;
    if (!exportId || !status || !STATUSES.has(status)) {
      return NextResponse.json(
        { error: "Body must include { exportId, status } with a valid status." },
        { status: 400 }
      );
    }
    // Doc ids can't contain "/". Keep the write scoped to this user regardless.
    if (exportId.includes("/")) {
      return NextResponse.json({ error: "Invalid exportId" }, { status: 400 });
    }

    const engine = b.engine && ENGINES.has(b.engine) ? b.engine : "editframe";
    const container = b.container === "webm" ? "webm" : "mp4";
    const terminal = status !== "exporting";
    const startedAt =
      typeof b.startedAt === "number" && Number.isFinite(b.startedAt) ? b.startedAt : Date.now();

    const doc: Record<string, unknown> = {
      projectId: typeof b.projectId === "string" ? b.projectId : "",
      projectTitle: typeof b.projectTitle === "string" ? b.projectTitle : "Untitled",
      engine,
      stored: false,
      container,
      format: container.toUpperCase(),
      resolution: b.resolution === "720p" || b.resolution === "1080p" ? b.resolution : "1080p",
      fps: b.fps === 60 ? 60 : 30,
      status,
      // Stable across the start + terminal calls (client sends the same value),
      // so merging never rewrites the row's position in the history sort.
      createdAt: Timestamp.fromMillis(startedAt),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (typeof b.outputWidth === "number") doc.outputWidth = Math.round(b.outputWidth);
    if (typeof b.outputHeight === "number") doc.outputHeight = Math.round(b.outputHeight);
    if (terminal) doc.completedAt = FieldValue.serverTimestamp();
    if (status === "failed" && typeof b.errorMessage === "string") {
      doc.errorMessage = b.errorMessage.slice(0, 500);
    }

    await db.doc(`users/${uid}/exports/${exportId}`).set(doc, { merge: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[export-history] failed", err);
    return NextResponse.json({ error: "Failed to record export." }, { status: 500 });
  }
}
