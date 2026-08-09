/**
 * Where `/api/*` lives.
 *
 * On the web it is the same origin (a relative URL, exactly as before). In the
 * desktop app the renderer is served from a custom protocol with no server
 * behind it, so those routes must resolve to Framevo's real API origin —
 * `NEXT_PUBLIC_CLOUD_API_BASE`, baked into the desktop renderer build.
 *
 * This is the seam that keeps requirement "secrets stay on the server" true:
 * the desktop app never runs a local Next server and never holds a Gemini /
 * Firebase-Admin / Lemon Squeezy credential — it CALLS the deployed API with
 * the user's Firebase ID token, precisely like the website does.
 */

/** Configured cloud origin, or "" when the app is served from its own origin. */
export function apiBase(): string {
  const raw = process.env.NEXT_PUBLIC_CLOUD_API_BASE?.trim();
  if (!raw) return "";
  // A bad value must fail loudly at the call site, not silently produce
  // "undefined/api/…" requests.
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(
      `NEXT_PUBLIC_CLOUD_API_BASE must start with http(s):// — got "${raw}"`
    );
  }
  return raw.replace(/\/+$/, "");
}

/** Absolute (or same-origin relative) URL for an app API path. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${apiBase()}${suffix}`;
}

/**
 * `fetch` for Framevo's own API. Identical to `fetch` on the web; on desktop it
 * targets the configured cloud origin. Cross-origin requests must not carry
 * cookies (the API authenticates with a bearer ID token), so credentials stay
 * at the default "same-origin".
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}

/** True when API calls leave this origin (desktop) — used for offline messaging. */
export function apiIsRemote(): boolean {
  return apiBase() !== "";
}
