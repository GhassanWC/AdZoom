import "server-only";

import { randomBytes, createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "./admin";
import type { ApiKeyDoc, ApiKeyIndexDoc } from "./schema";

/**
 * Server-side API key issuance + validation.
 *
 * Keys are generated SERVER-SIDE only — the client never sees the
 * plaintext except in the single response to `createApiKey`. After
 * that the dashboard shows the prefix and a masked tail; there's no
 * "reveal" affordance, by design, because the plaintext is never
 * stored. Lost a key? Revoke + create a new one.
 *
 * Storage layout:
 *   users/{uid}/apiKeys/{keyId}            — per-user metadata (UserDoc fields)
 *   apiKeyIndex/{sha256(plaintext)}        — global reverse lookup
 *
 * Validation flow:
 *   `Authorization: Bearer ak_…` →
 *   hash the bearer →
 *   read `apiKeyIndex/{hash}` →
 *   if missing or revoked, reject →
 *   else, update `lastUsedAt` (fire-and-forget) and return { uid, keyId }.
 *
 * Firestore rules (must be added to firestore.rules):
 *   - `apiKeyIndex/{hash}` — admin-only read/write (no client access).
 *   - `users/{uid}/apiKeys/{id}` — owner can READ (to list), admin can
 *     write. The dashboard never writes directly; it calls the API
 *     routes in `src/app/api/settings/api-keys` which use this module.
 */

const KEY_BYTES = 32; // 256 bits → 64 hex chars
const PREFIX_TEST = "ak_test_";
const PREFIX_LIVE = "ak_live_";
const VISIBLE_PREFIX_LEN = 12; // `ak_live_` + 4 hex = unique-enough for display

export type ApiKeyType = "test" | "live";

/** Cryptographically random plaintext key in `ak_test_…` / `ak_live_…` form. */
function generatePlaintext(type: ApiKeyType): string {
  const prefix = type === "live" ? PREFIX_LIVE : PREFIX_TEST;
  return prefix + randomBytes(KEY_BYTES).toString("hex");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface CreateApiKeyResult {
  /**
   * The full plaintext key. Returned ONCE to the caller; never stored.
   * Caller (the create route) MUST surface this to the user and warn
   * them they won't see it again.
   */
  plaintext: string;
  /** The metadata persisted at `users/{uid}/apiKeys/{id}` (no hash). */
  meta: Omit<ApiKeyDoc, "keyHash">;
}

/**
 * Create a new API key for `uid`. Persists the per-user metadata + the
 * global index doc in a single batched write so the two never get out
 * of sync (an index entry without a metadata doc would be unusable;
 * vice versa would be invisible to the dashboard).
 */
export async function createApiKey(
  uid: string,
  input: { name: string; type: ApiKeyType }
): Promise<CreateApiKeyResult> {
  const { db } = getAdmin();
  const plaintext = generatePlaintext(input.type);
  const keyHash = sha256(plaintext);
  const keyId = randomBytes(12).toString("hex");
  const keyPrefix = plaintext.slice(0, VISIBLE_PREFIX_LEN);

  const meta: ApiKeyDoc = {
    id: keyId,
    name: input.name.trim().slice(0, 64) || "Untitled key",
    keyPrefix,
    keyHash,
    type: input.type,
    createdAt: Date.now(),
  };
  const indexDoc: ApiKeyIndexDoc = {
    uid,
    keyId,
    type: input.type,
    createdAt: meta.createdAt,
  };

  const batch = db.batch();
  batch.set(db.doc(`users/${uid}/apiKeys/${keyId}`), meta);
  batch.set(db.doc(`apiKeyIndex/${keyHash}`), indexDoc);
  await batch.commit();

  // Don't echo the hash back to the caller — there's no client-side
  // use for it and exposing it would let a curious dev derive
  // `apiKeyIndex` doc ids without auth.
  const { keyHash: _omit, ...metaOut } = meta;
  void _omit;
  return { plaintext, meta: metaOut };
}

/** Rename an existing key. Owner-only; the route enforces auth. */
export async function renameApiKey(
  uid: string,
  keyId: string,
  name: string
): Promise<void> {
  const { db } = getAdmin();
  const ref = db.doc(`users/${uid}/apiKeys/${keyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Key not found");
  await ref.update({ name: name.trim().slice(0, 64) || "Untitled key" });
}

/**
 * Revoke a key. Soft-delete on the per-user metadata (so the dashboard
 * can show "revoked on X") plus a HARD delete on the global index
 * (so the validator immediately stops resolving the bearer token).
 */
export async function revokeApiKey(
  uid: string,
  keyId: string
): Promise<void> {
  const { db } = getAdmin();
  const ref = db.doc(`users/${uid}/apiKeys/${keyId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Key not found");
  const data = snap.data() as ApiKeyDoc;

  const batch = db.batch();
  batch.update(ref, {
    revoked: true,
    revokedAt: Date.now(),
  });
  batch.delete(db.doc(`apiKeyIndex/${data.keyHash}`));
  await batch.commit();
}

export interface ApiKeyValidation {
  uid: string;
  keyId: string;
  type: ApiKeyType;
}

/**
 * Server-side bearer-token validator. Extracts the key from the header
 * value (with or without `Bearer ` prefix), hashes it, looks up the
 * index doc. Returns `null` on any failure path; throws never. Updates
 * `lastUsedAt` fire-and-forget.
 *
 * Use from any `app/api/**` route that should accept API key auth:
 *
 *   const auth = await validateApiKey(req.headers.get("authorization"));
 *   if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *   // …carry on with `auth.uid`
 */
export async function validateApiKey(
  authorizationHeader: string | null | undefined
): Promise<ApiKeyValidation | null> {
  if (!authorizationHeader) return null;
  const token = authorizationHeader.startsWith("Bearer ")
    ? authorizationHeader.slice(7).trim()
    : authorizationHeader.trim();
  if (!token.startsWith(PREFIX_TEST) && !token.startsWith(PREFIX_LIVE)) {
    return null;
  }
  const hash = sha256(token);
  const { db } = getAdmin();
  const indexSnap = await db.doc(`apiKeyIndex/${hash}`).get();
  if (!indexSnap.exists) return null;
  const idx = indexSnap.data() as ApiKeyIndexDoc;

  // Defence-in-depth: cross-check the per-user metadata too. The index
  // entry should have been deleted on revoke, but if a race leaves an
  // orphan around, the metadata `revoked` flag stops it.
  const metaSnap = await db
    .doc(`users/${idx.uid}/apiKeys/${idx.keyId}`)
    .get();
  if (!metaSnap.exists) return null;
  const meta = metaSnap.data() as ApiKeyDoc;
  if (meta.revoked) return null;

  // Fire-and-forget last-used update. Don't await; validation must
  // stay fast even if Firestore is slow / partitioned.
  void db
    .doc(`users/${idx.uid}/apiKeys/${idx.keyId}`)
    .update({ lastUsedAt: FieldValue.serverTimestamp() })
    .catch((err) => {
      console.warn("[api-keys] failed to update lastUsedAt", err);
    });

  return { uid: idx.uid, keyId: idx.keyId, type: idx.type };
}
