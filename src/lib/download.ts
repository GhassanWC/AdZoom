/**
 * Force a real file download for a (possibly cross-origin) URL.
 *
 * An `<a download>` only triggers a download for SAME-ORIGIN URLs — for a
 * cross-origin one (e.g. a Firebase Storage `firebasestorage.googleapis.com`
 * URL) the browser ignores `download` and just previews the file in a new tab.
 * So we fetch the bytes and save them via an object URL. Falls back to opening
 * the URL in a new tab only if the fetch is blocked (e.g. a CORS hiccup).
 *
 * Requires the Storage bucket's CORS to allow this origin (already configured —
 * `npm run deploy:cors:*`).
 */
/**
 * Hand a finished CLOUD export to the browser as a DIRECT storage download.
 *
 * Calls the secure `/api/export/download` route (tiny JSON response — NOT the
 * video bytes), which verifies ownership and returns a short-lived signed URL
 * with `Content-Disposition: attachment`. We then navigate to that URL, so the
 * browser downloads straight from storage. No Blob, no in-memory video, no
 * proxying through Next.js — fast even for large MP4s.
 *
 * Throws on any failure so the caller can surface a clear "couldn't start the
 * download" message.
 */
export async function startServerDownload(jobId: string, idToken: string): Promise<void> {
  const res = await fetch(
    `/api/export/download?jobId=${encodeURIComponent(jobId)}&format=json`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `download_failed_${res.status}`);
  }
  const { url } = (await res.json()) as { url?: string };
  if (!url) throw new Error("download_no_url");
  // Direct download from storage — the page stays; the file downloads.
  window.location.href = url;
}

export async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
  } catch {
    window.open(url, "_blank", "noreferrer");
  }
}
