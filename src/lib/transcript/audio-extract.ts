/**
 * Server-side audio extraction for ASR. Runs ffmpeg to pull a mono 16 kHz FLAC
 * track straight from the source video URL — ffmpeg STREAMS the input over the
 * network and only decodes the audio, so the full (large) video is never loaded
 * into memory. Bounded by `-t <maxDurationSec>`. The original video is never
 * touched. Produces a temp file + a `cleanup()` the caller must always call.
 *
 * ffmpeg is resolved from `FFMPEG_PATH` (or the system `ffmpeg`); if it isn't
 * available the extraction throws and the provider degrades to `failed` — it
 * NEVER fabricates audio and NEVER breaks the surrounding analysis.
 *
 * NODE ONLY (child_process + fs). Imported exclusively by the server provider.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const EXTRACT_SAMPLE_RATE = 16000;
export const EXTRACT_CHANNELS = 1;
/** Speech sync `recognize` accepts ≤ 60s; keep a margin. Longer → GCS long-running. */
export const SYNC_AUDIO_LIMIT_SEC = 55;

export interface ExtractedAudio {
  /** Local temp FLAC path (mono 16 kHz). */
  path: string;
  /** Bytes of the extracted audio. */
  bytes: number;
  /** Seconds actually extracted (min of source duration + cap). */
  durationSec: number;
  /** Remove the temp dir. Idempotent + safe to await in a finally. */
  cleanup: () => Promise<void>;
}

/**
 * The configured FFMPEG_PATH, trimmed + with accidental surrounding quotes
 * stripped (a common .env mistake: `FFMPEG_PATH="C:\…\ffmpeg.exe"` — spawn()
 * passes the value verbatim, so the quotes would make it ENOENT). Empty when
 * unset. NOTE: Next.js reads .env ONCE at server start; adding FFMPEG_PATH to
 * .env(.local) requires a dev-server RESTART before this sees it.
 */
function configuredFfmpeg(): string {
  return (process.env.FFMPEG_PATH ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

/** The ffmpeg executable to spawn — the configured path, else the bare `ffmpeg` (PATH lookup). */
function ffmpegPath(): string {
  const p = configuredFfmpeg();
  return p.length > 0 ? p : "ffmpeg";
}

/**
 * Extract mono 16 kHz FLAC from `videoUrl`, capped at `maxDurationSec`. Rejects
 * if ffmpeg is missing/errors, times out, or produces no audio.
 */
export async function extractAudioToFlac(input: {
  videoUrl: string;
  /** Source duration (s) — used to cap + report the extracted length. */
  durationSec: number;
  maxDurationSec: number;
  /** Hard wall for the ffmpeg process (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ExtractedAudio> {
  const { videoUrl, durationSec, maxDurationSec } = input;
  if (!videoUrl) throw new Error("no source url for audio extraction");
  const cap = Math.max(1, Math.min(durationSec || maxDurationSec, maxDurationSec));
  const timeoutMs = input.timeoutMs ?? 120_000;

  const dir = await mkdtemp(join(tmpdir(), "framevo-asr-"));
  const outPath = join(dir, "audio.flac");
  const cleanup = async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoUrl,
    "-vn", // drop video
    "-ac",
    String(EXTRACT_CHANNELS),
    "-ar",
    String(EXTRACT_SAMPLE_RATE),
    "-t",
    String(cap),
    "-c:a",
    "flac",
    outPath,
  ];

  const ffmpeg = ffmpegPath();
  // Fail fast with a precise message when an explicit FFMPEG_PATH points nowhere
  // (a bare "ffmpeg" is resolved via PATH by the OS, so only validate path-like
  // explicit values — never existsSync a PATH lookup).
  const configured = configuredFfmpeg();
  if (configured && /[\\/]/.test(configured) && !existsSync(configured)) {
    throw new Error(
      `FFMPEG_PATH is set to "${configured}" but no file exists there. Point it at the ffmpeg executable ` +
        `(e.g. …\\bin\\ffmpeg.exe, not the folder) and RESTART the dev server (Next.js loads .env only at startup).`
    );
  }

  console.info("[asr:extract-audio]", {
    ffmpeg,
    configured: configured || "(unset → PATH lookup)",
    capSec: cap,
    durationSec,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let done = false;
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(new Error("audio extraction cancelled"));
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (input.signal) {
        if (input.signal.aborted) return onAbort();
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stderr?.on("data", (d) => {
        stderr += String(d);
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) =>
        finish(
          new Error(
            e && (e as NodeJS.ErrnoException).code === "ENOENT"
              ? `ffmpeg not found at "${ffmpeg}". Set FFMPEG_PATH to the ffmpeg executable, then ` +
                `RESTART the dev server — Next.js loads .env only at startup, so a path added while it ` +
                `was running is not picked up.`
              : `ffmpeg failed to start: ${e.message}`
          )
        )
      );
      child.on("close", (code) =>
        finish(code === 0 ? undefined : new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`))
      );
    });

    const st = await stat(outPath).catch(() => null);
    if (!st || st.size === 0) {
      await cleanup();
      throw new Error("no audio track extracted");
    }
    return { path: outPath, bytes: st.size, durationSec: cap, cleanup };
  } catch (err) {
    await cleanup();
    throw err instanceof Error ? err : new Error("audio extraction failed");
  }
}
