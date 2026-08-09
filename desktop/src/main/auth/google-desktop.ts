/**
 * The desktop Google sign-in flow, end to end.
 *
 *   1. Bind a loopback listener on 127.0.0.1 with an OS-assigned port.
 *   2. Open the user's REAL browser at Google's authorization endpoint.
 *   3. Google redirects back to the listener with `?code&state`.
 *   4. POST the code + PKCE verifier to Framevo's own API, which performs the
 *      confidential half of the exchange and returns a Google ID token.
 *   5. The renderer turns that ID token into a Firebase session with
 *      `signInWithCredential` — the SAME account the website signs in to, so
 *      subscriptions, projects and usage all carry over untouched.
 *
 * What is deliberately NOT here: any client secret, any service-account key,
 * any Firebase Admin credential, and any storage of the resulting tokens. The
 * session is owned by the Firebase SDK in the renderer, persisted to the app
 * origin's own storage, and cleared by `signOut()`.
 */
import { createServer, type Server } from "node:http";
// `import type` matters: AddressInfo exists only in the type system, and a
// value import of it fails outright under Node's own TypeScript stripping.
import type { AddressInfo } from "node:net";
import { logger } from "../logger";
import {
  buildAuthUrl,
  callbackPage,
  createPkcePair,
  createState,
  exchangeEndpoints,
  parseCallback,
  readExchangeResponse,
  unreachableMessage,
} from "./oauth";

/** A user who wandered off must not leave a listener bound forever. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Long enough for a cold Next dev route, short enough not to feel stuck. */
export const PREFLIGHT_TIMEOUT_MS = 8_000;

/** Loopback only — never 0.0.0.0, which would expose the callback to the LAN. */
const LOOPBACK_HOST = "127.0.0.1";

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

export interface GoogleSignInDeps {
  clientId: string;
  /** Framevo's API origin. The code exchange happens there, never here. */
  apiBaseUrl: string;
  /** `shell.openExternal` — injected so this module has no Electron import. */
  openExternal(url: string): Promise<void>;
  /** Called once the browser has come back, so the app window can take focus. */
  onCallbackReceived?(): void;
  /** Deep link offered on the browser page purely to re-focus the app. */
  deepLink?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  preflightTimeoutMs?: number;
}

interface Pending {
  cancel(reason: string): void;
}

let pending: Pending | null = null;

/** Abandon a flow in progress (the user navigated away from the sign-in screen). */
export function cancelGoogleSignIn(): void {
  pending?.cancel("Sign-in was cancelled.");
}

export async function startGoogleSignIn(deps: GoogleSignInDeps): Promise<{ idToken: string }> {
  if (!deps.clientId) {
    throw new SignInError(
      "This build has no Google sign-in client configured. Set FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID and rebuild."
    );
  }
  if (!deps.apiBaseUrl) {
    throw new SignInError(
      "Signing in needs Framevo's server. Set NEXT_PUBLIC_CLOUD_API_BASE and rebuild."
    );
  }

  // Only one flow at a time: a second browser tab racing the first would leave
  // two listeners bound and make the state check meaningless.
  cancelGoogleSignIn();

  const pkce = createPkcePair();
  const state = createState();
  const doFetch = deps.fetchImpl ?? fetch;

  /**
   * Find the exchange service BEFORE opening the browser.
   *
   * Without this, an unreachable service is discovered at the very last step:
   * the user has already chosen an account, typed a password, approved a
   * consent screen — and only then is told to "check your connection". The
   * authorization code is spent by that point, so every retry repeats the whole
   * trip. One request up front turns that into an instant, accurate error.
   */
  const endpoint = await findExchangeEndpoint(
    deps.apiBaseUrl,
    doFetch,
    deps.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS
  );

  const { server, port } = await listen();
  const redirectUri = `http://${LOOPBACK_HOST}:${port}`;

  return new Promise<{ idToken: string }>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending = null;
      server.close();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new SignInError("Sign-in timed out. Please try again."))),
      deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS
    );

    pending = {
      cancel: (reason) => finish(() => reject(new SignInError(reason))),
    };

    server.on("request", (req, res) => {
      // Favicon and any stray probe must not be mistaken for the callback.
      const target = req.url ?? "/";
      if (target.startsWith("/favicon")) {
        res.writeHead(404).end();
        return;
      }

      const result = parseCallback(target, state);
      deps.onCallbackReceived?.();

      const respond = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, {
          "content-type": "text/html; charset=utf-8",
          // The page shows a status, never a credential — but tell every cache
          // and referrer-follower to forget it anyway.
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end(callbackPage({ ok, message, deepLink: deps.deepLink }));
      };

      if (!result.ok) {
        respond(false, result.message);
        finish(() => reject(new SignInError(result.message)));
        return;
      }

      // Answer the browser FIRST — the exchange is a network round trip and the
      // user should not stare at a hanging tab while it happens.
      respond(true, "Framevo is finishing sign-in. You can close this tab.");

      void exchange({
        endpoint,
        apiBaseUrl: deps.apiBaseUrl,
        code: result.code,
        codeVerifier: pkce.verifier,
        redirectUri,
        fetchImpl: doFetch,
      })
        .then((idToken) => finish(() => resolve({ idToken })))
        .catch((err: unknown) =>
          finish(() =>
            reject(
              err instanceof SignInError
                ? err
                : new SignInError("Framevo could not complete sign-in. Please try again.")
            )
          )
        );
    });

    const authUrl = buildAuthUrl({
      clientId: deps.clientId,
      redirectUri,
      challenge: pkce.challenge,
      state,
    });
    logger.info("desktop sign-in started", { port });
    void deps.openExternal(authUrl).catch(() =>
      finish(() =>
        reject(new SignInError("Framevo could not open your browser to sign in."))
      )
    );
  });
}

/** Bind to an OS-assigned loopback port. */
function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(new SignInError("Framevo could not start its sign-in listener."))
    );
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        server.close();
        reject(new SignInError("Framevo could not start its sign-in listener."));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/**
 * The first candidate endpoint that answers at all.
 *
 * ANY HTTP status counts as "there" — this route is POST-only, so a healthy
 * server replies 405 to the probe. Only a transport failure (nothing listening,
 * DNS, TLS, timeout) means the service cannot be reached.
 */
async function findExchangeEndpoint(
  apiBaseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<string> {
  const candidates = exchangeEndpoints(apiBaseUrl);
  for (const candidate of candidates) {
    try {
      await fetchImpl(candidate, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      return candidate;
    } catch {
      // Try the next address before concluding the service is down.
    }
  }
  logger.warn("desktop sign-in service unreachable", { candidates: candidates.length });
  throw new SignInError(unreachableMessage(apiBaseUrl));
}

async function exchange(input: {
  endpoint: string;
  apiBaseUrl: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
      }),
    });
  } catch {
    // Reachable a moment ago (the preflight said so), gone now — say where.
    throw new SignInError(unreachableMessage(input.apiBaseUrl));
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* handled below by the status check */
  }
  if (!response.ok) {
    const message =
      (json as { error?: string } | null)?.error ??
      `Sign-in service returned ${response.status}.`;
    throw new SignInError(String(message).slice(0, 200));
  }
  try {
    return readExchangeResponse(json);
  } catch (err) {
    throw new SignInError(err instanceof Error ? err.message : "Sign-in failed.");
  }
}
