/**
 * FFmpeg plumbing for the worker. FFmpeg handles ONLY decode, encode, and the
 * audio filtergraph — never the visual compositing (that's the shared
 * `composeFrame` on @napi-rs/canvas, for pixel parity with the browser).
 *
 *   • probeSource     — ffprobe: dims, duration, audio presence + sample rate.
 *   • spawnDecoder    — one ffmpeg that emits rawvideo rgba frames at a fixed
 *                       fps, in source order, with a bounded read buffer so a
 *                       fast decode can't OOM ahead of a slow encode.
 *   • spawnEncoder    — one ffmpeg that reads rawvideo rgba from stdin AND the
 *                       source file (for audio), applies the audio filtergraph,
 *                       and writes H.264/AAC MP4. Writes are drain-gated.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const execFileP = promisify(execFile);

// Bound the short-lived ffprobe/ffmpeg helpers so a malformed source can't hang
// the worker or overrun the default stdout buffer. A timeout KILLS the child and
// rejects the promise — which `canDecodeAudio` treats as "drop audio", the safe
// degradation, rather than letting a stuck probe wedge the whole job.
const EXEC_OPTS = { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 } as const;

/**
 * Prefer the bundled static binary, but fall back to a system binary on PATH if
 * the static download is missing (e.g. a flaky postinstall left ffmpeg-static
 * without its .exe). If neither exists the spawn fails with ENOENT — which now
 * surfaces as a clean job failure, not a worker crash (see spawnDecoder).
 */
function resolveBinary(p: string | null | undefined, fallback: string): string {
  return p && existsSync(p) ? p : fallback;
}

// Resolved lazily per-spawn (not at module load) so a binary that appears after
// the worker started — e.g. a re-run ffmpeg-static download — is picked up
// without a restart.
export function ffmpegBin(): string {
  return resolveBinary(ffmpegStatic, "ffmpeg");
}
export function ffprobeBin(): string {
  return resolveBinary((ffprobeStatic as { path?: string } | undefined)?.path, "ffprobe");
}

// ── Audio-codec policy ──────────────────────────────────────────────────────
// Lives HERE (the lowest-level ffmpeg module, no internal imports) so both the
// normalizer below and preflight.ts can share it without a circular import.
// preflight.ts re-exports these for its existing callers (render.ts, cli.ts).

/** The single source of truth for the audio-removed warning copy. Pushed onto
 *  the job's `warnings[]` whenever audio can't be safely processed, so the user
 *  sees identical wording whether it was dropped at normalization or render. */
export const AUDIO_UNSUPPORTED_WARNING =
  "This video's audio could not be processed, so the exported video will be silent.";

/**
 * Audio codecs the bundled ffmpeg cannot decode — keyed on the ffprobe
 * `codec_name` (or the 4-char `codec_tag_string`). AUTHORITATIVE, fast guard: a
 * stream whose audio is `none`/`apac`/`unknown`/empty must NEVER be selected for
 * the normalized output (it would abort ffmpeg with "no decoder found"). Does not
 * rely on the decode probe — that probe was observed letting `apac` through in
 * production. Decodable codecs (aac/opus/mp3/…) return false and are still gated
 * by the decode probe as a secondary check.
 */
const UNDECODABLE_AUDIO = new Set(["", "none", "unknown", "apac"]);
export function isUnsupportedAudioCodec(
  codec: string | undefined,
  tag?: string | undefined
): boolean {
  return (
    UNDECODABLE_AUDIO.has((codec ?? "").toLowerCase()) ||
    (tag ?? "").toLowerCase() === "apac"
  );
}

