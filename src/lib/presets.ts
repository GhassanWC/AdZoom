// Single source of truth for built-in presets.
// Each preset is a complete EffectsSettings + identity. Applying a preset
// writes that EffectsSettings (plus the preset id) to the project document.

import type {
  EffectsSettings,
  Preset,
  PresetCategory,
} from "./firebase/schema";

const settings = (over: Partial<EffectsSettings>): EffectsSettings => ({
  // Sensible neutral defaults; each preset overrides what it cares about.
  autoZoom: 72,
  cursorSize: 50,
  cursorSmoothing: 65,
  zoomSpeed: 55,
  motionSensitivity: 70,
  clickHighlightSize: 60,
  clickHighlightStyle: "ring",
  verticalExport: false,
  clickHighlights: true,
  motionTracking: true,
  pacing: "moderate",
  targetPlatform: "youtube",
  defaultExportFormat: "YouTube 16:9",
  ...over,
});

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "preset-mrbeast",
    name: "MrBeast",
    category: "Creator",
    description:
      "Punchy, high-contrast cuts. Aggressive zoom rhythm, oversized click bursts.",
    useCase: "Vlogs, challenges, retention-driven YouTube content.",
    vibe: "mrbeast",
    requiredPlan: "creator",
    effects: settings({
      autoZoom: 92,
      cursorSize: 70,
      cursorSmoothing: 50,
      zoomSpeed: 88,
      motionSensitivity: 78,
      clickHighlightSize: 90,
      clickHighlightStyle: "burst",
      pacing: "fast",
      targetPlatform: "youtube",
      defaultExportFormat: "YouTube 16:9",
    }),
  },
  {
    id: "preset-cinematic",
    name: "Cinematic Focus",
    category: "Creator",
    description:
      "Slow, deliberate zooms. Soft cursor, ring highlights. Feels filmic.",
    useCase: "Trailers, product reveals, founder updates.",
    requiredPlan: "creator",
    vibe: "cinematic",
    effects: settings({
      autoZoom: 68,
      cursorSize: 45,
      cursorSmoothing: 90,
      zoomSpeed: 30,
      motionSensitivity: 55,
      clickHighlightSize: 55,
      clickHighlightStyle: "ring",
      pacing: "slow",
      targetPlatform: "youtube",
      defaultExportFormat: "YouTube 16:9",
    }),
  },
  {
    id: "preset-tutorial",
    name: "Tutorial",
    category: "Tutorial",
    description:
      "Steady zooms held over UI focus. Larger cursor, tooltip-style emphasis.",
    useCase: "How-tos, courses, step-by-step walkthroughs.",
    vibe: "tutorial",
    effects: settings({
      autoZoom: 78,
      cursorSize: 65,
      cursorSmoothing: 75,
      zoomSpeed: 50,
      motionSensitivity: 65,
      clickHighlightSize: 70,
      clickHighlightStyle: "ring",
      pacing: "moderate",
      targetPlatform: "youtube",
      defaultExportFormat: "YouTube 16:9",
    }),
  },
  {
    id: "preset-tiktok",
    name: "TikTok / Reels",
    category: "Short-form",
    description:
      "9:16 vertical reframe, fast pacing, oversized cursor, pulse clicks.",
    useCase: "TikTok, Reels, YouTube Shorts.",
    vibe: "tiktok",
    effects: settings({
      autoZoom: 88,
      cursorSize: 75,
      cursorSmoothing: 60,
      zoomSpeed: 75,
      motionSensitivity: 80,
      clickHighlightSize: 85,
      clickHighlightStyle: "pulse",
      verticalExport: true,
      pacing: "fast",
      targetPlatform: "tiktok",
      defaultExportFormat: "TikTok 9:16",
    }),
  },
  {
    id: "preset-coding",
    name: "Coding Tutorial",
    category: "Coding",
    description:
      "Editor-aware zoom rhythm. Small cursor, smooth motion.",
    useCase: "Code walkthroughs, dev blog clips, IDE tours.",
    vibe: "coding",
    effects: settings({
      autoZoom: 70,
      cursorSize: 38,
      cursorSmoothing: 88,
      zoomSpeed: 42,
      motionSensitivity: 60,
      clickHighlightSize: 45,
      clickHighlightStyle: "ring",
      pacing: "moderate",
      targetPlatform: "youtube",
      defaultExportFormat: "YouTube 16:9",
    }),
  },
  {
    id: "preset-product-demo",
    name: "Product Demo",
    category: "Product Demo",
    requiredPlan: "creator",
    description:
      "Polished SaaS walkthrough. Moderate zoom, soft cursor glow, minimal callouts.",
    useCase: "Investor decks, demo days, landing-page hero loops.",
    vibe: "product",
    effects: settings({
      autoZoom: 74,
      cursorSize: 50,
      cursorSmoothing: 80,
      zoomSpeed: 52,
      motionSensitivity: 65,
      clickHighlightSize: 60,
      clickHighlightStyle: "ring",
      pacing: "moderate",
      targetPlatform: "internal",
      defaultExportFormat: "1080p",
    }),
  },
  {
    id: "preset-saas-pitch",
    name: "SaaS Pitch",
    category: "SaaS",
    requiredPlan: "creator",
    description:
      "Sales-grade demo: clean cursor, deliberate pacing.",
    useCase: "Outbound sales clips, pitch decks, partner demos.",
    vibe: "saas",
    effects: settings({
      autoZoom: 72,
      cursorSize: 48,
      cursorSmoothing: 85,
      zoomSpeed: 48,
      motionSensitivity: 60,
      clickHighlightSize: 58,
      clickHighlightStyle: "ring",
      pacing: "moderate",
      targetPlatform: "internal",
      defaultExportFormat: "1080p",
    }),
  },
  {
    id: "preset-youtube-long",
    name: "YouTube Long",
    category: "Creator",
    description:
      "Long-form pacing — zoom rhythm tuned for 8–15 minute videos.",
    useCase: "Long YouTube videos, podcasts with screen B-roll.",
    vibe: "youtube",
    effects: settings({
      autoZoom: 70,
      cursorSize: 52,
      cursorSmoothing: 75,
      zoomSpeed: 45,
      motionSensitivity: 62,
      clickHighlightSize: 60,
      clickHighlightStyle: "ring",
      pacing: "moderate",
      targetPlatform: "youtube",
      defaultExportFormat: "YouTube 16:9",
    }),
  },
  {
    id: "preset-shorts",
    name: "YouTube Shorts",
    category: "Short-form",
    description:
      "Hook-first. Vertical reframe with extra punch on the first 3 seconds.",
    useCase: "Sub-60s vertical clips for YouTube Shorts.",
    vibe: "shorts",
    effects: settings({
      autoZoom: 90,
      cursorSize: 72,
      cursorSmoothing: 55,
      zoomSpeed: 80,
      motionSensitivity: 82,
      clickHighlightSize: 88,
      clickHighlightStyle: "pulse",
      verticalExport: true,
      pacing: "fast",
      targetPlatform: "youtube",
      defaultExportFormat: "TikTok 9:16",
    }),
  },
  {
    id: "preset-live-demo",
    name: "Live Demo",
    category: "Product Demo",
    requiredPlan: "pro",
    description:
      "Real-time pacing for live calls. Minimal post-production feel.",
    useCase: "Customer demos, sales calls, real-time walkthroughs.",
    vibe: "demo",
    effects: settings({
      autoZoom: 64,
      cursorSize: 55,
      cursorSmoothing: 70,
      zoomSpeed: 38,
      motionSensitivity: 55,
      clickHighlightSize: 55,
      clickHighlightStyle: "ring",
      pacing: "slow",
      targetPlatform: "internal",
      defaultExportFormat: "1080p",
    }),
  },
];

