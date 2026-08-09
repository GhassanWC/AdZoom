/**
 * The dedup rule for a library that has two sources. PURE — no React, no
 * Firebase, no platform bridge — so it can be unit-tested directly.
 *
 * ── Which data comes from where ────────────────────────────────────────────
 *   Firebase  — identity, subscriptions, plan/usage, cloud projects, analysis
 *               jobs, cloud export jobs. Anything an ACCOUNT owns.
 *   SQLite    — projects imported from this computer, the media references
 *               pointing at the user's own files, autosave/recovery history,
 *               and the exports this machine produced. Anything a DISK owns.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * A project can legitimately exist in both places. The local row records the
 * Firestore id it corresponds to; the merge keys on that and keeps the LOCAL
 * copy, because that one still opens with no network. The cloud document's
 * richer state (status, analysis) is folded in so a synced project doesn't
 * visibly regress to "uploaded, no moments" the moment the desktop shows it.
 */
import { materializeProject } from "@/lib/firebase/materialize-project";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { LOCAL_OWNER } from "@/lib/platform/local";
import type { ProjectSummary } from "@/lib/platform/types";

/**
 * A local summary rendered as a `ProjectDoc`, so every card, filter and search
 * in the dashboard treats it identically to a Firestore one. The `userId`
 * sentinel is what downstream code reads to route mutations back to SQLite.
 */
export function localSummaryToDoc(summary: ProjectSummary): ProjectDoc {
  return materializeProject(summary.id, {
    id: summary.id,
    userId: LOCAL_OWNER,
    title: summary.title,
    // A missing source file is a real, user-visible state — surface it as a
    // failed project rather than a healthy one that explodes on open.
    status: summary.mediaMissing ? "failed" : "uploaded",
    originalVideoUrl: summary.previewUrl ?? "",
    duration: summary.durationSec,
    width: summary.width,
    height: summary.height,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    // `fileSize` is deliberately absent: local bytes live on the user's own
    // disk and must NOT count against the cloud storage plan the sidebar meter
    // shows. Local disk use is reported on its own page instead.
  });
}

export function mergeProjectSources(
  local: ProjectSummary[],
  cloud: ProjectDoc[]
): ProjectDoc[] {
  const claimed = new Set(
    local.map((p) => p.cloudProjectId).filter((id): id is string => Boolean(id))
  );
  const cloudById = new Map(cloud.map((p) => [p.id, p]));

  const merged: ProjectDoc[] = local.map((summary) => {
    const doc = localSummaryToDoc(summary);
    const twin = summary.cloudProjectId
      ? cloudById.get(summary.cloudProjectId)
      : undefined;
    if (!twin) return doc;
    // Same project, two records: keep the local identity (it is the one that
    // opens offline) and adopt the cloud's richer state.
    return {
      ...doc,
      status: twin.status,
      analysis: twin.analysis ?? doc.analysis,
      updatedAt: Math.max(doc.updatedAt ?? 0, twin.updatedAt ?? 0),
    };
  });

  for (const doc of cloud) {
    if (claimed.has(doc.id)) continue;
    merged.push(doc);
  }

  return merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