export interface SourceInfo {
  width: number;
  height: number;
  durationSec: number;
  /** Video codec name per ffprobe (e.g. "h264", "hevc", "vp9"); "" if no video. */
  videoCodec: string;
  /** Frames per second of the source's first video stream (best-effort, parsed
   *  from r_frame_rate / avg_frame_rate). 0 when unknown. Informational only —
   *  the render fps comes from the recipe, not the source. */
  fps: number;
  /** Stream counts — a "normal" editable clip has exactly 1 video stream. */
  nbVideoStreams: number;
  nbAudioStreams: number;
  hasAudio: boolean;
  audioSampleRate: number;
  /** Audio channel count (0 when no audio). */
  audioChannels: number;
  /** Audio codec name per ffprobe (e.g. "aac", "opus"); "" if no audio. May be
   *  "none"/"unknown" for codecs the build can't identify (e.g. Apple `apac`). */
  audioCodec: string;
  /** Four-char codec tag (e.g. "apac") — useful when codec_name is "none". */
  audioCodecTag: string;
  /** Container bitrate in bits/sec (0 when unknown). */
  bitrate: number;
}

/** Parse an ffprobe rate like "30000/1001" or "30/1" into a number; 0 on junk. */
function parseRate(raw: string | undefined): number {
  if (!raw) return 0;
  const [n, d] = raw.split("/");
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

export async function probeSource(path: string): Promise<SourceInfo> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP(
      ffprobeBin(),
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
      EXEC_OPTS
    ));
  } catch (err) {
    // ffprobe couldn't read the file at all (corrupt / not a media file / wrong
    // bytes). Throw a tagged PREFLIGHT error so it fails fast with a clean
    // user message (decode_failed) instead of leaking raw ffprobe text.
    const detail = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message ?? "";
    console.error("[worker:preflight] ffprobe failed", String(detail).slice(-2000));
    throw new Error("preflight: could not read source video (ffprobe failed)");
  }
  let json: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      codec_tag_string?: string;
      width?: number;
      height?: number;
      sample_rate?: string;
      channels?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      disposition?: { attached_pic?: number };
    }>;
    format?: { duration?: string; bit_rate?: string };
  };
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("preflight: could not read source video (unparseable ffprobe output)");
  }
  const streams = json.streams ?? [];
  // Exclude cover-art / thumbnail streams (attached_pic) — they're tagged as
  // video by ffprobe but aren't a real video track, so they'd otherwise inflate
  // the stream count and falsely flag a normal clip as "risky".
  const videoStreams = streams.filter(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1
  );
  const v = videoStreams[0];
  const a = streams.find((s) => s.codec_type === "audio");
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    durationSec: Number(json.format?.duration ?? 0),
    videoCodec: v?.codec_name ?? "",
    fps: parseRate(v?.r_frame_rate) || parseRate(v?.avg_frame_rate),
    nbVideoStreams: videoStreams.length,
    nbAudioStreams: streams.filter((s) => s.codec_type === "audio").length,
    hasAudio: !!a,
    audioSampleRate: a?.sample_rate ? Number(a.sample_rate) : 48000,
    audioChannels: a?.channels ?? 0,
    audioCodec: a?.codec_name ?? "",
    audioCodecTag: a?.codec_tag_string ?? "",
    bitrate: Number(json.format?.bit_rate ?? 0),
  };
}

/** One audio stream as seen by ffprobe (`-select_streams a`, in container order). */
export interface AudioStreamInfo {
  /** 0-based index AMONG audio streams — use directly in `-map 0:a:<audioIndex>`. */
  audioIndex: number;
  /** ffprobe codec_name (e.g. "aac", "opus"); "" / "none" for codecs it can't id. */
  codec: string;
  /** Four-char codec tag (e.g. "apac") — useful when codec_name is "none". */
  tag: string;
  channels: number;
  sampleRate: number;
}

/**
 * List EVERY audio stream (not just the first, as `probeSource` does) so the
 * normalizer can pick ONE safe stream out of a multi-track source — e.g. a MOV
 * that carries a valid AAC track PLUS an unsupported `apac`/`none` track. Returns
 * [] when there's no audio or ffprobe can't read the file.
 */
