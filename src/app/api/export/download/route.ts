import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import type { ExportJobDoc } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/export/download?jobId=...
 *
 * Hands the finished MP4 to the browser as a DIRECT storage download — the
 * Next.js server NEVER proxies the video bytes (no Blob, no streaming through
 * here). We verify the caller owns the job and that it's ready, then mint a
 * short-lived V4 signed URL with `Content-Disposition: attachment` and either
 * 302-redirect to it or return it as JSON `{ url }`.
 *
 * Auth: a Firebase ID token via the `Authorization: Bearer` header (the app's
 * download button uses `fetch` + this header, then navigates to the returned
 * URL) OR a `?token=` query param (for a direct navigation). The signed URL
 * itself is the only capability handed out, and it expires in minutes.
 *
 * Signing note: on App Hosting with ADC the runtime SA needs
 * `iam.serviceAccountTokenCreator` on itself (signBlob). If signing fails we
 * fall back to the stored Firebase download URL (the object is uploaded with
 * `Content-Disposition: attachment`, so that URL downloads correctly too).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  const wantsJson =
    url.searchParams.get("format") === "json" ||
    (req.headers.get("accept") || "").includes("application/json");

  const authHeader = req.headers.get("authorization") || "";
  const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const idToken = headerToken || url.searchParams.get("token");

  const fail = (status: number, error: string) =>
    NextResponse.json({ error }, { status });

  if (!idToken) return fail(401, "Missing authentication.");
  if (!jobId) return fail(400, "Missing jobId.");

  const { auth, db, storage } = getAdmin();

  let uid: string;
  try {
    uid = (await auth.verifyIdToken(idToken)).uid;
  } catch {
    return fail(401, "Invalid token.");
  }

  // Ownership is enforced by the doc path (users/{uid}/...) AND a defensive
  // userId check — never serve another user's outputPath.
  const snap = await db.doc(`users/${uid}/exportJobs/${jobId}`).get();
  if (!snap.exists) return fail(404, "Export not found.");
  const job = snap.data() as ExportJobDoc;
  if (job.userId && job.userId !== uid) return fail(403, "Not your export.");
  if (job.status !== "ready") return fail(409, "Export is not ready yet.");
  if (!job.outputPath) return fail(404, "This export has no output file.");

  const filename = job.outputFilename || buildFilename(job.projectTitle);
  const contentType = job.outputContentType || "video/mp4";
  const bucketName =
    job.outputBucket || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || undefined;

  // Prefer a short-lived signed URL with Content-Disposition: attachment.
  let downloadUrl: string | null = null;
  try {
    const file = storage.bucket(bucketName).file(job.outputPath);
    const [signed] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes
      responseDisposition: `attachment; filename="${sanitizeHeader(filename)}"`,
      responseType: contentType,
    });
    downloadUrl = signed;
  } catch (err) {
    // Signing not available (SA lacks signBlob) → fall back to the stored Firebase
    // download URL. The object carries Content-Disposition: attachment, so that
    // URL still downloads directly with the right filename.
    console.error("[export-download] signed URL failed — falling back to stored URL", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    downloadUrl = job.downloadUrl ?? null;
  }

  if (!downloadUrl) {
    return fail(500, "Export is ready, but we couldn't start the download. Please try again.");
  }

  console.log("[export-download] handoff", { uid, jobId, mode: wantsJson ? "json" : "redirect", signed: !!downloadUrl });

  if (wantsJson) {
    return NextResponse.json({ url: downloadUrl, filename });
  }
  return NextResponse.redirect(downloadUrl, 302);
}

/** Fallback filename for jobs created before the worker wrote `outputFilename`. */
function buildFilename(projectTitle: string | undefined): string {
  const safe =
    (projectTitle || "video")
      .normalize("NFKD")
      .replace(/[^\w\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "video";
  const date = new Date().toISOString().slice(0, 10);
  return `Framevo-export-${safe}-${date}.mp4`;
}

/** Strip characters that can't safely sit inside a quoted header value. */
function sanitizeHeader(s: string): string {
  return s.replace(/["\\\r\n]+/g, "");
}
