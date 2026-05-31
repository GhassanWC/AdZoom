"use client";

import * as React from "react";
import {
  AlignLeft,
  AlignRight,
  AlignCenter,
  AlignStartVertical,
  AlignEndVertical,
  Compass,
  Move,
  ArrowRight,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { DetectedMoment, MomentKeyframe } from "@/lib/firebase/schema";
import type { Interaction } from "@/lib/recording/types";
import {
  presetToFocusRegion,
  cursorFollowKeyframes,
  createPanKeyframes,
  type DirectionalPreset,
  type PanDirection,
} from "@/lib/timeline/presets";

/**
 * Two compact rows of camera-direction shortcuts that sit between the
 * effect segmented control and the intensity slider in the inspector:
 *
 *   [ ← Left | → Right | ↑ Top | ↓ Bottom | Center | Follow cursor ]
 *   [ Pan →  | Pan ←   | Pan ↑ | Pan ↓ ]
 *
 * Goal: replace the previous "drag the focus box on the preview" as the
 * ONLY way to set framing. Most users want one click to land the camera
 * on the side of the screen where the action is — these chips do that.
 *
 * Each chip writes via the inspector's existing `onUpdate` callback,
 * stamping `targetRegionSource: "user"` so the balancer's
 * `refineMomentFocalRegion` pass leaves the user's choice alone on any
 * future reframe.
 */
export function DirectionalPresetRow({
  moment,
  interactions,
  interactionsLoading,
  onUpdate,
}: {
  moment: DetectedMoment;
  /** Loaded cursor stream — null when no data is available for the project. */
  interactions: Interaction[] | null;
  /** True while the interactions JSON is still downloading. */
  interactionsLoading: boolean;
  /**
   * Patch handler. We pass `keyframes` only when a preset wants them set
   * (Follow cursor, Pan *) — otherwise we explicitly omit the key so the
   * caller's `updateMoment` doesn't touch existing keyframes. Pan/follow
   * presets always overwrite keyframes; directional presets clear them so
   * the new static framing is visible without animation.
   */
  onUpdate: (patch: Partial<DetectedMoment>) => void;
}) {
  const intensity = moment.intensity ?? moment.recommendedIntensity ?? 0.7;
  const followKeyframes = React.useMemo(
    () =>
      cursorFollowKeyframes(
        interactions,
        { startTime: moment.startTime, endTime: moment.endTime },
        intensity
      ),
    [interactions, moment.startTime, moment.endTime, intensity]
  );

  const applyDirectional = (preset: DirectionalPreset) => {
    const focusRegion = presetToFocusRegion(preset, moment.focusRegion);
    onUpdate({
      focusRegion,
      // Clear any keyframes so the new static framing is what plays —
      // otherwise an old pan path would still animate over the new center.
      keyframes: undefined,
      targetRegionSource: "user",
    });
  };

  const applyFollow = () => {
    if (!followKeyframes) return;
    onUpdate({
      keyframes: followKeyframes,
      targetRegionSource: "user",
    });
  };

  const applyPan = (direction: PanDirection) => {
    const keyframes: MomentKeyframe[] = createPanKeyframes(
      moment.focusRegion,
      direction,
      intensity
    );
    onUpdate({
      keyframes,
      targetRegionSource: "user",
    });
  };

  // The Follow cursor chip is the most context-dependent — disable with a
  // helpful tooltip when we can't honor it instead of silently no-op'ing.
  let followDisabled = false;
  let followTitle = "Pan the camera along the cursor path in this moment";
  if (interactionsLoading) {
    followDisabled = true;
    followTitle = "Loading cursor data…";
  } else if (interactions === null) {
    followDisabled = true;
    followTitle = "No cursor data for this recording (external capture)";
  } else if (!followKeyframes) {
    followDisabled = true;
    followTitle = "No cursor movement in this moment's window";
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-fog">
          Camera
        </span>
        <div className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.02] p-0.5">
          <PresetChip
            label="Left"
            Icon={AlignLeft}
            onClick={() => applyDirectional("left")}
            title="Frame the left side of the video"
          />
          <PresetChip
            label="Top"
            Icon={AlignStartVertical}
            onClick={() => applyDirectional("top")}
            title="Frame the top of the video"
          />
          <PresetChip
            label="Center"
            Icon={AlignCenter}
            onClick={() => applyDirectional("center")}
            title="Center the framing"
          />
          <PresetChip
            label="Bottom"
            Icon={AlignEndVertical}
            onClick={() => applyDirectional("bottom")}
            title="Frame the bottom of the video"
          />
          <PresetChip
            label="Right"
            Icon={AlignRight}
            onClick={() => applyDirectional("right")}
            title="Frame the right side of the video"
          />
          <span aria-hidden className="mx-0.5 h-4 w-px bg-white/[0.06]" />
          <PresetChip
            label="Follow"
            Icon={Compass}
            onClick={applyFollow}
            disabled={followDisabled}
            title={followTitle}
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-fog">
          Pan
        </span>
        <div className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.02] p-0.5">
          <PresetChip
            label="Right"
            Icon={ArrowRight}
            onClick={() => applyPan("right")}
            title="Pan from left edge to right edge across the moment"
          />
          <PresetChip
            label="Left"
            Icon={ArrowLeft}
            onClick={() => applyPan("left")}
            title="Pan from right edge to left edge across the moment"
          />
          <PresetChip
            label="Up"
            Icon={ArrowUp}
            onClick={() => applyPan("up")}
            title="Pan from bottom to top across the moment"
          />
          <PresetChip
            label="Down"
            Icon={ArrowDown}
            onClick={() => applyPan("down")}
            title="Pan from top to bottom across the moment"
          />
          {(moment.keyframes?.length ?? 0) > 0 && (
            <>
              <span aria-hidden className="mx-0.5 h-4 w-px bg-white/[0.06]" />
              <PresetChip
                label="Clear"
                Icon={Move}
                onClick={() =>
                  onUpdate({
                    keyframes: undefined,
                    targetRegionSource: "user",
                  })
                }
                title="Clear the keyframe path and return to static framing"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PresetChip({
  label,
  Icon,
  onClick,
  disabled,
  title,
}: {
  label: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex h-6 items-center justify-center gap-1 rounded px-1.5 text-[10.5px] font-medium transition-colors duration-150",
        disabled
          ? "cursor-not-allowed text-fog/40"
          : "text-fog hover:bg-white/[0.06] hover:text-white"
      )}
    >
      <Icon size={11} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