export async function probeAudioStreams(path: string): Promise<AudioStreamInfo[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP(
      ffprobeBin(),
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "a", path],
      EXEC_OPTS
    ));
  } catch {
    return [];
  }
  let json: {
    streams?: Array<{
      codec_name?: string;
      codec_tag_string?: string;
      channels?: number;
      sample_rate?: string;
    }>;
  };
  try {
    json = JSON.parse(stdout);
  } catch {
    return [];
  }
  return (json.streams ?? []).map((s, i) => ({
    audioIndex: i,
    codec: s.codec_name ?? "",
    tag: s.codec_tag_string ?? "",
    channels: s.channels ?? 0,
    sampleRate: s.sample_rate ? Number(s.sample_rate) : 0,
  }));
}

/**
 * Can the bundled ffmpeg actually DECODE the given audio stream? Some containers
 * carry codecs the static build has no decoder for — notably Apple's `apac`
 * spatial-audio codec, which makes ffmpeg abort at startup ("no decoder found
 * for: none"). We decode a short slice to the null muxer up front so the
 * normalizer can skip that stream (or drop audio entirely) instead of crashing.
 *
 * Returns false on ANY decode failure (unknown codec, corrupt stream, missing
 * binary) — always the safe degradation.
 */
export async function canDecodeAudioStream(path: string, audioIndex: number): Promise<boolean> {
  try {
    await execFileP(
      ffmpegBin(),
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        path,
        "-map",
        `0:a:${audioIndex}`,
        // Decode a brief slice only — enough to prove the decoder works.
        "-t",
        "0.5",
        "-f",
        "null",
        "-",
      ],
      EXEC_OPTS
    );
    return true;
  } catch {
    return false;
  }
}

/** Back-compat: can ffmpeg decode the FIRST audio stream? (render.ts guard.) */
export async function canDecodeAudio(path: string): Promise<boolean> {
  return canDecodeAudioStream(path, 0);
}

/**
 * Can the bundled ffmpeg DECODE this file's video at all? A source whose video
 * can't be decoded (corrupt, truly unsupported, or zero usable video streams)
 * would otherwise produce NO frames — and the render would hang until the 90s
 * stall watchdog ("render_stalled"), a slow, opaque failure. We decode a single
 * frame up front so such a source fails FAST with a clear preflight error,
 * before the expensive render. Returns false on ANY decode failure (or a 60s
 * timeout — a source that can't yield one frame in a minute is unusable).
 */
export async function canDecodeVideo(path: string): Promise<boolean> {
  try {
    await execFileP(
      ffmpegBin(),
      ["-hide_banner", "-v", "error", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"],
      EXEC_OPTS
    );
    return true;
  } catch {
    return false;
  }
}

// A full transcode can take minutes — far longer than EXEC_OPTS' 60s probe
// budget. Bound it well under the 30-min job lease + 3600s Cloud Run timeout.
const NORMALIZE_EXEC_OPTS = {
  timeout: 20 * 60_000,
  maxBuffer: 16 * 1024 * 1024,
} as const;

export interface NormalizeOptions {
  sourcePath: string;
  outputPath: string;
  crf: number;
  preset: string;
  /** Aborting (job cancel) kills the ffmpeg child and rejects the promise. */
  signal?: AbortSignal;
}

export interface NormalizeResult {
  /**
   *   "preserved" — exactly one clean AAC track was carried into the output.
   *   "removed"   — the source HAD audio but none could be safely decoded, so the
   *                 output is silent (a warning is queued). Bad audio NEVER fails.
   *   "none"      — the source genuinely had no audio (silent, no warning).
   */
  audioStatus: "preserved" | "removed" | "none";
  /** User-facing notices to push onto the job's `warnings[]` (audio-removed). */
  warnings: string[];
}

/** Build the single-pass normalize args. `audioMap` = the audio-stream index to
 *  keep, or null for a silent (`-an`) output. Always one video + ≤one audio
 *  track; subtitles/data/extra streams + global metadata are stripped. */
function normalizeArgs(
  sourcePath: string,
  outputPath: string,
  audioMap: number | null,
  crf: number,
  preset: string
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    sourcePath,
    // Exactly one real video stream + (optionally) one chosen audio stream.
    "-map",
    "0:v:0",
    ...(audioMap !== null ? ["-map", `0:a:${audioMap}`] : []),
    // Strip subtitles, data streams, and global/stream metadata.
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    ...(audioMap !== null
      ? ["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"]
      : ["-an"]),
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];
}

