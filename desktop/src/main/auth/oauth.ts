/**
 * Google's "OAuth 2.0 for Mobile & Desktop Apps" flow, as pure functions.
 *
 * WHY THIS SHAPE, and not `signInWithPopup`:
 *   • Google refuses to render its sign-in page inside an embedded user agent
 *     (`disallowed_useragent`), and rightly so — a desktop app that draws its
 *     own Google login is indistinguishable from one that harvests passwords.
 *     The user must type their password into their OWN browser, where the
 *     address bar and their password manager can vouch for the origin.
 *   • Desktop clients cannot keep a secret, so the authorization code is bound
 *     to this process with PKCE (RFC 7636): the code is worthless without the
 *     verifier, which never leaves the machine.
 *   • The redirect is a loopback listener on 127.0.0.1 (RFC 8252 §7.3). Google
 *     deprecated custom-scheme redirects for desktop clients, so loopback is
 *     the supported callback — a `framevo://` redirect would simply be rejected
 *     at the authorization endpoint.
 *   • The code→token exchange is NOT done here. It happens on Framevo's own
 *     server, which already holds server-side credentials. Nothing in the
 *     Electron bundle is a secret.
 *
 * Everything in this file is deterministic given its inputs (randomness and I/O
 * are injected), which is what makes the security-critical parts — state
 * comparison, PKCE derivation, callback parsing — unit-testable in plain Node.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
/** openid+email+profile is all Framevo needs; it never asks for Drive/Gmail. */
export const GOOGLE_SCOPES = ["openid", "email", "profile"] as const;

/** Framevo's confidential half of the exchange, relative to the API origin. */
export const EXCHANGE_PATH = "/api/auth/desktop/exchange";

