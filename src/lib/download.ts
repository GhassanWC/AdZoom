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
