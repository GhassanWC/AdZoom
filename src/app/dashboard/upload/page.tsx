"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileVideo,
  Sparkles,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { createProjectFromFile, isVideoAccepted } from "@/lib/firebase/projects";
import { usePlanTier } from "@/lib/usage/useStoragePlan";
import {
  exceedsUploadDuration,
  FREE_VIDEO_DURATION_LIMIT_MESSAGE,
} from "@/lib/usage/plan";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";

const formats = ["MP4", "MOV", "WebM", "MKV"];

interface VideoMeta {
  duration?: number;
  width?: number;
  height?: number;
}

async function probeVideoMeta(file: File): Promise<VideoMeta> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    v.onloadedmetadata = () => {
      const meta: VideoMeta = {
        duration: Number.isFinite(v.duration) ? v.duration : undefined,
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
      };
      cleanup();
      resolve(meta);
    };
    v.onerror = () => {
      cleanup();
      resolve({});
    };
  });
}

export default function UploadPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { tier, loading: planLoading } = usePlanTier();
  const confirm = useConfirm();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [previewURL, setPreviewURL] = React.useState<string | null>(null);
  const [meta, setMeta] = React.useState<VideoMeta>({});
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Free plan caps uploads at 3 minutes. `meta.duration` is probed below before
  // any upload starts, so we can block over-length clips up front. Unknown
  // duration (probe failed) is not blocked here — the server backstops it.
  const durationBlocked =
    !planLoading && exceedsUploadDuration(tier, meta.duration);

  React.useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewURL(url);
    probeVideoMeta(file).then(setMeta);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // When a Free user picks a clip over the 3-minute cap, surface the upgrade
  // prompt as a modal popup (fires once per over-length selection). "Upgrade"
  // routes to pricing; dismissing clears the selection back to the dropzone.
  const blockPromptedRef = React.useRef(false);
  React.useEffect(() => {
    if (!durationBlocked) {
      blockPromptedRef.current = false;
      return;
    }
    if (blockPromptedRef.current) return;
    blockPromptedRef.current = true;
    let active = true;
    (async () => {
      const upgrade = await confirm({
        title: "Video too long for Free plan",
        message: FREE_VIDEO_DURATION_LIMIT_MESSAGE,
        confirmLabel: "Upgrade",
        cancelLabel: "Pick another video",
        tone: "danger",
      });
      if (!active) return;
      if (upgrade) {
        router.push("/pricing");
      } else {
        setFile(null);
        setPreviewURL(null);
        setMeta({});
        setProgress(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [durationBlocked, confirm, router]);

  const onPick = (f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    if (!isVideoAccepted(f)) {
      setError(`Unsupported file: ${f.name}. Use MP4, MOV, WebM, or MKV.`);
      return;
    }
    if (f.size > 2 * 1024 * 1024 * 1024) {
      setError("File too large. Max 2 GB per upload.");
      return;
    }
    setFile(f);
    setProgress(null);
  };

  const onSubmit = async () => {
    if (!file || !user) return;
    if (durationBlocked) return; // the upgrade popup already handles this case
    setError(null);
    setSubmitting(true);
    setProgress(0);
    try {
      const { projectId } = await createProjectFromFile({
        uid: user.uid,
        file,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        onProgress: (pct) => setProgress(pct),
      });
      router.push(`/dashboard/projects/${projectId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed.";
      setError(msg);
      setProgress(null);
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Upload"
        title="Drop your recording"
        subtitle="The AI will analyze cursor movement, click events, and focus regions automatically."
      />

      {!file ? (
        <button
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onPick(e.dataTransfer.files?.[0]);
          }}
          onClick={() => inputRef.current?.click()}
          type="button"
          className={cn(
            "relative w-full overflow-hidden rounded-2xl border border-dashed bg-white/[0.015] p-16 text-center transition-all duration-300",
            dragOver
              ? "border-violet-400/60 bg-violet-500/[0.08] ring-2 ring-violet-400/30"
              : "border-white/15 hover:border-white/25 hover:bg-white/[0.03]"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-80 w-[680px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_60%)] blur-2xl"
          />

          <div className="mx-auto inline-flex size-16 items-center justify-center rounded-2xl border border-violet-400/30 bg-violet-500/10 text-violet-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <Upload size={26} />
          </div>
          <h3 className="mt-6 font-display text-xl font-semibold tracking-tight text-white">
            Drag a recording here
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-fog">
            or click to browse. Up to 2 GB. Your file stays in your workspace.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {formats.map((f) => (
              <span
                key={f}
                className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] font-medium text-fog"
              >
                <FileVideo size={10} />
                {f}
              </span>
            ))}
          </div>
        </button>
      ) : (
        <div className="glass space-y-5 rounded-2xl p-6">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_280px]">
            <div className="relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black">
              {previewURL && (
                <video
                  src={previewURL}
                  controls
                  className="h-full w-full"
                  preload="metadata"
                />
              )}
            </div>

            <dl className="space-y-3 text-sm">
              <Row label="File">
                <span className="block max-w-full truncate text-white" title={file.name}>
                  {file.name}
                </span>
              </Row>
              <Row label="Size">
                {(file.size / (1024 * 1024)).toFixed(1)} MB
              </Row>
              <Row label="Duration">
                {meta.duration ? `${meta.duration.toFixed(1)}s` : "—"}
              </Row>
              <Row label="Resolution">
                {meta.width && meta.height ? `${meta.width} × ${meta.height}` : "—"}
              </Row>
              <Row label="Type">{file.type || "video/*"}</Row>
            </dl>
          </div>

          {progress !== null && (
            <div>
              <div className="flex items-center justify-between text-xs text-fog">
                <span className="inline-flex items-center gap-1.5 text-white/85">
                  <Loader2 size={12} className="animate-spin text-violet-300" />
                  Uploading…
                </span>
                <span className="font-mono">{progress.toFixed(0)}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                setFile(null);
                setPreviewURL(null);
                setMeta({});
                setProgress(null);
              }}
              disabled={submitting}
            >
              Pick another
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={onSubmit}
              disabled={submitting || !user || durationBlocked}
              leftIcon={
                submitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )
              }
            >
              {submitting ? "Uploading…" : "Upload & analyze"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="text-xs text-fog">
        Your file is uploaded to{" "}
        <code className="rounded bg-white/[0.04] px-1 py-0.5 font-mono text-[10px] text-white/85">
          users/&#123;uid&#125;/projects/&#123;projectId&#125;/original/
        </code>{" "}
        in Firebase Storage, with a matching project document in Firestore.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right text-white/85">{children}</dd>
    </div>
  );
}
