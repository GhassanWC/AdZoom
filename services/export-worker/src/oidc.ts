/**
 * Verify the Google-signed OIDC token Cloud Tasks attaches to the request.
 * Cloud Run's "require authentication" already blocks unauthenticated callers,
 * but we verify the token a second time (belt + suspenders) so the worker can't
 * be driven by anything but our enqueuer:
 *   - signature is a valid Google ID token,
 *   - `aud` equals our worker URL (`WORKER_OIDC_AUDIENCE`),
 *   - `email` matches the configured invoker service account (when set).
 *
 * In local dev (`DEV_DISABLE_OIDC=1`) verification is skipped and an optional
 * shared secret header is checked instead.
 */
import { OAuth2Client } from "google-auth-library";
import type { Request } from "express";
import type { WorkerConfig } from "./config.js";

const oauth = new OAuth2Client();

export async function verifyRequestAuth(
  req: Request,
  cfg: WorkerConfig
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (cfg.devDisableOidc) {
    if (cfg.devSecret) {
      const got = req.header("x-export-dev-secret");
      if (got !== cfg.devSecret) return { ok: false, reason: "bad dev secret" };
    }
    return { ok: true };
  }

  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { ok: false, reason: "missing bearer token" };
  if (!cfg.oidcAudience) return { ok: false, reason: "WORKER_OIDC_AUDIENCE not set" };

  try {
    const ticket = await oauth.verifyIdToken({
      idToken: token,
      audience: cfg.oidcAudience,
    });
    const payload = ticket.getPayload();
    if (!payload) return { ok: false, reason: "empty token payload" };
    if (cfg.invokerServiceAccount && payload.email !== cfg.invokerServiceAccount) {
      return { ok: false, reason: "unexpected token email" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `token verify failed: ${(err as Error).message}` };
  }
}
