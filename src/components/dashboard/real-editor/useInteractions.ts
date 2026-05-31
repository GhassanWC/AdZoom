"use client";

import * as React from "react";
import { ref as storageRef, getBytes } from "firebase/storage";
import { getFirebase } from "@/lib/firebase/client";
import type { Interaction } from "@/lib/recording/types";

/**
 * Lazy-load the saved interactions JSON for a project.
 *
 * The interactions stream lives in Storage at `project.interactionsPath`
 * (written at upload time for in-tab recordings). We don't ship it on the
 * Firestore document because it can grow large and most editor surfaces
 * don't need it. The inspector's "Follow cursor" preset is the first
 * client-side consumer, so this hook fetches the JSON on demand and caches
 * it for the lifetime of the project view.
 *
 * Returns:
 *   - `loading: true` while the fetch is in flight
 *   - `interactions: Interaction[] | null` — null when the project has no
 *     `interactionsPath` (external recording, or in-tab take with zero
 *     events) or the load failed; an array otherwise
 *   - `error: string | null` — surfaced for the preset chip's tooltip
 */
export function useInteractions(opts: {
  interactionsPath: string | null | undefined;
  scope: "tab" | "external" | undefined;
}): { loading: boolean; interactions: Interaction[] | null; error: string | null } {
  const { interactionsPath, scope } = opts;
  const [loading, setLoading] = React.useState(false);
  const [interactions, setInteractions] = React.useState<Interaction[] | null>(
    null
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // External recordings never have a usable interaction stream — the
    // tab-scoped recorder is the only place coords are reliable.
    if (!interactionsPath || scope !== "tab") {
      setInteractions(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { storage } = getFirebase();
        const fileRef = storageRef(storage, interactionsPath);
        const bytes = await getBytes(fileRef);
        if (cancelled) return;
        const text = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(text) as {
          version?: number;
          events?: Interaction[];
        };
        setInteractions(Array.isArray(parsed.events) ? parsed.events : []);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Couldn't load cursor data"
        );
        setInteractions(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [interactionsPath, scope]);

  return { loading, interactions, error };
}
