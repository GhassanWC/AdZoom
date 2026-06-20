import "server-only";

/**
 * EXPORT_BACKEND=dotnet cutover helpers. When the flag is "dotnet", the C# export
 * API (services/export-api-dotnet) runs jobs instead of the Node Cloud-Run worker.
 * Next.js still owns Firebase auth + plan + minute reservation + job CREATION
 * (the `/api/export/cloud` transaction is unchanged); these helpers only hand the
 * already-created job to the C# runner and proxy cancellation.
 *
 *   EXPORT_BACKEND          "dotnet" | "cloudtasks" (default cloudtasks → old worker)
 *   EXPORT_API_URL          base URL of the C# Cloud Run service
 *   EXPORT_API_INTERNAL_SECRET   shared secret sent as `X-Internal-Secret`
 *
 * The C# service is private (--no-allow-unauthenticated), so calls also carry a
 * Cloud Run identity token (audience = the service URL), minted from the
 * metadata server when running on GCP (App Hosting / Cloud Run). Locally the
 * metadata server is unreachable → no bearer (a local C# instance isn't gated).
 */

export function exportBackend(): "vm" | "dotnet" | "cloudtasks" {
  const b = (process.env.EXPORT_BACKEND ?? "cloudtasks").toLowerCase();
  // "vm"      → rendering runs on the GCE VM worker, which POLLS Firestore. Next.js
  //             only CREATES the job; there is no HTTP dispatch (the poller delivers).
  // "dotnet"  → the C# export API (Cloud Run) renders; we send a best-effort signal.
  // otherwise → the legacy Node Cloud-Run worker via Cloud Tasks.
  if (b === "vm") return "vm";
  if (b === "dotnet") return "dotnet";
  return "cloudtasks";
}

function apiBase(): string | null {
  const u = process.env.EXPORT_API_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

/** Cloud Run service-to-service ID token via the metadata server; null off-GCP. */
async function idToken(audience: string): Promise<string | null> {
  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) }
    );
    return res.ok ? (await res.text()).trim() : null;
  } catch {
    return null;
  }
}

async function authHeaders(base: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.EXPORT_API_INTERNAL_SECRET?.trim();
  if (secret) headers["X-Internal-Secret"] = secret;
  const token = await idToken(base);
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * Signal the C# runner to pick up an already-created queued job. BEST-EFFORT and
 * never throws — the C# runner POLLS Firestore for queued jobs, so this only
 * trims pickup latency. A missing config / failed call just falls back to the poll.
 */
export async function dotnetEnqueueSignal(uid: string, jobId: string): Promise<void> {
  const base = apiBase();
  if (!base || !process.env.EXPORT_API_INTERNAL_SECRET) {
    console.warn(
      "[export-enqueue] backend=dotnet but EXPORT_API_URL / EXPORT_API_INTERNAL_SECRET missing — relying on the C# poller",
      { jobId }
    );
    return;
  }
  try {
    const res = await fetch(`${base}/exports/enqueue`, {
      method: "POST",
      headers: await authHeaders(base),
      body: JSON.stringify({ uid, jobId }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[export-enqueue] backend=dotnet signal non-2xx (${res.status}) — poller will deliver`,
        { jobId, body: body.slice(0, 200) }
      );
      return;
    }
    console.log(`[export-enqueue] backend=dotnet signaled job=${jobId} status=${res.status}`);
  } catch (err) {
    console.warn("[export-enqueue] backend=dotnet signal failed — poller will deliver", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface DotnetCancelResult {
  ok: boolean;
  status: number;
  state?: string;
}

/**
 * Proxy cancel to the C# API (authoritative: it releases minutes + sets canceled,
 * and its runner kills the in-flight render). Returns null when not attempted
 * (config missing) so the caller falls back to the local cancel transaction.
 * Throws on network failure so the caller can fall back too.
 */
export async function dotnetCancel(uid: string, jobId: string): Promise<DotnetCancelResult | null> {
  const base = apiBase();
  if (!base || !process.env.EXPORT_API_INTERNAL_SECRET) return null;
  const res = await fetch(`${base}/exports/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: await authHeaders(base),
    body: JSON.stringify({ uid }),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json().catch(() => ({}))) as { state?: string };
  return { ok: res.ok, status: res.status, state: data?.state };
}
