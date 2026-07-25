/**
 * DEEP Editframe support detection (requirement #7) — codec + source-decode.
 *
 * Runs on click (part of the lazily-imported engine, so mediabunny stays out of
 * the main bundle). Confirms the browser can encode H.264 at the output size and
 * that the SOURCE actually decodes in this browser (exotic codecs — e.g. APAC
 * audio, unusual video — fail here). On any failure it returns a clear reason so
 * the panel can block ONLY the Editframe export and recommend Cloud Export; the
 * cheap synchronous WebCodecs gate lives in `browser-support.ts`.
 */
import {
  ALL_FORMATS,
  Input,
  UrlSource,
  canEncodeVideo,
} from "mediabunny";
import { videoBitrateFor } from "@/components/dashboard/real-editor/export-format";
import type { EditframeResolution } from "./types";

export interface EditframeSupport {
  ok: boolean;
  reason?: string;
}

export async function detectEditframeSupport(opts: {
  sourceUrl: string;
  canvasW: number;
  canvasH: number;
  resolution: EditframeResolution;
  fps: 30 | 60;
}): Promise<EditframeSupport> {
  try {
    const canVideo = await canEncodeVideo("avc", {
      width: opts.canvasW,
      height: opts.canvasH,
      bitrate: videoBitrateFor(opts.resolution, opts.fps),
    });
    if (!canVideo) {
      return {
        ok: false,
        reason: "This browser can't render the export at this size.",
      };
    }

    const input = new Input({
      source: new UrlSource(opts.sourceUrl),
      formats: ALL_FORMATS,
    });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      return {
        ok: false,
        reason: "This recording has no video track the browser can read.",
      };
    }
    if (!(await videoTrack.canDecode())) {
      return {
        ok: false,
        reason: "This recording's format can't be processed in this browser.",
      };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[editframe] support detection failed", err);
    return {
      ok: false,
      reason: "Couldn't verify export support in this browser.",
    };
  }
}