function normalizeTail(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || "").toString().trim();
}

/**
 * Transcode ANY accepted source into a worker-safe `normalized-source.mp4`:
 * H.264 + exactly ONE clean AAC track (or silent), resolution/fps/duration
 * preserved (no scaling, no `-r`). This is the single choke point that makes
 * "accepted upload ⇒ exportable" true — the renderer only ever sees this file.
 *
 *   1. Probe + choose ONE safe audio stream (prefer decodable AAC; else the
 *      first stream that actually decodes; else none) out of a multi-track
 *      source — so a MOV with a good AAC track + a bad `apac` track keeps the AAC.
 *   2. Attempt encode WITH that audio. If it still fails, retry video-only (`-an`)
 *      and mark audio removed. Bad audio must NEVER fail the export.
 *   3. If even the video-only pass fails (corrupt / truly unsupported video),
 *      throw `unsupported_video`.
 *
 * On any ffmpeg failure the raw stderr tail is logged (worker logs only); only a
 * tagged, classifiable error is thrown (never reaches Firestore/the UI).
 */
export async function normalizeSource(opts: NormalizeOptions): Promise<NormalizeResult> {
  const { sourcePath, outputPath, crf, preset } = opts;
  const exec = { ...NORMALIZE_EXEC_OPTS, signal: opts.signal };

  // ── 1. Pick one safe audio stream ────────────────────────────────────────
  const streams = await probeAudioStreams(sourcePath);
  const hadAudio = streams.length > 0;
  // Prefer a decodable AAC stream, then any other decodable stream.
  const ranked = [
    ...streams.filter((s) => s.codec.toLowerCase() === "aac"),
    ...streams.filter((s) => s.codec.toLowerCase() !== "aac"),
  ];
  let chosen: number | null = null;
  for (const s of ranked) {
    if (isUnsupportedAudioCodec(s.codec, s.tag)) continue;
    if (await canDecodeAudioStream(sourcePath, s.audioIndex)) {
      chosen = s.audioIndex;
      break;
    }
  }
  console.info("[worker:normalize] audio-select", {
    audioStreams: streams.map((s) => `${s.audioIndex}:${s.codec || s.tag || "?"}`),
    chosen,
  });

  // ── 2. Attempt WITH the chosen audio stream ──────────────────────────────
  if (chosen !== null) {
    try {
      await execFileP(ffmpegBin(), normalizeArgs(sourcePath, outputPath, chosen, crf, preset), exec);
      return { audioStatus: "preserved", warnings: [] };
    } catch (err) {
      // The chosen stream decoded in the probe but the full transcode still
      // tripped — fall through to a silent output rather than fail the export.
      console.warn(
        "[worker:normalize] audio transcode failed despite probe — retrying silent",
        normalizeTail(err).slice(-1000)
      );
    }
  }

  // ── 3. Video-only (silent) — either no usable audio, or attempt 2 failed ──
  try {
    await execFileP(ffmpegBin(), normalizeArgs(sourcePath, outputPath, null, crf, preset), exec);
  } catch (err) {
    const detail = normalizeTail(err);
    console.error("[worker:normalize] video-only pass failed", detail.slice(-4000));
    // The video itself can't be transcoded → unsupported source video.
    throw new Error(`unsupported_video: normalize failed: ${detail.slice(-500)}`);
  }

  return hadAudio
    ? { audioStatus: "removed", warnings: [AUDIO_UNSUPPORTED_WARNING] }
    : { audioStatus: "none", warnings: [] };
}

