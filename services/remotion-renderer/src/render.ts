/**
 * Thin wrapper over @remotion/renderer: select the Framevo composition (metadata
 * resolved from the recipe via calculateMetadata) and render ONE H.264/AAC MP4.
 * Video + audio are muxed natively by Remotion — there is NO custom audiomux.
 */
import {
  selectComposition,
  renderMedia,
  type CancelSignal,
  type RenderMediaOnProgress,
} from "@remotion/renderer";
import type { FramevoCompositionProps } from "@/remotion/types";

// Keep in sync with FRAMEVO_COMPOSITION_ID in src/remotion/types.ts.
const COMPOSITION_ID = "Framevo";

export interface RenderArgs {
  serveUrl: string;
  inputProps: FramevoCompositionProps;
  outputLocation: string;
  crf: number;
  x264Preset: string;
  concurrency: number | null;
  perFrameTimeoutMs: number;
  cancelSignal: CancelSignal;
  onProgress: RenderMediaOnProgress;
}

export interface RenderResult {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export async function renderExport(args: RenderArgs): Promise<RenderResult> {
  const composition = await selectComposition({
    serveUrl: args.serveUrl,
    id: COMPOSITION_ID,
    inputProps: args.inputProps,
  });
  console.info("[remotion-worker] composition selected", {
    id: COMPOSITION_ID,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
  });

  await renderMedia({
    composition,
    serveUrl: args.serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: args.outputLocation,
    inputProps: args.inputProps,
    crf: args.crf,
    x264Preset: args.x264Preset as Parameters<typeof renderMedia>[0]["x264Preset"],
    imageFormat: "jpeg",
    concurrency: args.concurrency,
    chromiumOptions: { enableMultiProcessOnLinux: true },
    timeoutInMilliseconds: args.perFrameTimeoutMs,
    cancelSignal: args.cancelSignal,
    onProgress: args.onProgress,
  });

  return {
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
  };
}
