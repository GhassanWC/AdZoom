"use client";

import * as React from "react";
import { History, Loader2 } from "lucide-react";
import { usePlatform } from "@/lib/platform";
import type { ProjectSummary } from "@/lib/platform";
import { Button } from "@/components/ui/Button";

/**
 * Crash recovery.
 *
 * A project still flagged "open" at launch means the previous session ended
 * without a clean shutdown, so the newest autosave may be ahead of the last
 * committed document. The user decides — silently adopting unknown state, or
 * silently dropping their last minutes of work, are both wrong.
 *
 * It renders as an overlay on top of whatever route the app restored to, so the
 * app is never held behind a full-screen check on a launch with nothing to
 * recover (which is almost every launch).
 */
export function DesktopRecoveryPrompt() {
  const platform = usePlatform();
  const pendingRecovery = platform.projects.pendingRecovery;
  const resolveRecovery = platform.projects.resolveRecovery;

  // Starts EMPTY, always — the initial render must not depend on which platform
  // is active, or it diverges from the prerendered HTML and hydration fails.
  const [pending, setPending] = React.useState<ProjectSummary[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!pendingRecovery || !resolveRecovery) return;
    let live = true;
    // The answer comes from the main process's LAUNCH snapshot, not from the
    // live library. Asking the library would include whatever project is open
    // right now — so refreshing the page would claim the app had crashed, and
    // answering the prompt on one route would not stop it reappearing on the
    // next. Main drains the snapshot as each project is resolved.
    void pendingRecovery()
      .then((rows) => {
        if (live) setPending(rows);
      })
      .catch(() => {
        /* a failed check is not a reason to block the app */
      });
    return () => {
      live = false;
    };
  }, [pendingRecovery, resolveRecovery]);

  const resolve = async (action: "keep" | "discard") => {
    if (!pending.length || busy || !resolveRecovery) return;
    setBusy(true);
    try {
      for (const project of pending) {
        await resolveRecovery(project.id, action);
      }
      setPending([]);
    } finally {
      setBusy(false);
    }
  };

  if (pending.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fv-recovery-title"
      className="fixed inset-0 z-[130] grid place-items-center bg-ink/95 px-4 backdrop-blur-xl"
    >
      <div className="glass w-full max-w-lg rounded-2xl p-8">
        <div className="inline-flex size-12 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-500/10 text-amber-200">
          <History size={20} />
        </div>
        <h2
          id="fv-recovery-title"
          className="mt-4 font-display text-xl font-semibold text-white"
        >
          Framevo closed unexpectedly
        </h2>
        <p className="mt-2 text-sm text-fog">
          {pending.length === 1
            ? `“${pending[0]!.title}” has unsaved changes from your last session.`
            : `${pending.length} projects have unsaved changes from your last session.`}{" "}
          Restore them, or continue from the last saved version.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            onClick={() => void resolve("keep")}
            variant="primary"
            size="sm"
            disabled={busy}
            leftIcon={busy ? <Loader2 size={13} className="animate-spin" /> : undefined}
          >
            Restore my changes
          </Button>
          <Button onClick={() => void resolve("discard")} variant="ghost" size="sm" disabled={busy}>
            Use the last saved version
          </Button>
        </div>
      </div>
    </div>
  );
}
