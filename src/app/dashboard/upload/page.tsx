"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileVideo,
  Sparkles,
  AlertCircle,
  Loader2,
  Video,
  CloudUpload,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { usePlatform } from "@/lib/platform";
import { useLocalImport } from "@/lib/import/useLocalImport";
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

/**
 * Two ways to bring a video in, chosen by what the platform can actually do.
 *
 * The desktop app can hold a durable reference to a file on disk, so it
 * IMPORTS: the OS picker, no copy, no upload, and a project in the local
 * library. The browser cannot (a File handle dies with the tab), so it UPLOADS
 * to Firebase Storage exactly as it always has.
 *
 * Which one runs is a capability question, never a "am I in Electron?" one —
 * and the split is at the top so each panel keeps its own hooks.
 */
export default function UploadPage() {
  const platform = usePlatform();
  return platform.media.canPickLocalFiles ? <LocalImportPanel /> : <CloudUploadPanel />;
}

function CloudUploadPanel() {
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
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
              "relative flex min-h-[340px] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed bg-white/[0.015] p-10 text-center transition-all duration-300",
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

            <div
              className={cn(
                "inline-flex size-16 items-center justify-center rounded-2xl border text-violet-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-transform duration-300",
                dragOver
                  ? "scale-110 border-violet-400/50 bg-violet-500/20"
                  : "border-violet-400/30 bg-violet-500/10"
              )}
            >
              <Upload size={26} />
            </div>
            <h3 className="mt-6 font-display text-xl font-semibold tracking-tight text-white">
              {dragOver ? "Drop to upload it" : "Drag a recording here"}
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-fog">
              or click to browse. Up to 2 GB.
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

            <p className="mt-6 text-[11px] text-fog">
              Your file stays private to your workspace
            </p>
          </button>

          <ImportSideRail />
        </div>
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

      {/* The old copy here printed the raw Firebase Storage path. It answered a
          question no one asked and read like a stack trace; what people
          actually want to know at this moment is who can see the file. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
          <CloudUpload size={14} />
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] text-fog">
          <span className="font-medium text-white">Private to your account.</span> Your recording
          is stored in your own workspace and is only used to build your edit — never shared, and
          deleted with the project.
        </p>
      </div>
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

/**
 * Desktop import.
 *
 * Two gestures, one outcome: drop a file on the zone, or click it and use the
 * OS picker. Either way the file is validated and probed in the main process,
 * a local project is created around the handle, and we go straight into the
 * editor. Nothing is uploaded and nothing is copied — the source video stays
 * exactly where the user keeps it, which is why there is no progress bar and no
 * size limit here.
 *
 * The drop half is offered ONLY when the platform can actually accept one
 * (`importDropped`). This screen spent a while drawing a dashed drop target
 * that silently ignored every file dropped on it; a border that promises a
 * gesture is part of the interface, and has to be earned.
 */
function LocalImportPanel() {
  const { importing, error, openPicker, importDropped } = useLocalImport();
  const [dragOver, setDragOver] = React.useState(false);
  const canDrop = importDropped !== null;

  // `dragleave` also fires when the pointer crosses onto a CHILD element, which
  // makes the highlight flicker over the icon and the format chips. Counting
  // enter/leave pairs is what keeps it lit for the whole hover.
  const depth = React.useRef(0);

  const dragProps = canDrop
    ? {
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          depth.current += 1;
          setDragOver(true);
        },
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          // Without this Windows shows the "can't drop here" cursor over a
          // target that will in fact accept the file.
          e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (e: React.DragEvent) => {
          e.preventDefault();
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragOver(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          depth.current = 0;
          setDragOver(false);
          // Only the first file: one drop opens one editor, and silently
          // creating five projects would be a surprise, not a shortcut.
          const file = e.dataTransfer.files?.[0];
          if (file) importDropped?.(file);
        },
      }
    : {};

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Import"
        title="Open a recording"
        subtitle={
          canDrop
            ? "Drop a video onto the panel below, or browse for one. Framevo edits it in place — nothing is uploaded or copied."
            : "Pick a video already on this computer. Framevo edits it in place — nothing is uploaded or copied."
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <button
          type="button"
          onClick={openPicker}
          disabled={importing}
          aria-label={canDrop ? "Choose a video, or drop one here" : "Choose a video"}
          {...dragProps}
          className={cn(
            "relative flex min-h-[340px] w-full flex-col items-center justify-center overflow-hidden rounded-2xl p-10 text-center transition-all duration-300",
            // Dashed only when a drop actually works — see the note above.
            canDrop ? "border border-dashed" : "border border-solid",
            dragOver
              ? "border-violet-400/60 bg-violet-500/[0.08] ring-2 ring-violet-400/30"
              : "border-white/15 bg-white/[0.015] hover:border-white/25 hover:bg-white/[0.03]",
            importing && "cursor-wait opacity-70"
          )}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-80 w-[680px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_60%)] blur-2xl"
          />
          <div
            className={cn(
              "inline-flex size-16 items-center justify-center rounded-2xl border text-violet-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-transform duration-300",
              dragOver
                ? "scale-110 border-violet-400/50 bg-violet-500/20"
                : "border-violet-400/30 bg-violet-500/10"
            )}
          >
            {importing ? <Loader2 size={26} className="animate-spin" /> : <Upload size={26} />}
          </div>

          <h3 className="mt-6 font-display text-xl font-semibold tracking-tight text-white">
            {importing
              ? "Reading your video…"
              : dragOver
                ? "Drop to open it"
                : canDrop
                  ? "Drop a video here"
                  : "Choose a video"}
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm text-fog">
            {importing
              ? "Checking the file and setting up your project."
              : canDrop
                ? "or click to browse this computer"
                : "Framevo opens it straight from disk."}
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

          <p className="mt-6 text-[11px] text-fog">
            No upload · no copy · no size limit
          </p>
        </button>

        <ImportSideRail local />
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* The AI/cloud limitation, stated as a real thing you can act on. It used
          to be grey 12px at the bottom of the page telling people to go to
          framevo.com — which stopped being true when the editor grew its own
          "turn on cloud sync" button. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
          <CloudUpload size={14} />
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] text-fog">
          <span className="font-medium text-white">Your video stays on this computer.</span>{" "}
          AI analysis and cloud export run on Framevo&apos;s servers — turn on cloud sync from
          inside the editor when you want them for a project.
        </p>
      </div>
    </div>
  );
}

