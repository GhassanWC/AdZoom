/**
 * Native video import.
 *
 * The user picks a file with the OS dialog; the file STAYS WHERE IT IS. What
 * gets stored is a validated absolute path plus the dimensions/duration FFprobe
 * reports — never the bytes, and never anything the renderer can turn back into
 * a path (it only ever receives the opaque `mediaId` and a protocol URL).
 *
 * Nothing here uploads. Cloud sync is a separate, explicit action.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  hasAcceptedVideoExtension,
} from "@/lib/platform/desktop/ipc";
import type { ImportedMedia } from "@/lib/platform/types";
import type { LocalDb } from "./db/client";
import { media, type MediaRow } from "./db/schema";
import { newId } from "./ids";
import { logger } from "./logger";

const execFileP = promisify(execFile);

/** A malformed file must not hang the import — probing is bounded. */
const PROBE_OPTS = { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 } as const;

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
}

/**
 * Validate a path BEFORE anything touches it: absolute, no NUL byte, an
 * accepted container extension, an existing regular file, non-empty. Returns
 * the stat so the caller doesn't have to hit the disk twice.
 */
export function validateVideoPath(path: string): { sizeBytes: number; mtimeMs: number } {
  if (typeof path !== "string" || !path.trim()) {
    throw new MediaValidationError("No file was selected.");
  }
  if (path.includes("\0")) {
    throw new MediaValidationError("That file path is not valid.");
  }
  if (!isAbsolute(path)) {
    throw new MediaValidationError("Only absolute file paths can be imported.");
  }
  if (!hasAcceptedVideoExtension(path)) {
    throw new MediaValidationError(
      `Framevo can import ${ACCEPTED_VIDEO_EXTENSIONS.join(", ")} files. "${extname(path) || "that file"}" isn't supported.`
    );
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new MediaValidationError("That file no longer exists on this computer.");
  }
  if (!stat.isFile()) throw new MediaValidationError("That path is not a file.");
  if (stat.size === 0) throw new MediaValidationError("That file is empty.");
  return { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function parseRate(raw: string | undefined): number {
  if (!raw) return 0;
  const [n, d] = raw.split("/");
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

/** Read real dimensions/duration/codecs. Mirrors the export worker's probe. */
export async function probeVideo(ffprobeBin: string, path: string): Promise<ProbeResult> {
  if (!ffprobeBin) throw new MediaValidationError("The video engine is unavailable.");
  let stdout: string;
  try {
    ({ stdout } = await execFileP(
      ffprobeBin,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
      PROBE_OPTS
    ));
  } catch {
    throw new MediaValidationError("Framevo couldn't read that video file.");
  }
  let json: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      r_frame_rate?: string;
      disposition?: { attached_pic?: number };
    }>;
    format?: { duration?: string };
  };
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new MediaValidationError("Framevo couldn't read that video file.");
  }
  const streams = json.streams ?? [];
  const video = streams.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1
  );
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video?.width || !video.height) {
    throw new MediaValidationError("That file has no video track Framevo can edit.");
  }
  const durationSec = Number(json.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new MediaValidationError("That video has no readable duration.");
  }
  return {
    durationSec,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name ?? "",
    audioCodec: audio?.codec_name ?? "",
  };
}

/** Row → the renderer-facing shape (no path, ever). */
export function toImportedMedia(row: MediaRow, urlFor: (id: string) => string): ImportedMedia {
  return {
    mediaId: row.id,
    url: urlFor(row.id),
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    codecSummary: [row.videoCodec, row.audioCodec].filter(Boolean).join(" · ") || undefined,
  };
}

