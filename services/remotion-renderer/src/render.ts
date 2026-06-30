/**
 * @remotion/renderer wrappers: select the composition once, run a frame-0 smoke
 * test to prove the source decodes, then render ONE H.264/AAC MP4. Video + audio
 * are muxed natively — there is NO custom audiomux.
 *
 * Every entry attaches render diagnostics (browser console, asset-download, and
 * verbose Remotion logs) so a hang/decode failure is observable in Cloud logs.
 */
import {
  selectComposition,
  renderMedia,
  renderStill,
  type CancelSignal,
  type RenderMediaOnProgress,
} from "@remotion/renderer";
import type { FramevoCompositionProps } from "@/remotion/types";

// Keep in sync with FRAMEVO_COMPOSITION_ID in src/remotion/types.ts.
const COMPOSITION_ID = "Framevo";

type SelectedComposition = Awaited<ReturnType<typeof selectComposition>>;
type RenderMediaParams = Parameters<typeof renderMedia>[0];
type RenderStillParams = Parameters<typeof renderStill>[0];

export interface RenderResult {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

/** Log a Chromium console line surfaced by Remotion. */
function browserLog(scope: string) {
  return (l: { type: string; text: string }) =>
    console.info(`[remotion-browser:${scope}] ${l.type}: ${(l.text || "").slice(0, 800)}`);
}

/** Log when Remotion starts downloading an asset (e.g. the OffthreadVideo source)
 *  — proves whether the render even reaches the asset-fetch stage. */
function onAssetDownload(src: string) {
  console.info("[remotion-download] asset fetch start", { src: src.slice(0, 180) });
  return undefined;
}

/** Select the composition (metadata only — does NOT load the video). */
export async function selectFramevoComposition(
  serveUrl: string,
  inputProps: FramevoCompositionProps
): Promise<SelectedComposition> {
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
  });
  console.info("[remotion-worker] composition selected", {
    id: COMPOSITION_ID,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
  });
  return composition;
}

export interface SmokeArgs {
  composition: SelectedComposition;
  serveUrl: string;
  inputProps: FramevoCompositionProps;
  output: string;
  timeoutMs: number;
  gl: string;
  logLevel: string;
}

/** Render frame 0 to a still. Decodes the source video through the SAME
 *  OffthreadVideo pipeline the full render uses, so a decode failure surfaces
 *  here (fast) instead of as a silent full-render hang. */
export async function renderFirstFrame(args: SmokeArgs): Promise<void> {
  await renderStill({
    composition: args.composition,
    serveUrl: args.serveUrl,
    output: args.output,
    frame: 0,
    inputProps: args.inputProps,
    imageFormat: "jpeg",
    chromiumOptions: {
      gl: args.gl as NonNullable<RenderStillParams["chromiumOptions"]>["gl"],
      enableMultiProcessOnLinux: true,
    },
    timeoutInMilliseconds: args.timeoutMs,
    logLevel: args.logLevel as RenderStillParams["logLevel"],
    onBrowserLog: browserLog("still"),
  });
}

export interface RenderArgs {
  composition: SelectedComposition;
  serveUrl: string;
  inputProps: FramevoCompositionProps;
  outputLocation: string;
  crf: number;
  x264Preset: string;
  concurrency: number | null;
  perFrameTimeoutMs: number;
  gl: string;
  logLevel: string;
  cancelSignal: CancelSignal;
  onProgress: RenderMediaOnProgress;
}

export async function renderExport(args: RenderArgs): Promise<RenderResult> {
  await renderMedia({
    composition: args.composition,
    serveUrl: args.serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: args.outputLocation,
    inputProps: args.inputProps,
    crf: args.crf,
    x264Preset: args.x264Preset as RenderMediaParams["x264Preset"],
    imageFormat: "jpeg",
    concurrency: args.concurrency,
    chromiumOptions: {
      gl: args.gl as NonNullable<RenderMediaParams["chromiumOptions"]>["gl"],
      enableMultiProcessOnLinux: true,
    },
    timeoutInMilliseconds: args.perFrameTimeoutMs,
    cancelSignal: args.cancelSignal,
    onProgress: args.onProgress,
    logLevel: args.logLevel as RenderMediaParams["logLevel"],
    onBrowserLog: browserLog("media"),
    onDownload: onAssetDownload,
  });

  return {
    width: args.composition.width,
    height: args.composition.height,
    fps: args.composition.fps,
    durationInFrames: args.composition.durationInFrames,
  };
}
