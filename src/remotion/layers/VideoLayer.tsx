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
import { activeSpeedAt, buildTimelineMap, type TimelineMap, type TimelineSegment } from "@/lib/timeline/crop-speed";
import { cameraGroupStyle, croppedVideoStyle, coverBlurStyle, sourceTimeForOutput } from "../camera";
import type { FramevoAudioMode } from "../types";

function segmentMidSource(s: TimelineSegment): number {
  return (s.sourceStart + s.sourceEnd) / 2;
}

/** One `<OffthreadVideo>` per timeline segment. `blurred` → the background copy
 *  (cover-filled + blurred, always muted); else the cropped foreground. */
function VideoSegments({
  recipe,
  map,
  src,
  audioMode,
  blurred,
}: {
  recipe: RenderRecipe;
  map: TimelineMap;
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
      {map.segments.map((s, i) => {
        const from = Math.max(0, Math.round(s.outputStart * fps));
        const durationInFrames = Math.max(1, Math.round((s.outputEnd - s.outputStart) * fps));
        const speed = activeSpeedAt(recipe.moments, segmentMidSource(s));
        const muted = blurred || audioMode === "muted" || speed?.audioMode === "mute";
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames} name={`${blurred ? "bg" : "fg"}-seg-${i}`}>
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
  const { fps } = useVideoConfig();
  const map = useMemo(
    () => buildTimelineMap(recipe.moments, recipe.sourceDuration),
    [recipe]
  );

  const sourceTime = sourceTimeForOutput(map, frame / fps);
  const { camera } = resolveCameraFrame(recipe.moments, sourceTime, {
    autoZoom: recipe.effects.autoZoom,
  });
  const groupStyle = useMemo(() => cameraGroupStyle(recipe, camera), [recipe, camera]);

  const showBlurBg = recipe.bgActive && recipe.bgMode === "blur";

  return (
    <>
      {showBlurBg && (
        <AbsoluteFill>
          <VideoSegments recipe={recipe} map={map} src={src} audioMode={audioMode} blurred />
        </AbsoluteFill>
      )}
      <div style={groupStyle}>
        <VideoSegments recipe={recipe} map={map} src={src} audioMode={audioMode} blurred={false} />
        {children}
      </div>
    </>
  );
}
