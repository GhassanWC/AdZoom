import { NextResponse, type NextRequest } from "next/server";
import {
  projectNumberFromClientId,
  validateDesktopConfig,
} from "../../../../../../config/desktop-env.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/desktop/exchange
 *
 * The confidential half of Framevo Desktop's Google sign-in.
 *
 * The desktop app runs the whole interactive flow in the user's real browser
 * (PKCE + a 127.0.0.1 loopback redirect — see desktop/src/main/auth). It ends
 * up holding an authorization code that is useless on its own: redeeming it
 * needs the OAuth client secret, and a secret shipped inside an Electron bundle
 * is not a secret. So the app posts the code HERE, this route redeems it, and
 * the app gets back only a Google ID token.
 *
 * The ID token is then exchanged for a Firebase session by the desktop
 * renderer via `signInWithCredential`, which resolves to the SAME Firebase user
 * as `signInWithPopup` on the website — same uid, same subscription, same
 * projects. This route deliberately does NOT mint a custom token: doing so
 * would create a parallel identity that could drift from the web one.
 *
 * Unauthenticated by design (the caller has no session yet — that is the point).
 * Its safety rests on: PKCE binding the code to the process that started the
 * flow, the redirect_uri having to match what Google saw, codes being
 * single-use and short-lived, and the fact that nothing here is returned unless
 * Google itself vouches for it.
 */

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Only the desktop app's own loopback redirect may be redeemed through here. */
function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isPlausibleCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/\s/.test(value);
}

function isPlausibleVerifier(value: unknown): value is string {
  // RFC 7636: 43–128 characters from the unreserved set.
  return typeof value === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

export async function POST(req: NextRequest) {
  const clientId = process.env.GOOGLE_DESKTOP_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DESKTOP_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.error("[auth/desktop] GOOGLE_DESKTOP_OAUTH_CLIENT_ID/SECRET are not configured");
    return NextResponse.json(
      { error: "Desktop sign-in isn't configured on this server." },
      { status: 503 }
    );
  }

  /**
   * Refuse a pairing Firebase would reject anyway.
   *
   * An ID token minted for a client in project A cannot be exchanged for a
   * Firebase session in project B — Firebase answers `auth/invalid-credential`
   * with a message that names neither project. Catching it here, using the same
   * rule the desktop build enforces, means the desktop app shows the operator
   * WHICH two projects disagree instead of the user seeing a dead button.
   */
  const firebaseProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ?? "";
  const messagingSenderId =
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?.trim() ?? "";
  const verdict = validateDesktopConfig({
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    firebaseProjectId,
    messagingSenderId,
    authDomain: "",
    apiBaseUrl: "",
    googleClientId: clientId,
    publicEnv: {},
  });
  if (!verdict.ok) {
    // Logged in full (it names project ids and numbers, never a secret) and
    // returned in full: only an operator ever sees this, and it is precisely
    // the information needed to fix the deployment.
    console.error("[auth/desktop] configuration mismatch\n", verdict.errors.join("\n"));
    return NextResponse.json({ error: verdict.errors[0] }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
  const { code, codeVerifier, redirectUri } = (body ?? {}) as Record<string, unknown>;

  if (!isPlausibleCode(code)) {
    return NextResponse.json({ error: "Missing authorization code." }, { status: 400 });
  }
  if (!isPlausibleVerifier(codeVerifier)) {
    return NextResponse.json({ error: "Missing PKCE verifier." }, { status: 400 });
  }
  if (typeof redirectUri !== "string" || !isLoopbackRedirect(redirectUri)) {
    return NextResponse.json({ error: "Unsupported redirect URI." }, { status: 400 });
  }

  let googleResponse: Response;
  try {
    googleResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch (err) {
    console.error("[auth/desktop] token endpoint unreachable", err);
    return NextResponse.json({ error: "Could not reach Google." }, { status: 502 });
  }

  const payload = (await googleResponse.json().catch(() => null)) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!googleResponse.ok || !payload?.id_token) {
    // Google's own error text can name the client id; log it, don't return it.
    console.error("[auth/desktop] exchange rejected", {
      status: googleResponse.status,
      error: payload?.error,
    });
    return NextResponse.json(
      { error: "Google rejected that sign-in. Please try again." },
      { status: 401 }
    );
  }

  // Last line of defence: the token's own `aud` must be the client we expect.
  // Firebase checks this too, but only to answer `auth/invalid-credential` — a
  // message that names neither the token's project nor the app's. Checking it
  // here lets the failure be described in terms an operator can act on.
  const audience = idTokenAudience(payload.id_token);
  if (audience && audience !== clientId) {
    const tokenProject = projectNumberFromClientId(audience);
    console.error("[auth/desktop] token audience mismatch", {
      expectedClient: clientId,
      tokenClient: audience,
      tokenProjectNumber: tokenProject,
      firebaseProjectId,
    });
    return NextResponse.json(
      {
        error:
          `That sign-in was issued for a different Google OAuth client ` +
          `(project #${tokenProject ?? "unknown"}), but this server expects ` +
          `#${messagingSenderId} for Firebase project "${firebaseProjectId}".`,
      },
      { status: 401 }
    );
  }

  // ONLY the ID token crosses back. The access and refresh tokens stay here and
  // are discarded — Framevo does not act on the user's behalf at Google, and a
  // refresh token in a desktop process is a liability with no matching benefit.
  return NextResponse.json(
    { idToken: payload.id_token },
    { headers: { "cache-control": "no-store" } }
  );
}

/**
 * The `aud` claim, read WITHOUT verifying the signature.
 *
 * That is safe here and nowhere else: the token came straight from Google's
 * token endpoint over TLS moments ago, so this is not a trust decision — it is
 * a configuration check, and the value is only ever used to build an error
 * message. The real verification is Firebase's, on the client.
 */
function idTokenAudience(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      aud?: unknown;
    };
    return typeof json.aud === "string" ? json.aud : null;
  } catch {
    return null;
  }
}
