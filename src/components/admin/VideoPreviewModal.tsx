"use client";

/**
 * Admin-only video viewer. Given a project target (uid + id), fetches a
 * playable URL from `GET /api/admin/projects/:id?uid=` (admin-gated) and plays
 * it in a portal modal. Lets an admin open any user's source video.
 *
 * Mirrors the portal / AnimatePresence / Esc-to-close pattern of ConfirmDialog.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";

export interface VideoPreviewTarget {
  id: string;
  uid: string;
  title: string;
}

interface VideoMeta {
  videoUrl: string;
  exportUrl: string | null;
  title: string;
  mimeType: string | null;
}

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

  React.useEffect(() => setMounted(true), []);

  // Resolve the playable URL whenever a new target is opened.
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
        if (!cancelled) setMeta(json);
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
            className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-surface/95 shadow-cinematic backdrop-blur-xl"
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

            <div className="flex aspect-video items-center justify-center bg-black">
              {loading ? (
                <span className="text-sm text-fog">Loading video…</span>
              ) : error ? (
                <span className="px-6 text-center text-sm text-rose-300">
                  {error}
                </span>
              ) : meta ? (
                <video
                  key={meta.videoUrl}
                  src={meta.videoUrl}
                  controls
                  autoPlay
                  playsInline
                  className="h-full w-full bg-black"
                />
              ) : null}
            </div>

            {meta?.exportUrl && (
              <div className="border-t border-white/[0.06] px-5 py-3 text-right">
                <a
                  href={meta.exportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-violet-300 transition-colors hover:text-violet-200"
                >
                  Open exported video ↗
                </a>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