/** Is the configured API a server on this machine (i.e. a dev run)? */
export function isLoopbackApi(apiBaseUrl: string): boolean {
  try {
    const { hostname } = new URL(apiBaseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Every address the exchange endpoint might answer on, best first.
 *
 * The second candidate exists because of a trap that costs an afternoon: Node
 * resolves `localhost` to ::1 BEFORE 127.0.0.1 on Windows, while a Next dev
 * server commonly binds IPv4 only. The server is then up, reachable from the
 * browser, and refuses this process alone — which reads exactly like "no
 * server", except it isn't. Trying the IPv4 twin costs one connection.
 */
export function exchangeEndpoints(apiBaseUrl: string): string[] {
  const base = apiBaseUrl.trim().replace(/\/+$/, "");
  const endpoints = [`${base}${EXCHANGE_PATH}`];
  try {
    const url = new URL(base);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      endpoints.push(`${url.toString().replace(/\/+$/, "")}${EXCHANGE_PATH}`);
    }
  } catch {
    // A malformed base fails at fetch time with the same message it deserves.
  }
  return endpoints;
}

/**
 * What to say when nothing answers.
 *
 * "Check your connection" is a lie in a development build: the connection is
 * fine, the repo's own web server simply isn't running. Say which, and name the
 * address, because the fix differs completely between the two cases.
 */
export function unreachableMessage(apiBaseUrl: string): string {
  const where = apiBaseUrl.trim().replace(/\/+$/, "") || "its sign-in service";
  return isLoopbackApi(apiBaseUrl)
    ? `Framevo's sign-in service isn't running at ${where}. ` +
        `Start the Framevo web app (npm run dev in the repo root) and try again.`
    : `Framevo couldn't reach its sign-in service at ${where}. Check your connection.`;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** base64url without padding — what RFC 7636 requires. */
export function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes → a 43-character verifier, the RFC's recommended length. */
export function createPkcePair(random: (n: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64Url(random(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function createState(random: (n: number) => Buffer = randomBytes): string {
  return base64Url(random(24));
}

export interface AuthUrlInput {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  /** Pre-fill the account chooser when we know who signed in last. */
  loginHint?: string;
}

export function buildAuthUrl(input: AuthUrlInput): string {
  if (!input.clientId) {
    throw new Error("No Google desktop client id is configured for this build.");
  }
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  // Always show the chooser: a desktop app is frequently shared, and silently
  // reusing whichever Google session the browser happens to hold is a
  // "signed in as the wrong person" bug the user cannot see coming.
  url.searchParams.set("prompt", "select_account");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

/**
 * Constant-time compare, safe on differing lengths.
 *
 * An EMPTY state never matches, even against another empty one: "neither side
 * has a state" must not read as "the states agree", or a callback that simply
 * omitted `state` would sail past the CSRF check.
 */
export function statesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; message: string };

/**
 * Parse the browser's hit on the loopback listener.
 *
 * The state check is the CSRF guard: without it, any page the user visits could
 * fetch `http://127.0.0.1:<port>/?code=…` and graft an attacker's authorization
 * code onto this session.
 */
export function parseCallback(rawUrl: string, expectedState: string): CallbackResult {
  let url: URL;
  try {
    // The listener hands us a path-only request target.
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return { ok: false, message: "That sign-in response could not be read." };
  }

  const error = url.searchParams.get("error");
  if (error) {
    return {
      ok: false,
      message:
        error === "access_denied"
          ? "Sign-in was cancelled."
          : "Google could not complete sign-in.",
    };
  }

  const state = url.searchParams.get("state") ?? "";
  if (!expectedState || !statesMatch(state, expectedState)) {
    return { ok: false, message: "That sign-in response did not match this request." };
  }

  const code = url.searchParams.get("code") ?? "";
  // Google's codes are opaque; bound the length and charset so nothing wild
  // reaches the exchange request.
  if (!code || code.length > 2048 || /[\s"'<>]/.test(code)) {
    return { ok: false, message: "Google did not return a valid sign-in code." };
  }
  return { ok: true, code };
}

/** Shape of Framevo's `/api/auth/desktop/exchange` reply. */
export function readExchangeResponse(json: unknown): string {
  const body = (json ?? {}) as { idToken?: unknown; error?: unknown };
  if (typeof body.error === "string" && body.error) {
    throw new Error(body.error.slice(0, 200));
  }
  if (typeof body.idToken !== "string" || body.idToken.split(".").length !== 3) {
    throw new Error("Framevo's sign-in service returned an unexpected response.");
  }
  return body.idToken;
}

/**
 * The page the user's browser lands on after consenting. It is served from the
 * loopback listener and is the only HTML this app ever produces outside the
 * renderer — deliberately inert: no script that talks to Google, no form, no
 * remote resource.
 */
export function callbackPage(options: { ok: boolean; message: string; deepLink?: string }): string {
  const title = options.ok ? "You're signed in" : "Sign-in didn't finish";
  /**
   * Literals, not tokens: this page is assembled in the MAIN process and served
   * from a loopback socket, so it has no stylesheet to read `--color-rose-400`
   * from. The failure accent is that token's dark value (the app's error-icon
   * clay) kept in sync by hand — 6.5:1 on the #0B0B10 body below, which the
   * "Return to Framevo" link needs since the accent colours its text too.
   */
  const accent = options.ok ? "#8b5cf6" : "#C97F89";
  // The deep link re-focuses the Framevo window; it carries NO code or token —
  // the credential never travels through a URL the OS can log.
  const jump = options.deepLink
    ? `<p style="margin-top:18px"><a style="color:${accent}" href="${escapeHtml(options.deepLink)}">Return to Framevo</a></p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title} · Framevo</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0B10;color:#fff;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif">
<main style="max-width:26rem;padding:2.5rem;text-align:center">
<div style="width:48px;height:48px;margin:0 auto;border-radius:14px;background:${accent}1f;border:1px solid ${accent}55"></div>
<h1 style="margin:1.25rem 0 .5rem;font-size:1.3rem">${title}</h1>
<p style="margin:0;color:#9aa0aa">${escapeHtml(options.message)}</p>
${jump}
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