export const BUILTIN_PRESETS_BY_ID: Record<string, Preset> = Object.fromEntries(
  BUILTIN_PRESETS.map((p) => [p.id, p])
);

export const PRESET_CATEGORIES: PresetCategory[] = [
  "Creator",
  "Tutorial",
  "SaaS",
  "Coding",
  "Short-form",
  "Product Demo",
];

/**
 * Apply a preset's settings on top of an existing EffectsSettings, so any
 * fields the preset doesn't define keep their current value. Built-ins
 * provide full settings; custom presets may also have full settings, but
 * this protects against partial data in Firestore.
 */
export function applyPresetToSettings(
  current: EffectsSettings,
  preset: Preset
): EffectsSettings {
  return { ...current, ...preset.effects };
}

/**
 * Detect which preset a project's current settings best match. Used to pre-select
 * a preset in the UI when there's no explicit selectedPresetId saved.
 */
export function inferPresetFromSettings(
  settings: EffectsSettings,
  candidates: Preset[] = BUILTIN_PRESETS
): Preset | null {
  let best: { preset: Preset; score: number } | null = null;
  for (const p of candidates) {
    const score = settingsMatchScore(settings, p.effects);
    if (!best || score > best.score) best = { preset: p, score };
  }
  // Require at least a moderate match to assert "this is your preset"
  return best && best.score > 0.7 ? best.preset : null;
}

function settingsMatchScore(a: EffectsSettings, b: EffectsSettings): number {
  // Compare numeric fields with a tolerance and categorical fields by equality.
  const numericKeys = [
    "autoZoom",
    "cursorSize",
    "cursorSmoothing",
    "zoomSpeed",
    "motionSensitivity",
    "clickHighlightSize",
  ] as const;
  const categoricalKeys = [
    "clickHighlightStyle",
    "verticalExport",
    "clickHighlights",
    "motionTracking",
    "pacing",
    "targetPlatform",
    "defaultExportFormat",
  ] as const;

  let n = 0;
  let total = 0;
  for (const k of numericKeys) {
    total++;
    const diff = Math.abs((a[k] as number) - (b[k] as number));
    // Within 8 = full match, linearly down to 0 at 50.
    n += Math.max(0, 1 - diff / 50);
  }
  for (const k of categoricalKeys) {
    total++;
    if (a[k] === b[k]) n += 1;
  }
  return n / total;
}

export function isBuiltInPresetId(id: string): boolean {
  return id in BUILTIN_PRESETS_BY_ID;
}
