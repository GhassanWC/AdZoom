/**
 * Hardware encoder detection.
 *
 * Two questions, and they are NOT the same:
 *   1. Is the encoder compiled into the bundled FFmpeg? (`ffmpeg -encoders`)
 *   2. Can this machine actually run it? A laptop with an AMD build of FFmpeg
 *      and no AMD GPU lists `h264_amf` happily and then fails at init.
 *
 * So a candidate is only "available" after a real one-frame trial encode to the
 * null muxer. That probe costs ~200ms, is cached for the session, and is the
 * difference between "we picked NVENC" and "the export died 40 minutes in".
 *
 * `libx264` (software) is always last and always available — the fallback that
 * makes export work on any machine.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EncoderId, EncoderInfo } from "@/lib/platform/types";
import { logger } from "../logger";

const execFileP = promisify(execFile);
const PROBE_TIMEOUT_MS = 20_000;

interface Candidate {
  id: EncoderId;
  label: string;
  hardware: boolean;
  /** Platforms where it is worth probing at all. */
  platforms: NodeJS.Platform[];
}

/** Preference order: hardware first (fastest), software last (universal). */
const CANDIDATES: Candidate[] = [
  { id: "h264_nvenc", label: "NVIDIA NVENC", hardware: true, platforms: ["win32", "linux"] },
  { id: "h264_qsv", label: "Intel Quick Sync", hardware: true, platforms: ["win32", "linux"] },
  { id: "h264_amf", label: "AMD AMF", hardware: true, platforms: ["win32", "linux"] },
  { id: "h264_videotoolbox", label: "Apple VideoToolbox", hardware: true, platforms: ["darwin"] },
  { id: "libx264", label: "Software (libx264)", hardware: false, platforms: ["win32", "darwin", "linux"] },
];

/**
 * The encoder-specific quality flags. `crf` is Framevo's single quality dial
 * (the same value the cloud render uses); each encoder expresses it in its own
 * currency, chosen to land visually in the same place:
 *
 *   libx264      CRF          — the reference.
 *   NVENC        CQ (VBR)     — same 0–51 scale, quality-targeted VBR.
 *   Quick Sync   global_quality on the ICQ scale (same 0–51 sense).
 *   AMF          CQP          — I/P/B quantisers set to the same value.
 *   VideoToolbox q:v 1–100    — inverted scale, mapped from CRF.
 */
export function encoderArgs(id: EncoderId, crf: number, preset: string): string[] {
  switch (id) {
    case "h264_nvenc":
      return ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(crf), "-b:v", "0"];
    case "h264_qsv":
      return ["-preset", "medium", "-global_quality", String(crf), "-look_ahead", "0"];
    case "h264_amf":
      return ["-quality", "balanced", "-rc", "cqp", "-qp_i", String(crf), "-qp_p", String(crf), "-qp_b", String(crf)];
    case "h264_videotoolbox": {
      // CRF 18→~82, 23→~70, 28→~58 on VideoToolbox's 1–100 quality scale.
      const q = Math.max(1, Math.min(100, Math.round(100 - crf * 1.7)));
      return ["-q:v", String(q)];
    }
    case "libx264":
    default:
      return ["-preset", preset, "-crf", String(crf)];
  }
}

/** Parse `ffmpeg -encoders` into the set of encoder names it was built with. */
export function parseEncoderList(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    // " V....D h264_nvenc           NVIDIA NVENC H.264 encoder"
    const m = /^\s*[VAS][0-9A-Z.]{5}\s+(\S+)/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

let cache: EncoderInfo[] | null = null;

/**
 * Detect usable encoders, best first. Cached per session — the GPU does not
 * change while the app is running.
 */
export async function detectEncoders(
  ffmpegBin: string,
  platform: NodeJS.Platform = process.platform
): Promise<EncoderInfo[]> {
  if (cache) return cache;
  if (!ffmpegBin) {
    cache = [{ id: "libx264", label: "Software (libx264)", available: false, hardware: false, detail: "FFmpeg is unavailable." }];
    return cache;
  }

  let built: Set<string>;
  try {
    const { stdout } = await execFileP(ffmpegBin, ["-hide_banner", "-encoders"], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    built = parseEncoderList(stdout);
  } catch (err) {
    logger.warn("encoder list failed", { error: (err as Error).message });
    built = new Set(["libx264"]);
  }

  const results: EncoderInfo[] = [];
  for (const candidate of CANDIDATES) {
    if (!candidate.platforms.includes(platform)) continue;
    if (!built.has(candidate.id)) {
      results.push({
        id: candidate.id,
        label: candidate.label,
        hardware: candidate.hardware,
        available: false,
        detail: "Not included in this FFmpeg build.",
      });
      continue;
    }
    // Software x264 needs no trial — if it is built in, it runs.
    if (!candidate.hardware) {
      results.push({ id: candidate.id, label: candidate.label, hardware: false, available: true });
      continue;
    }
    const trial = await trialEncode(ffmpegBin, candidate.id);
    results.push({
      id: candidate.id,
      label: candidate.label,
      hardware: true,
      available: trial.ok,
      detail: trial.ok ? undefined : trial.reason,
    });
  }

  logger.info("encoder detection complete", {
    available: results.filter((r) => r.available).map((r) => r.id),
  });
  cache = results;
  return results;
}

/** Encode a single synthetic frame — proves driver + hardware, not just the build. */
async function trialEncode(
  ffmpegBin: string,
  id: EncoderId
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await execFileP(
      ffmpegBin,
      [
        "-hide_banner",
        "-v", "error",
        "-f", "lavfi",
        "-i", "color=c=black:s=320x240:r=30:d=0.1",
        "-c:v", id,
        ...encoderArgs(id, 28, "veryfast"),
        "-pix_fmt", "yuv420p",
        "-frames:v", "1",
        "-f", "null",
        "-",
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    );
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message ?? "";
    // Keep the reason short and non-technical enough for a tooltip.
    const reason = /No capable devices|Cannot load|not supported|InitializeEncoder|Failed to initialise|device/i.test(stderr)
      ? "No compatible hardware found on this machine."
      : "This machine's driver rejected the encoder.";
    return { ok: false, reason };
  }
}

/** The encoder an "auto" export should use: the first available candidate. */
export function pickEncoder(encoders: EncoderInfo[], requested?: EncoderId | "auto"): EncoderInfo {
  const fallback: EncoderInfo = {
    id: "libx264",
    label: "Software (libx264)",
    hardware: false,
    available: true,
  };
  if (requested && requested !== "auto") {
    const exact = encoders.find((e) => e.id === requested && e.available);
    if (exact) return exact;
    // An explicitly requested encoder that isn't usable falls back rather than
    // failing the export — the result still gets produced, just more slowly.
    logger.warn("requested encoder unavailable — falling back", { requested });
  }
  return encoders.find((e) => e.available) ?? fallback;
}

/** Test hook — clears the session cache. */
export function resetEncoderCache(): void {
  cache = null;
}
