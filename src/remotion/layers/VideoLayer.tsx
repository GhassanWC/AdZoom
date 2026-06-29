/**
 * VideoLayer — renders the screen recording across the cut/speed timeline and
 * applies the per-frame camera (zoom/pan/crop). One `<OffthreadVideo>` per
 * surviving `TimelineSegment`, time-shifted into the output by a `<Sequence>`:
 *   • cuts        → gaps between segments (removed time)
 *   • speed       → `playbackRate = segment.speedMultiplier` (audio speeds too)
 *   • per-section → `audioMode:"mute"` mutes that segment; global "muted" mutes all
 * Remotion muxes the audio natively — there is NO custom audiomux/concat.
 *
 * The whole thing sits inside ONE camera-group element whose CSS transform is
 * computed from the current frame's SOURCE time (same `resolveCameraFrame` the
 * editor preview calls), so only the active segment is visible and the camera
 * follows it. An optional blurred-cover background (Canvas-Fit `blur` mode) is
 * drawn behind, outside the camera. `children` (the click-highlight overlay) are
 * placed INSIDE the camera group so they scale with the zoom.
 */
import { useMemo, type ReactNode } from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderRecipe } from "@/lib/render/recipe";
import { resolveCameraFrame } from "@/lib/timeline/camera";
import { activeSpeedAt, buildTimelineMap } from "@/lib/timeline/crop-speed";
import {
  cameraGroupStyle,
  croppedVideoStyle,
  coverBlurStyle,
  buildOutputFrameSegments,
  sourceTimeForFrame,
  type OutputFrameSegment,
} from "../camera";
import type { FramevoAudioMode } from "../types";

/** One `<OffthreadVideo>` per timeline segment, tiled on the integer output-frame
 *  grid (contiguous by construction — no gaps/overlaps). `blurred` → the
 *  background copy (cover-filled + blurred, always muted); else the cropped fg. */
function VideoSegments({
  recipe,
  segments,
  src,
  audioMode,
  blurred,
}: {
  recipe: RenderRecipe;
  segments: OutputFrameSegment[];
  src: string;
  audioMode: FramevoAudioMode;
  blurred: boolean;
}): React.JSX.Element {
  const { fps } = useVideoConfig();
  const style = useMemo(
    () => (blurred ? coverBlurStyle(recipe) : croppedVideoStyle(recipe)),
    [recipe, blurred]
  );
  return (
    <>
      {segments.map((s, i) => {
        const midSource = (s.sourceStart + s.sourceEnd) / 2;
        const speed = activeSpeedAt(recipe.moments, midSource);
        const muted = blurred || audioMode === "muted" || speed?.audioMode === "mute";
        return (
          <Sequence
            key={i}
            from={s.fromFrame}
            durationInFrames={s.durInFrames}
            name={`${blurred ? "bg" : "fg"}-seg-${i}`}
          >
            <OffthreadVideo
              src={src}
              trimBefore={Math.max(0, Math.round(s.sourceStart * fps))}
              playbackRate={s.speedMultiplier}
              muted={muted}
              style={style}
            />
          </Sequence>
        );
      })}
    </>
  );
}

export function VideoLayer({
  recipe,
  src,
  audioMode = "source",
  children,
}: {
  recipe: RenderRecipe;
  src: string;
  audioMode?: FramevoAudioMode;
  children?: ReactNode;
}): React.JSX.Element {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const segments = useMemo(
    () => buildOutputFrameSegments(buildTimelineMap(recipe.moments, recipe.sourceDuration), fps, durationInFrames),
    [recipe, fps, durationInFrames]
  );

  // Camera samples the SAME frame windows the videos are tiled on, so the
  // transform always tracks the segment actually mounted at this frame.
  const sourceTime = sourceTimeForFrame(segments, frame, fps, recipe.sourceDuration);
  const { camera } = resolveCameraFrame(recipe.moments, sourceTime, {
    autoZoom: recipe.effects.autoZoom,
  });
  const groupStyle = useMemo(() => cameraGroupStyle(recipe, camera), [recipe, camera]);

  const showBlurBg = recipe.bgActive && recipe.bgMode === "blur";

  return (
    <>
      {showBlurBg && (
        <AbsoluteFill>
          <VideoSegments recipe={recipe} segments={segments} src={src} audioMode={audioMode} blurred />
        </AbsoluteFill>
      )}
      <div style={groupStyle}>
        <VideoSegments recipe={recipe} segments={segments} src={src} audioMode={audioMode} blurred={false} />
        {children}
      </div>
    </>
  );
}