/**
 * A pull-based reader over the decoder's rawvideo stdout. `next()` resolves the
 * next full RGBA frame (a `frameBytes`-length Buffer) or null at EOF. The
 * underlying stream is paused whenever the buffered backlog exceeds a few
 * frames, so decode throttles to consumption.
 */
export interface FrameReader {
  next(): Promise<Buffer | null>;
  /** Whole frames currently buffered from the decode pipe (for the leak guard). */
  bufferedFrames(): number;
  destroy(): void;
}

function makeFrameReader(stream: Readable, frameBytes: number): FrameReader {
  const MAX_BACKLOG = frameBytes * 3; // ≤3 frames of raw pipe data in flight
  // A QUEUE of raw pipe chunks (not a single growing Buffer). Assembling a frame
  // copies exactly `frameBytes` once across the queued chunks — O(frameBytes) per
  // frame. The old `Buffer.concat([buffered, chunk])` on every ~64 KB pipe chunk
  // was O(frameBytes²/chunk): at 1080p (≈8 MB/frame) that's ~1 GB of copying PER
  // frame, which dominated decode time (and exploded when many frames were
  // decoded+discarded across a leading cut / speed section).
  const chunks: Buffer[] = [];
  let bufferedLen = 0;
  let ended = false;
  let errored: Error | null = null;
  let paused = false;
  let waiter: (() => void) | null = null;

  const wake = () => {
    const w = waiter;
    waiter = null;
    if (w) w();
  };

  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    bufferedLen += chunk.length;
    if (bufferedLen >= MAX_BACKLOG && !paused) {
      paused = true;
      stream.pause();
    }
    wake();
  });
  stream.on("end", () => {
    ended = true;
    wake();
  });
  // 'close' covers a killed/destroyed process (cancel/stall) that may not emit
  // 'end' — without it, a pending next() could wait forever after a kill.
  stream.on("close", () => {
    ended = true;
    wake();
  });
  stream.on("error", (err) => {
    errored = err as Error;
    ended = true;
    wake();
  });

  // ONE reusable output buffer — NOT a fresh alloc per frame. The single consumer
  // (the render loop) copies each frame into the canvas synchronously before
  // calling next() again, so reusing the same memory is safe and removes an
  // ~8 MB/frame allocation (a major source of GC pressure / RSS churn at 1080p).
  const reuse = Buffer.allocUnsafe(frameBytes);

  /** Copy exactly `frameBytes` out of the head of the chunk queue into `reuse`. */
  const takeFrame = (): Buffer => {
    let off = 0;
    while (off < frameBytes) {
      const c = chunks[0]!;
      const need = frameBytes - off;
      if (c.length <= need) {
        c.copy(reuse, off);
        off += c.length;
        chunks.shift();
      } else {
        c.copy(reuse, off, 0, need);
        chunks[0] = c.subarray(need);
        off += need;
      }
    }
    bufferedLen -= frameBytes;
    return reuse;
  };

  return {
    async next(): Promise<Buffer | null> {
      for (;;) {
        if (errored) throw errored;
        if (bufferedLen >= frameBytes) {
          const frame = takeFrame(); // reused buffer — copy it before the next next()
          if (paused && bufferedLen < MAX_BACKLOG) {
            paused = false;
            stream.resume();
          }
          return frame;
        }
        if (ended) return null;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
    bufferedFrames(): number {
      return Math.floor(bufferedLen / frameBytes);
    },
    destroy() {
      stream.destroy();
    },
  };
}

export interface Decoder {
  reader: FrameReader;
  child: ChildProcessByStdio<null, Readable, Readable>;
  kill(): void;
}

/**
 * Decode `path` to rawvideo rgba at `fps`, full source resolution. Frames arrive
 * at source times 0, 1/fps, 2/fps, … `out_color_matrix=bt709:out_range=pc` keeps
 * decoded pixels in the same space Chrome hands `drawImage`, for color parity.
 */
export function spawnDecoder(
  path: string,
  fps: number,
  width: number,
  height: number
): Decoder {
  const child = spawn(
    ffmpegBin(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      // The decoder emits ONLY video — skip opening/analyzing the audio stream
      // so input setup (and the first frame) isn't delayed by it.
      "-an",
      "-i",
      path,
      // Force exact dims so each frame is exactly `width*height*4` bytes (the
      // FrameReader slices on that). Color-matrix parity tuning is deferred —
      // keep the filter minimal to reduce the failure surface.
      "-vf",
      `fps=${fps},scale=${width}:${height},format=rgba`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  ) as ChildProcessByStdio<null, Readable, Readable>;

  child.stderr.on("data", (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.warn("[worker:decode]", s);
  });

  // A spawn failure (e.g. the binary is missing) emits 'error' on the child.
  // Without a listener Node throws an uncaught 'error' event and crashes the
  // whole worker. Route it into the stdout stream so the FrameReader's next()
  // rejects and the job fails cleanly.
  child.on("error", (err) => {
    try {
      child.stdout.destroy(err);
    } catch {
      /* ignore */
    }
  });

  // A non-zero exit (code !== 0/null) means the DECODER died on its own mid-run
  // — surface it. A signal kill (code === null) is our own kill() on
  // completion/cancel, not an error.
  child.on("close", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error("[worker:decode] ffmpeg decoder exited", { code, signal });
    }
  });

  return {
    reader: makeFrameReader(child.stdout, width * height * 4),
    child,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    },
  };
}

