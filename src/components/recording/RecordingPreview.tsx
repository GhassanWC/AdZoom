"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { RefreshCcw, Sparkles, Loader2, Clock, FileVideo } from "lucide-react";

/**
 * Post-recording take review. Shows the recorded clip with two paths:
 *  - "Use this take" → uploads + creates project + redirects to editor.
 *  - "Discard & re-record" → throws away the blob and returns to setup.
 *
 * No trimming or scrub-edits here — those belong in the editor proper.
 */
export function RecordingPreview({
  blob,
  durationSeconds,
  width,
  height,
  onDiscard,
  onUse,
  uploading,
  uploadPct,
  error,
}: {
  blob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
  onDiscard: () => void;
  onUse: () => void;
  uploading: boolean;
  uploadPct: number | null;
  error: string | null;
}) {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);

  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10"
    >
      <div className="text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
          <Sparkles size={11} />
          Take ready
        </div>
        <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          That looked clean.
        </h2>
        <p className="mt-2 text-sm text-fog">
          Send it to the AI editor and it&apos;ll draft the cinematic cut.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_280px]">
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
          {url && (
            <video
              src={url}
              controls
              autoPlay
              muted
              loop
              className="aspect-video w-full"
            />
          )}
        </div>

        <div className="glass space-y-3 rounded-2xl p-5 text-sm">
          <Row label="Duration">
            <span className="inline-flex items-center gap-1.5 text-white">
              <Clock size={12} className="text-violet-300" />
              <span className="font-mono tabular-nums">
                {fmt(durationSeconds)}
              </span>
            </span>
          </Row>
          <Row label="Resolution">
            {width && height ? `${width} × ${height}` : "—"}
          </Row>
          <Row label="Size">{sizeMB} MB</Row>
          <Row label="Format">
            <span className="inline-flex items-center gap-1.5 text-white/85">
              <FileVideo size={12} className="text-fog" />
              {blob.type.split(";")[0] || "video"}
            </span>
          </Row>

          {uploadPct !== null && (
            <div className="pt-3">
              <div className="flex items-center justify-between text-[11px] text-fog">
                <span className="inline-flex items-center gap-1.5 text-white/85">
                  <Loader2 size={11} className="animate-spin text-violet-300" />
                  Uploading
                </span>
                <span className="font-mono">{uploadPct.toFixed(0)}%</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
                  style={{ width: `${uploadPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onDiscard}
          disabled={uploading}
          className="inline-flex h-12 items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-6 text-sm text-fog transition-colors duration-200 hover:border-white/25 hover:text-white disabled:opacity-50"
        >
          <RefreshCcw size={14} />
          Discard &amp; re-record
        </button>
        <button
          type="button"
          onClick={onUse}
          disabled={uploading}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-violet-600 px-7 text-sm font-semibold text-white shadow-[0_18px_40px_-16px_rgba(139,92,246,0.65)] transition-all duration-200 hover:from-violet-500 hover:to-violet-500 disabled:opacity-70"
        >
          {uploading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
          {uploading ? "Sending to AI…" : "Use this take"}
        </button>
      </div>

      {error && (
        <div className="mx-auto max-w-md rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-center text-sm text-rose-200">
          {error}
        </div>
      )}
    </motion.div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right text-sm text-white/85">
        {children}
      </dd>
    </div>
  );
}

function fmt(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
