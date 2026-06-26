"use client";

/**
 * Admin-only video viewer. Given a project target (uid + id), fetches both the
 * raw source and the exported (edits-baked-in) render from
 * `GET /api/admin/projects/:id?uid=` (admin-gated), along with a summary of the
 * edits applied. Lets an admin watch any user's video and see at a glance
 * whether — and how — it was edited by AI or by the user.
 *
 * Mirrors the portal / AnimatePresence / Esc-to-close pattern of ConfirmDialog.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X, Sparkles, UserRound, Crop, Wand2, Download } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { cn } from "@/lib/cn";
import {
  AdminEditedPreview,
  type RenderInputs,
} from "./AdminEditedPreview";

export interface VideoPreviewTarget {
  id: string;
  uid: string;
  title: string;
}

interface EditsSummary {
  hasEdits: boolean;
  hasUserEdits: boolean;
  momentCount: number;
  aiMoments: number;
  userMoments: number;
  userTweaked: number;
  effectBreakdown: Record<string, number>;
  crop: { enabled: boolean; reason: string | null } | null;
  presetId: string | null;
  canvas: string;
  vignette: boolean;
  clickHighlights: boolean;
}

interface VideoMeta {
  title: string;
  status: string | null;
  videoUrl: string;
  editedVideoUrl: string | null;
  mimeType: string | null;
  edits: EditsSummary;
  /** Raw inputs to live-render the edited result; null when there are no edits. */
  render: RenderInputs | null;
}

type Source = "original" | "edited";

