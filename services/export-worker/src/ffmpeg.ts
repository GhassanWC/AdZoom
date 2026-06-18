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

export interface SourceInfo {
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  audioSampleRate: number;
  /** Audio codec name per ffprobe (e.g. "aac", "opus"); "" if no audio. May be
   *  "none"/"unknown" for codecs the build can't identify (e.g. Apple `apac`). */
  audioCodec: string;
  /** Four-char codec tag (e.g. "apac") — useful when codec_name is "none". */
  audioCodecTag: string;
}

export async function probeSource(path: string): Promise<SourceInfo> {
  const { stdout } = await execFileP(ffprobeBin(), [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  const json = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      codec_tag_string?: string;
      width?: number;
      height?: number;
      sample_rate?: string;
    }>;
    format?: { duration?: string };
  };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    durationSec: Number(json.format?.duration ?? 0),
    hasAudio: !!a,
    audioSampleRate: a?.sample_rate ? Number(a.sample_rate) : 48000,
    audioCodec: a?.codec_name ?? "",
    audioCodecTag: a?.codec_tag_string ?? "",
  };
}

/**
 * Can the bundled ffmpeg actually DECODE this file's first audio stream? Some
 * containers carry codecs the static build has no decoder for — notably Apple's
 * `apac` spatial-audio codec, which makes the encoder abort at startup
 * ("no decoder found for: none") and leaves the frame writer with a bare EPIPE.
 * We decode a short slice to the null muxer up front, so the render can fall
 * back to a silent export (with a clear warning) instead of crashing.
 *
 * Returns false on ANY decode failure (unknown codec, corrupt stream, or a
 * missing binary) — the caller treats that as "drop audio", which is always the
 * safe degradation. Only call when `probeSource` reported `hasAudio`.
 */
export async function canDecodeAudio(path: string): Promise<boolean> {
  try {
    await execFileP(ffmpegBin(), [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      // Decode a brief slice only — enough to prove the decoder works without
      // processing the whole track.
      "-t",
      "0.5",
      "-f",
      "null",
      "-",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A pull-based reader over the decoder's rawvideo stdout. `next()` resolves the
 * next full RGBA frame (a `frameBytes`-length Buffer) or null at EOF. The
 * underlying stream is paused whenever the buffered backlog exceeds a few
 * frames, so decode throttles to consumption.
 */
export interface FrameReader {
  next(): Promise<Buffer | null>;
  destroy(): void;
}

function makeFrameReader(stream: Readable, frameBytes: number): FrameReader {
  const MAX_BACKLOG = frameBytes * 4; // ~4 frames in flight
  let buffered: Buffer = Buffer.alloc(0);
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
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    if (buffered.length >= MAX_BACKLOG && !paused) {
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

  return {
    async next(): Promise<Buffer | null> {
      for (;;) {
        if (errored) throw errored;
        if (buffered.length >= frameBytes) {
          const frame = buffered.subarray(0, frameBytes);
          buffered = buffered.subarray(frameBytes);
          if (paused && buffered.length < MAX_BACKLOG) {
            paused = false;
            stream.resume();
          }
          // Copy out so a later concat can't alias this frame's memory.
          return Buffer.from(frame);
        }
        if (ended) return null;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
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
    // Map the source's first audio stream straight through (`?` = tolerate if,
    // despite the probe, it's somehow absent rather than failing the whole job).
    args.push(
      "-i",
      sourcePath,
      "-map",
      "0:v",
      "-map",
      "1:a?",
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