export interface MediaStore {
  /** Validate + probe + record a picked file. */
  importPath(path: string): Promise<MediaRow>;
  get(mediaId: string): Promise<MediaRow | null>;
  /** Re-check that the file is still there and unchanged. */
  revalidate(mediaId: string): Promise<{ row: MediaRow; ok: boolean; reason?: string } | null>;
  /**
   * Write a finished screen recording into the library folder and import it.
   *
   * This is the ONE case where Framevo owns the bytes on disk (`owned: true`),
   * because it produced them — a recording has nowhere else to live. Everything
   * downstream is the ordinary import path: same validation, same probe, same
   * media row, so a recorded project and an imported one are indistinguishable
   * to the editor.
   */
  saveRecording(bytes: ArrayBuffer, fileName: string): Promise<MediaRow>;
  /**
   * Import a file Framevo already wrote into its own library folder — today,
   * a source video downloaded back from the cloud.
   *
   * The difference from `importPath` is ownership: this file is app data, so it
   * may be deleted by the Storage screen, whereas a file the user picked from
   * their own Documents folder never may. As with `saveRecording`, the flag is
   * set only AFTER the probe succeeds, so a file we could not decode is never
   * left behind marked as ours to delete.
   */
  adopt(path: string): Promise<MediaRow>;
}

export function createMediaStore(
  db: LocalDb,
  ffprobeBin: () => string,
  recordingsDir?: string
): MediaStore {
  const store: MediaStore = {
    async importPath(path) {
      const { sizeBytes, mtimeMs } = validateVideoPath(path);
      const probe = await probeVideo(ffprobeBin(), path);

      // Re-importing the same file (same path + size + mtime) reuses its row so
      // two projects can share one video without duplicating anything.
      const existing = (await db.select().from(media).where(eq(media.path, path)).limit(1))[0];
      if (existing && existing.sizeBytes === sizeBytes && existing.mtimeMs === mtimeMs) {
        return existing;
      }

      const row: MediaRow = {
        id: existing?.id ?? newId(),
        path,
        fileName: basename(path),
        sizeBytes,
        mtimeMs,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        createdAt: existing?.createdAt ?? Date.now(),
        // A picked file belongs to the user; re-importing never claims it.
        owned: existing?.owned ?? false,
      };
      if (existing) {
        await db.update(media).set(row).where(eq(media.id, existing.id));
        logger.info("media re-probed after external change", { mediaId: row.id });
      } else {
        await db.insert(media).values(row);
        logger.info("media imported", {
          mediaId: row.id,
          width: row.width,
          height: row.height,
          durationSec: Math.round(row.durationSec),
        });
      }
      return row;
    },

    async get(mediaId) {
      const rows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
      return rows[0] ?? null;
    },

    async revalidate(mediaId) {
      const rows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
      const row = rows[0];
      if (!row) return null;
      try {
        const { sizeBytes } = validateVideoPath(row.path);
        if (sizeBytes !== row.sizeBytes) {
          return { row, ok: true, reason: "The source file changed since it was imported." };
        }
        return { row, ok: true };
      } catch (err) {
        return {
          row,
          ok: false,
          reason: err instanceof Error ? err.message : "The source file is unavailable.",
        };
      }
    },

    async saveRecording(bytes, fileName) {
      if (!recordingsDir) {
        throw new MediaValidationError("This build cannot save recordings locally.");
      }
      await mkdir(recordingsDir, { recursive: true });
      // The name is already sanitised by the IPC validator; the timestamp makes
      // it unique so two takes in one session never overwrite each other.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dot = fileName.lastIndexOf(".");
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : ".webm";
      const path = join(recordingsDir, `${stem} ${stamp}${ext}`);

      await writeFile(path, Buffer.from(bytes));
      const row = await store.adopt(path);
      logger.info("recording saved", { mediaId: row.id, sizeBytes: row.sizeBytes });
      return row;
    },

    async adopt(path) {
      try {
        const row = await store.importPath(path);
        // Mark it ours AFTER the import succeeds, so a file we failed to probe
        // is never left behind flagged as deletable app data.
        await db.update(media).set({ owned: true }).where(eq(media.id, row.id));
        return { ...row, owned: true };
      } catch (err) {
        // Don't leave an unusable file in the library folder.
        await rm(path, { force: true }).catch(() => undefined);
        throw err;
      }
    },
  };

  return store;
}