/**
 * The column beside the drop zone.
 *
 * It exists because this screen is one control on an otherwise empty page, and
 * a single button floating in a half-empty window reads as unfinished. What
 * fills it has to be true and useful, not decoration: what happens after you
 * pick a file, and the other way to get a video in.
 */
function ImportSideRail({ local = false }: { local?: boolean }) {
  const steps = local
    ? [
        { title: "Opens in place", detail: "Framevo reads the file where it is. No copy, no upload, no waiting." },
        { title: "You edit it", detail: "Zooms, crops, captions, cuts and speed on the timeline." },
        { title: "Export an MP4", detail: "Rendered by this computer, straight to a folder you choose." },
      ]
    : [
        { title: "Uploads to your workspace", detail: "The recording lands in your Framevo account." },
        { title: "AI plans the cut", detail: "Cursor movement, clicks and focus regions become zooms you can adjust." },
        { title: "Export an MP4", detail: "Render in the browser, or in the cloud on a paid plan." },
      ];

  return (
    <aside className="flex flex-col gap-3">
      <div className="glass rounded-2xl p-5">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
          What happens next
        </h4>
        <ol className="mt-4 space-y-4">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden
                className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] font-mono text-[10px] text-fog"
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-white">{step.title}</div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-fog">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="glass rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
            <Video size={14} />
          </span>
          <h4 className="text-[13px] font-medium text-white">Nothing to import yet?</h4>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-fog">
          Capture a window, a screen or a browser tab and Framevo turns it into a project the
          moment you stop.
        </p>
        <div className="mt-3">
          <Button href="/dashboard/record" variant="ghost" size="sm" leftIcon={<Video size={13} />}>
            Record your screen
          </Button>
        </div>
      </div>
    </aside>
  );
}
