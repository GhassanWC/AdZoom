"use client";

import * as React from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { getFirebase } from "./client";
import { useAuth } from "./AuthProvider";
import type { ApiKeyDoc } from "./schema";

/**
 * Client-side helpers for the API keys section of Settings.
 *
 * Reads (live) come from a direct Firestore subscription — the client
 * can SEE its own metadata documents (firestore.rules grants the user
 * read access to `users/{uid}/apiKeys/*`).
 *
 * Writes go through the server routes (`/api/settings/api-keys` and
 * `/api/settings/api-keys/[id]`) so the plaintext key never leaves
 * the server in any context other than the create-once response, and
 * so the parallel `apiKeyIndex/{hash}` doc stays in sync (only admin
 * SDK can write that collection).
 */

/**
 * Classified error shape so the UI can render a precise diagnosis
 * instead of "something went wrong". `code` mirrors the Firestore
 * `FirebaseError.code` for `permission-denied`, plus a generic
 * `"unknown"` fallback for everything else (network, internal, etc.).
 */
export interface ApiKeysError {
  code: "permission-denied" | "unknown";
  message: string;
}

export function useApiKeys(): {
  keys: ApiKeyDoc[];
  loading: boolean;
  error: ApiKeysError | null;
} {
  const { user } = useAuth();
  const [keys, setKeys] = React.useState<ApiKeyDoc[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiKeysError | null>(null);

  React.useEffect(() => {
    if (!user) {
      setKeys([]);
      setLoading(false);
      setError(null);
      return;
    }
    setError(null);
    setLoading(true);
    const { db } = getFirebase();
    const q = query(
      collection(db, "users", user.uid, "apiKeys"),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setError(null);
        setKeys(
          snap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            // `lastUsedAt` can come back as a Firestore Timestamp; coerce.
            const lastUsedAtTs = data.lastUsedAt as
              | { toMillis?: () => number }
              | number
              | undefined;
            const lastUsedAt =
              typeof lastUsedAtTs === "number"
                ? lastUsedAtTs
                : lastUsedAtTs?.toMillis?.();
            return {
              id: d.id,
              name: (data.name as string) ?? "Untitled key",
              keyPrefix: (data.keyPrefix as string) ?? "",
              keyHash: (data.keyHash as string) ?? "",
              type: (data.type as "test" | "live") ?? "test",
              createdAt: (data.createdAt as number) ?? Date.now(),
              lastUsedAt,
              revoked: Boolean(data.revoked),
              revokedAt:
                typeof data.revokedAt === "number"
                  ? (data.revokedAt as number)
                  : undefined,
            } satisfies ApiKeyDoc;
          })
        );
        setLoading(false);
      },
      (err) => {
        // Most user-actionable failure here is `permission-denied` —
        // rules not deployed, or new rule blocks the read. Surface
        // that distinctly so the dashboard can say "Rules missing"
        // instead of an empty list. Log the raw error in dev so the
        // user can copy the Firebase code into a bug report.
        if (process.env.NODE_ENV !== "production") {
          console.error("[useApiKeys] onSnapshot error", err);
        }
        const code = classifyFirestoreError(err);
        setError({ code, message: err.message });
        setKeys([]);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  return { keys, loading, error };
}

function classifyFirestoreError(err: unknown): ApiKeysError["code"] {
  const e = err as { code?: string };
  if (e?.code === "permission-denied") return "permission-denied";
  return "unknown";
}

export interface CreatedApiKey {
  /** Plaintext, shown ONCE. The caller must surface immediately. */
  plaintext: string;
  /** The persisted metadata (no hash). */
  key: Omit<ApiKeyDoc, "keyHash">;
}

async function bearerHeaders(
  idTokenGetter: () => Promise<string | null>
): Promise<HeadersInit> {
  const token = await idTokenGetter();
  if (!token) throw new Error("Not signed in.");
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

export async function createApiKeyClient(
  idTokenGetter: () => Promise<string | null>,
  input: { name: string; type: "test" | "live" }
): Promise<CreatedApiKey> {
  const res = await fetch("/api/settings/api-keys", {
    method: "POST",
    headers: await bearerHeaders(idTokenGetter),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as CreatedApiKey;
}

export async function renameApiKeyClient(
  idTokenGetter: () => Promise<string | null>,
  keyId: string,
  name: string
): Promise<void> {
  const res = await fetch(`/api/settings/api-keys/${keyId}`, {
    method: "PATCH",
    headers: await bearerHeaders(idTokenGetter),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `HTTP ${res.status}`);
  }
}

export async function revokeApiKeyClient(
  idTokenGetter: () => Promise<string | null>,
  keyId: string
): Promise<void> {
  const res = await fetch(`/api/settings/api-keys/${keyId}`, {
    method: "DELETE",
    headers: await bearerHeaders(idTokenGetter),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `HTTP ${res.status}`);
  }
}
