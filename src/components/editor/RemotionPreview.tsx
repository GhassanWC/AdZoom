"use client";
/**
 * Editor preview powered by @remotion/player rendering the SAME
 * <FramevoComposition> the cloud export renders — so what you scrub is what you
 * get. Shipped behind NEXT_PUBLIC_REMOTION_PREVIEW so it can be validated against
 * the existing canvas preview (RealVideoPlayer) before becoming the default.
 */
import { Player } from "@remotion/player";
import { FramevoComposition } from "@/remotion/FramevoComposition";
import { resolveFramevoMetadata, type FramevoCompositionProps } from "@/remotion/types";

/** True when the Remotion Player preview is enabled (build/runtime flag). */
export const REMOTION_PREVIEW_ENABLED =
  process.env.NEXT_PUBLIC_REMOTION_PREVIEW === "1" ||
  process.env.NEXT_PUBLIC_REMOTION_PREVIEW === "true";

export function RemotionPreview({
  recipe,
  src,
  audioMode = "source",
  className,
  style,
}: FramevoCompositionProps & { className?: string; style?: React.CSSProperties }): React.JSX.Element {
  const meta = resolveFramevoMetadata({ recipe, src, audioMode });
  return (
    <Player
      component={FramevoComposition}
      inputProps={{ recipe, src, audioMode }}
      durationInFrames={meta.durationInFrames}
      fps={meta.fps}
      compositionWidth={meta.width}
      compositionHeight={meta.height}
      controls
      acknowledgeRemotionLicense
      className={className}
      style={{ width: "100%", ...style }}
    />
  );
}