export function VideoPreviewModal({
  target,
  onClose,
}: {
  target: VideoPreviewTarget | null;
  onClose: () => void;
}) {
  const { getIdToken } = useAuth();
  const [mounted, setMounted] = React.useState(false);
  const [meta, setMeta] = React.useState<VideoMeta | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [source, setSource] = React.useState<Source>("original");

  React.useEffect(() => setMounted(true), []);

  // Resolve the playable URLs + edits whenever a new target is opened.
  React.useEffect(() => {
    if (!target) {
      setMeta(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMeta(null);
    setSource("original");
    (async () => {
      try {
        const token = await getIdToken();
        if (!token) throw new Error("You are not signed in.");
        const res = await fetch(
          `/api/admin/projects/${target.id}?uid=${encodeURIComponent(target.uid)}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        const json = (await res.json()) as VideoMeta;
        if (!cancelled) {
          setMeta(json);
          // Default to the edited view when edits exist — that's the
          // edits-applied result the admin most likely wants to inspect.
          setSource(json.render || json.editedVideoUrl ? "edited" : "original");
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load video");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, getIdToken]);

  // Esc closes — capture phase so it wins over any underlying handlers.
  React.useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, onClose]);

  // Lock body scroll while open.
  React.useEffect(() => {
    if (!target) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [target]);

  if (!mounted) return null;

  // The "edited" view is available when we can live-render the edits, or when
  // an exported render exists to play back.
  const canShowEdited = !!meta && (!!meta.render || !!meta.editedVideoUrl);
  const showLiveEdited = source === "edited" && !!meta?.render;

  return createPortal(
    <AnimatePresence>
      {target && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          className="fixed inset-0 z-[130] flex items-center justify-center bg-ink/80 px-4 py-6 backdrop-blur-xl"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${target.title}`}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative max-h-[88vh] w-full max-w-3xl overflow-y-auto overflow-x-hidden rounded-2xl border border-white/10 bg-surface/95 shadow-cinematic backdrop-blur-xl"
          >
            <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-5 py-3">
              <div className="min-w-0">
                <h2 className="truncate font-display text-base font-semibold text-white">
                  {target.title}
                </h2>
                <p className="truncate text-xs text-fog" title={target.uid}>
                  {target.uid}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-fog transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Original / Edited toggle — Edited renders the project's edits
                live (AI + user moments, crop, canvas, vignette), or plays the
                exported render when one exists. Disabled only for raw uploads
                with no edits. */}
            {meta && (
              <div className="flex items-center gap-2 px-5 pt-3">
                <SourceTab
                  active={source === "original"}
                  onClick={() => setSource("original")}
                >
                  Original
                </SourceTab>
                <SourceTab
                  active={source === "edited"}
                  disabled={!canShowEdited}
                  title={
                    canShowEdited
                      ? undefined
                      : "No edits on this video — nothing to preview"
                  }
                  onClick={() => canShowEdited && setSource("edited")}
                >
                  Edited
                </SourceTab>
              </div>
            )}

            <div className="px-5 py-3">
              {loading ? (
                <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-white/[0.06] bg-black">
                  <span className="text-sm text-fog">Loading video…</span>
                </div>
              ) : error ? (
                <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-white/[0.06] bg-black">
                  <span className="px-6 text-center text-sm text-rose-300">
                    {error}
                  </span>
                </div>
              ) : showLiveEdited && meta?.render ? (
                <AdminEditedPreview
                  key={meta.videoUrl}
                  videoUrl={meta.videoUrl}
                  render={meta.render}
                />
              ) : (
                // Original, or the exported render when "edited" is selected but
                // we have no live-render inputs.
                <div className="flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-white/[0.06] bg-black">
                  {meta ? (
                    <video
                      key={
                        source === "edited" && meta.editedVideoUrl
                          ? meta.editedVideoUrl
                          : meta.videoUrl
                      }
                      src={
                        source === "edited" && meta.editedVideoUrl
                          ? meta.editedVideoUrl
                          : meta.videoUrl
                      }
                      controls
                      autoPlay
                      playsInline
                      className="h-full w-full bg-black"
                    />
                  ) : null}
                </div>
              )}

              {/* Exported render download — a real baked artifact, when present. */}
              {meta?.editedVideoUrl && (
                <div className="mt-2 text-right">
                  <a
                    href={meta.editedVideoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-violet-300 transition-colors hover:text-violet-200"
                  >
                    <Download size={12} />
                    Exported render
                  </a>
                </div>
              )}
            </div>

            {meta && (
              <EditsPanel
                edits={meta.edits}
                editedMode={
                  source !== "edited"
                    ? null
                    : meta.render
                      ? "live"
                      : meta.editedVideoUrl
                        ? "exported"
                        : null
                }
              />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

function SourceTab({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
          : "border-white/10 text-fog hover:bg-white/[0.04] hover:text-white",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
      )}
    >
      {children}
    </button>
  );
}

/** Edits summary — what was applied and by whom (AI vs user). */
function EditsPanel({
  edits,
  editedMode,
}: {
  edits: EditsSummary;
  editedMode: "live" | "exported" | null;
}) {
  const effects = Object.entries(edits.effectBreakdown).sort(
    (a, b) => b[1] - a[1]
  );

  return (
    <div className="space-y-3 border-t border-white/[0.06] px-5 py-4">
      {/* Headline badge */}
      <div className="flex flex-wrap items-center gap-2">
        {!edits.hasEdits ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-fog">
            No edits — raw upload
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-200">
              <Sparkles size={12} />
              {edits.aiMoments} AI {edits.aiMoments === 1 ? "edit" : "edits"}
            </span>
            {edits.hasUserEdits && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-200">
                <UserRound size={12} />
                User edited
              </span>
            )}
          </>
        )}
        {editedMode && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-fog">
            <Wand2 size={12} />
            {editedMode === "live"
              ? "Live edited preview"
              : "Showing exported render"}
          </span>
        )}
      </div>

      {edits.hasEdits && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
          <Stat label="Total moments" value={String(edits.momentCount)} />
          <Stat label="AI moments" value={String(edits.aiMoments)} />
          <Stat
            label="User-added"
            value={String(edits.userMoments)}
            highlight={edits.userMoments > 0}
          />
          <Stat
            label="User-tweaked"
            value={String(edits.userTweaked)}
            highlight={edits.userTweaked > 0}
          />
          <Stat label="Canvas" value={edits.canvas} />
          {edits.presetId && <Stat label="Preset" value={edits.presetId} />}
        </dl>
      )}

      {/* Effect-type chips + crop / vignette / click flags */}
      {edits.hasEdits && (
        <div className="flex flex-wrap gap-1.5">
          {effects.map(([type, count]) => (
            <Chip key={type}>
              {type} · {count}
            </Chip>
          ))}
          {edits.crop?.enabled && (
            <Chip>
              <Crop size={10} className="mr-1 inline" />
              crop{edits.crop.reason ? ` · ${edits.crop.reason}` : ""}
            </Chip>
          )}
          {edits.vignette && <Chip>vignette</Chip>}
          {edits.clickHighlights && <Chip>click highlights</Chip>}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-fog">
        {label}
      </dt>
      <dd
        className={cn(
          "truncate font-medium",
          highlight ? "text-emerald-300" : "text-white/90"
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-fog">
      {children}
    </span>
  );
}