export interface Encoder {
  /** Write one RGBA frame; resolves once the pipe accepts more (backpressure). */
  writeFrame(frame: Buffer): Promise<void>;
  /** Close stdin and wait for the muxer to finish writing the output file. */
  finish(): Promise<void>;
  kill(): void;
}

/**
 * How the encoder sources audio:
 *   - "none"   → no audio (`-an`). Source has no audio.
 *   - "direct" → map the source's audio straight through (`-map 1:a?`). Used for
 *                a trivial timeline (no cuts/speed) — perfectly in sync, and
 *                avoids any filtergraph edge cases that could silently drop it.
 *   - "filter" → rebuild audio from the cut/speed segments via filter_complex.
 */
export type EncoderAudio =
  | { kind: "none" }
  | { kind: "direct" }
  | { kind: "filter"; filterComplex: string };

export interface EncoderOptions {
  width: number;
  height: number;
  fps: number;
  outputPath: string;
  /** Source file path — used as the audio input (input #1). */
  sourcePath: string;
  audio: EncoderAudio;
  crf: number;
  preset: string;
}

/**
 * Encode rawvideo (stdin) + audio (from the source file via the filtergraph)
 * into an H.264/AAC MP4. The audio filtergraph is written to a temp script file
 * and passed via `-filter_complex_script` so any number of cut/speed segments
 * fits without hitting command-line length limits.
 */
export async function spawnEncoder(opts: EncoderOptions): Promise<Encoder> {
  const { width, height, fps, outputPath, sourcePath, audio, crf, preset } = opts;

  let scriptPath: string | null = null;
  const args: string[] = [
    "-hide_banner",
    // `warning` (not `error`) so an audio-drop / filtergraph complaint shows up
    // in [worker:encode] instead of vanishing silently.
    "-loglevel",
    "warning",
    // Input 0: rawvideo from stdin.
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${width}x${height}`,
    "-r",
    String(fps),
    "-i",
    "pipe:0",
  ];

  if (audio.kind === "filter") {
    scriptPath = join(
      tmpdir(),
      `framevo-afc-${process.pid}-${Math.floor(Date.now())}.txt`
    );
    await writeFile(scriptPath, audio.filterComplex, "utf8");
    args.push(
      "-i",
      sourcePath,
      "-filter_complex_script",
      scriptPath,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "192k"
    );
  } else if (audio.kind === "direct") {
    // Map ONLY the source's FIRST audio stream (`1:a:0`, not `1:a` = all streams)
    // — the normalized input has exactly one clean AAC track, and pinning the
    // index means a stray extra stream can never reach the encoder. `?` tolerates
    // a (shouldn't-happen) absence rather than failing the whole job.
    args.push(
      "-i",
      sourcePath,
      "-map",
      "0:v",
      "-map",
      "1:a:0?",
      "-c:a",
      "aac",
      "-b:a",
      "192k"
    );
  } else {
    args.push("-an");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-r",
    String(fps),
    "-shortest",
    "-y",
    outputPath
  );

  const child = spawn(ffmpegBin(), args, {
    stdio: ["pipe", "ignore", "pipe"],
  }) as ChildProcessByStdio<Writable, null, Readable>;

  let stderrTail = "";
  child.stderr.on("data", (d: Buffer) => {
    const s = d.toString();
    stderrTail = (stderrTail + s).slice(-4000);
    const t = s.trim();
    if (t) console.warn("[worker:encode]", t);
  });

  // CRITICAL: this promise only ever RESOLVES — it stores the error instead of
  // rejecting. If it rejected (e.g. ffmpeg fails at startup) before `finish()`
  // awaits it, Node treats it as an unhandled rejection and CRASHES the whole
  // worker, leaving the job stuck at "rendering" forever.
  let exitError: Error | null = null;
  let hasExited = false;
  const exitPromise = new Promise<void>((resolve) => {
    const done = () => {
      if (scriptPath) void unlink(scriptPath).catch(() => {});
      hasExited = true;
      resolve();
    };
    child.on("error", (err) => {
      if (!exitError) exitError = err as Error;
      done();
    });
    child.on("close", (code) => {
      if (code !== 0 && !exitError) {
        exitError = new Error(`ffmpeg encoder exited ${code}: ${stderrTail.trim()}`);
      }
      // A non-zero exit means the ENCODER died mid-render (e.g. libx264 error) —
      // log the code + stderr tail (worker logs only). code === null is our own
      // kill() on cancel/stall, not a failure.
      if (code !== null && code !== 0) {
        console.error("[worker:encode] ffmpeg encoder exited", {
          code,
          tail: stderrTail.trim().slice(-1000),
        });
      }
      done();
    });
  });
  // Swallow the stdin stream's own 'error' globally so a broken pipe (encoder
  // died) never becomes an unhandled stream error; writeFrame surfaces it.
  const stdin = child.stdin;
  stdin.on("error", () => {});

  return {
    writeFrame(frame: Buffer): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        // Encoder already gone — fail fast so the render loop exits with the
        // real ffmpeg error instead of writing into a dead pipe.
        if (hasExited) {
          reject(exitError ?? new Error("ffmpeg encoder exited before frame write."));
          return;
        }
        const ok = stdin.write(frame, (err) => {
          if (!err) {
            if (ok) resolve();
            return;
          }
          // A write error is almost always a broken pipe because ffmpeg just
          // died (e.g. it can't decode the source audio). The bare EPIPE is
          // useless on its own — prefer the REAL ffmpeg error, which carries the
          // stderr tail. It's set by the 'close' handler, which fires right
          // after the pipe breaks; wait briefly (bounded) for it.
          if (exitError) {
            reject(exitError);
            return;
          }
          Promise.race([
            exitPromise,
            new Promise<void>((r) => setTimeout(r, 2000)),
          ]).then(() => reject(exitError ?? err));
        });
        if (!ok) stdin.once("drain", () => resolve());
      });
    },
    async finish(): Promise<void> {
      await new Promise<void>((resolve) => stdin.end(() => resolve()));
      await exitPromise;
      if (exitError) throw exitError;
    },
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      if (scriptPath) void unlink(scriptPath).catch(() => {});
    },
  };
}
