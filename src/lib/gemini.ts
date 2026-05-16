import "server-only";

import { GoogleGenAI, Type, type GenerateContentResponse } from "@google/genai";
import { BUILTIN_PRESETS } from "./presets";

export const ANALYSIS_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let client: GoogleGenAI | null = null;

export function getGemini(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  if (!client) client = new GoogleGenAI({ apiKey: key });
  return client;
}

/**
 * JSON schema for the analysis output. Mirrors `Analysis` in lib/firebase/schema.ts.
 * Gemini will be forced to produce a response that conforms to this shape.
 */
export const ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  required: ["summary", "detectedMoments", "suggestedCaptions", "boringSections"],
  properties: {
    summary: {
      type: Type.STRING,
      description: "1-2 sentence overview of what happens in the recording.",
    },
    detectedMoments: {
      type: Type.ARRAY,
      description:
        "Editorially curated moments distributed across the FULL duration. Up to 18. Sorted by startTime. Not every click deserves emphasis — only the beats a human editor would call attention to.",
      items: {
        type: Type.OBJECT,
        required: [
          "id",
          "startTime",
          "endTime",
          "label",
          "reason",
          "focusRegion",
          "effectType",
          "attentionScore",
          "attentionFactors",
          "uiContext",
          "sceneChange",
          "narrativeRole",
          "recommendedIntensity",
        ],
        properties: {
          id: { type: Type.STRING, description: "Stable kebab-case id, e.g. 'm1', 'm2'." },
          startTime: { type: Type.NUMBER, description: "Seconds from start of video." },
          endTime: { type: Type.NUMBER, description: "Seconds from start of video." },
          label: {
            type: Type.STRING,
            description: "Very short title (3-6 words) for the moment.",
          },
          reason: {
            type: Type.STRING,
            description: "1 sentence explaining why this moment matters to the viewer.",
          },
          focusRegion: {
            type: Type.OBJECT,
            description:
              "Normalized rectangle (0..1) inside the video frame that AdZoom should zoom toward.",
            required: ["x", "y", "width", "height"],
            properties: {
              x: { type: Type.NUMBER },
              y: { type: Type.NUMBER },
              width: { type: Type.NUMBER },
              height: { type: Type.NUMBER },
            },
          },
          effectType: {
            type: Type.STRING,
            description:
              "Choose contextually: zoom for sustained focus/reveals, click-highlight for single click events, cursor-focus for typing/slow cursor follow, speed-up for clear filler.",
            enum: ["zoom", "click-highlight", "cursor-focus", "speed-up"],
          },
          attentionScore: {
            type: Type.NUMBER,
            description:
              "0..1 — how strongly a human editor would emphasize this. 0.9+: dramatic reveals, major state changes (modal opens, navigation, results). 0.6-0.8: deliberate actions worth emphasis. 0.3-0.5: ordinary supporting beats. <0.3: filler — only use to break dead air.",
          },
          attentionFactors: {
            type: Type.OBJECT,
            description: "Editorial sub-scores feeding attentionScore.",
            required: [
              "changeMagnitude",
              "motionIntensity",
              "semanticWeight",
              "viewerConfusionRisk",
            ],
            properties: {
              changeMagnitude: {
                type: Type.NUMBER,
                description: "0..1 — how much the screen visually changed.",
              },
              motionIntensity: {
                type: Type.NUMBER,
                description: "0..1 — cursor/UI motion in this window.",
              },
              semanticWeight: {
                type: Type.NUMBER,
                description:
                  "0..1 — how important this beat is to the recording's story.",
              },
              viewerConfusionRisk: {
                type: Type.NUMBER,
                description:
                  "0..1 — likelihood a viewer misses this without emphasis.",
              },
            },
          },
          uiContext: {
            type: Type.STRING,
            description:
              "What is on screen at this moment. button (CTA click), modal (modal/dialog opening), dialog (alert/popover), form (filling fields), code (code editor activity), navigation (page change), scroll (page scrolling), result (output/success appears), media (image/video appears), text (text emphasis), menu (dropdown/menu open), other.",
            enum: [
              "button",
              "modal",
              "dialog",
              "form",
              "code",
              "navigation",
              "scroll",
              "result",
              "media",
              "text",
              "menu",
              "other",
            ],
          },
          sceneChange: {
            type: Type.BOOLEAN,
            description:
              "True if this is a scene transition — page change, modal open/close, tab switch, layout shift.",
          },
          narrativeRole: {
            type: Type.STRING,
            description:
              "intro: opening framing. setup: preparing to do something. action: a deliberate doing. explanation: explaining without doing. result: the outcome/payoff. transition: connective tissue. filler: idle.",
            enum: [
              "intro",
              "setup",
              "action",
              "explanation",
              "result",
              "transition",
              "filler",
            ],
          },
          recommendedIntensity: {
            type: Type.NUMBER,
            description:
              "0..1 — how strongly the zoom should hit. Small button: 0.3-0.5. Form field focus: 0.4-0.6. Modal open / page reveal: 0.7-0.9. Quiet explanation: 0.25-0.4.",
          },
        },
      },
    },
    suggestedCaptions: {
      type: Type.ARRAY,
      description: "Short on-screen captions (max 8) tied to specific timestamps.",
      items: {
        type: Type.OBJECT,
        required: ["startTime", "text"],
        properties: {
          startTime: { type: Type.NUMBER },
          text: {
            type: Type.STRING,
            description: "Punchy 3-7 word caption that summarizes what's happening.",
          },
        },
      },
    },
    boringSections: {
      type: Type.ARRAY,
      description: "Sections that should be sped up or trimmed. Maximum 4.",
      items: {
        type: Type.OBJECT,
        required: ["startTime", "endTime", "reason"],
        properties: {
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          reason: { type: Type.STRING },
        },
      },
    },
    recommendedPresetIds: {
      type: Type.ARRAY,
      description:
        "Up to 3 preset ids from the provided list that best fit this recording. Sorted from most to least confident.",
      items: { type: Type.STRING },
    },
    videoType: {
      type: Type.STRING,
      description:
        "Overall classification of the recording. coding-tutorial: IDE/editor focused. saas-demo: walking through a SaaS UI. talking-tutorial: a tutorial with significant narration. presentation: slides/keynote style. vertical-short: 9:16 / TikTok-style content. onboarding-flow: signup/setup wizard. mixed: doesn't fit one category.",
      enum: [
        "coding-tutorial",
        "saas-demo",
        "talking-tutorial",
        "presentation",
        "vertical-short",
        "onboarding-flow",
        "mixed",
      ],
    },
    narrativeStructure: {
      type: Type.ARRAY,
      description:
        "Sequential narrative segments covering the FULL duration. 2-6 segments. Each one labels a contiguous time range with its narrative role and a short human label (e.g. 'Opening framing', 'Form fill', 'Result shown').",
      items: {
        type: Type.OBJECT,
        required: ["startTime", "endTime", "role", "label"],
        properties: {
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          role: {
            type: Type.STRING,
            enum: [
              "intro",
              "setup",
              "action",
              "explanation",
              "result",
              "transition",
              "filler",
            ],
          },
          label: { type: Type.STRING, description: "3-6 word human label." },
        },
      },
    },
  },
} as const;

const PRESET_CATALOG = BUILTIN_PRESETS
  .map((p) => `- ${p.id} (${p.category}): ${p.useCase}`)
  .join("\n");

const VALID_PRESET_IDS = new Set(BUILTIN_PRESETS.map((p) => p.id));

/** Build the user-side prompt with explicit quartile bounds, when known. */
function buildUserPrompt(hintedDuration?: number): string {
  if (!hintedDuration || hintedDuration <= 0) {
    return "Analyze this screen recording for AdZoom. Return the structured plan, distributing moments across the FULL video duration with at least one moment per quartile.";
  }
  const d = hintedDuration;
  const q = d / 4;
  const fmt = (s: number) => `${s.toFixed(1)}s`;
  return [
    `Analyze this screen recording for AdZoom. The video is ${d.toFixed(1)} seconds long.`,
    `Distribute moments across the FULL timeline. Specifically:`,
    `- Q1 (${fmt(0)}–${fmt(q)}): include at least 1 moment if the quartile has any visible action.`,
    `- Q2 (${fmt(q)}–${fmt(q * 2)}): include at least 1 moment.`,
    `- Q3 (${fmt(q * 2)}–${fmt(q * 3)}): include at least 1 moment.`,
    `- Q4 (${fmt(q * 3)}–${fmt(d)}): include at least 1 moment — do not leave the ending empty.`,
    `Keep adjacent moments at least ${d < 60 ? 4 : 8} seconds apart. Output the structured plan.`,
  ].join(" ");
}

const SYSTEM_INSTRUCTION = `You are AdZoom's senior video editor. You are not labeling moments — you are directing how a viewer's attention should flow through this recording. Think editorially, not mechanically.

WHAT YOU ARE DECIDING
1. videoType — classify the overall recording (coding-tutorial, saas-demo, talking-tutorial, presentation, vertical-short, onboarding-flow, or mixed).
2. narrativeStructure — segment the recording into 2-6 contiguous narrative beats covering the full duration. Use roles: intro, setup, action, explanation, result, transition, filler.
3. detectedMoments — the editing decisions. Each moment carries an attentionScore, attentionFactors, uiContext, sceneChange flag, narrativeRole, and recommendedIntensity. NOT every click deserves emphasis. Ask yourself: "would a human editor cut to this?" If no, don't include it.
4. suggestedCaptions, boringSections — supporting metadata.
5. recommendedPresetIds — up to 3 from this list:
${PRESET_CATALOG}

ATTENTION SCORING — HOW TO DECIDE WHICH MOMENTS MAKE IT
- 0.9-1.0 ↦ Dramatic reveals. Modal opens, navigation, form submits, code compiles, success state appears, tutorial transitions to the result.
- 0.6-0.8 ↦ Deliberate single actions that benefit from emphasis. A pivotal click, a typed value being confirmed, a hover that reveals something specific.
- 0.3-0.5 ↦ Ordinary supporting beats — keep some, but they don't carry the recording.
- 0.0-0.2 ↦ Filler. Scrolling, idle navigation, repetitive identical clicks. Prefer speed-up over zoom on these, or just omit them.

CONTEXTUAL EFFECT CHOICE (uiContext → effectType bias)
- Code editor activity ("code") → cursor-focus is usually right. Do NOT zoom on every keystroke. Maybe one zoom on a significant edit completion or compile.
- Modal/dialog opening ("modal", "dialog") → zoom. These are reveals and benefit from cinematic emphasis (recommendedIntensity 0.7-0.9).
- Navigation transitions ("navigation") → zoom with sceneChange=true.
- Form fields ("form") → small zoom or cursor-focus (recommendedIntensity 0.4-0.6 — gentle, not dramatic).
- CTA buttons ("button") → click-highlight for ordinary clicks, zoom for clearly important ones.
- Scrolling ("scroll") → cursor-focus or speed-up. Rarely zoom.
- Result/success states ("result") → zoom with high recommendedIntensity. This is your payoff.
- Repetitive identical actions → only emphasize the FIRST or the LAST in the sequence, not every one.

NARRATIVE PACING
- During intro/explanation → calmer, fewer moments, lower intensity (0.3-0.5).
- During action → stronger focus, tighter spacing, intensity 0.6-0.8.
- During result reveal → cinematic emphasis, intensity 0.8-1.0.
- Filler segments → mostly omit; if you include any, mark them speed-up.

ADAPTIVE INTENSITY (recommendedIntensity per moment)
- Small button click: 0.3-0.5 (subtle focus)
- Code typing: 0.25-0.4 (gentle cursor-focus)
- Form field: 0.4-0.6
- Important UI reveal / modal / page change: 0.7-0.9 (dramatic)
- Climactic result moment: 0.85-1.0 (cinematic peak)

DISTRIBUTION (still required)
- The video is split into four quartiles (Q1: 0–25%, Q2: 25–50%, Q3: 50–75%, Q4: 75–100%).
- Each quartile MUST contain at least one moment unless it is genuinely empty/static.
- Adjacent moments at least 4 s apart for <60 s videos, 8 s for longer.
- Never return two moments within 2 seconds.

VIDEO-TYPE GUIDANCE
- coding-tutorial → bias to cursor-focus, mostly low-medium intensity. Reserve zoom for code compiles, errors, or output reveals.
- saas-demo → balance zoom (UI reveals) + click-highlight (CTAs). Higher average intensity.
- talking-tutorial → fewer moments overall, longer holds, calmer pacing.
- vertical-short → tight pacing, higher density, dramatic intensity, lots of click-highlights and short zooms.
- onboarding-flow → step-by-step pacing, one moment per onboarding step.

OTHER CONSTRAINTS
- Never invent timestamps you cannot see. If the entire second half is genuinely static, prefer 1 low-attentionScore moment + a boringSection over hallucinating activity.
- All times are seconds, non-negative, with endTime > startTime.
- focusRegion coordinates must be in [0, 1] and the region must fit inside the frame.
- Keep labels under 6 words and captions under 7 words.
- recommendedPresetIds MUST be a subset of the preset ids listed above. Never invent new ids.
- narrativeStructure segments must be contiguous and cover the full duration with no gaps.
- Output ONLY data matching the provided JSON schema.`;

interface AnalyzeOptions {
  videoBuffer: Buffer;
  mimeType: string;
  hintedDuration?: number;
  fileTooLargeForInline?: boolean;
  uploadedFile?: { uri: string; mimeType: string };
}

export interface UploadedGeminiFile {
  name: string; // resource name, e.g. "files/abc123"
  uri: string;
  mimeType: string;
}

/** Upload a video buffer to the Gemini Files API. The returned file may not be ACTIVE yet. */
export async function uploadVideoToGemini(
  buffer: Buffer,
  mimeType: string
): Promise<UploadedGeminiFile> {
  const ai = getGemini();
  const file = await ai.files.upload({
    file: new Blob([new Uint8Array(buffer)], { type: mimeType }),
    config: { mimeType },
  });
  if (!file.uri || !file.mimeType || !file.name) {
    throw new Error("Gemini file upload returned no URI");
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType };
}

/**
 * Poll the Gemini Files API until the file is ACTIVE (Gemini has finished
 * decoding/indexing it). Throws on FAILED state or when cancelled.
 *
 * This is the fix for "The File X is not in an ACTIVE state and usage is not allowed".
 */
export async function waitForGeminiFileActive(
  fileName: string,
  opts: {
    timeoutMs?: number;
    onProgress?: (state: string, attempt: number) => Promise<void> | void;
    shouldCancel?: () => Promise<boolean> | boolean;
  } = {}
): Promise<void> {
  const ai = getGemini();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const start = Date.now();
  let attempt = 0;
  let delayMs = 1000;
  while (true) {
    if (await opts.shouldCancel?.()) {
      throw new GeminiCancelled("Cancelled by user");
    }
    const file = await ai.files.get({ name: fileName });
    const state = (file.state as string | undefined) ?? "UNKNOWN";
    await opts.onProgress?.(state, attempt);
    if (state === "ACTIVE") return;
    if (state === "FAILED") {
      throw new Error(
        `Gemini failed to process the uploaded video (state=FAILED). It may be an unsupported codec.`
      );
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("Gemini took too long to process the video (timeout)");
    }
    attempt++;
    await new Promise((r) => setTimeout(r, delayMs));
    // Gentle backoff up to 4s
    delayMs = Math.min(4000, delayMs + 500);
  }
}

/** Generate the analysis JSON from an already-ACTIVE Gemini file. */
export async function analyzeWithGeminiFile(
  file: UploadedGeminiFile,
  hintedDuration?: number
): Promise<AnalysisJSON> {
  const ai = getGemini();
  const userPrompt = buildUserPrompt(hintedDuration);
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } } as never,
          { text: userPrompt },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_SCHEMA as never,
      temperature: 0.4,
    },
  });
  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response.");
  let parsed: AnalysisJSON;
  try {
    parsed = JSON.parse(text) as AnalysisJSON;
  } catch {
    throw new Error("Gemini returned non-JSON output.");
  }
  return sanitizeAnalysis(parsed);
}

export class GeminiCancelled extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "GeminiCancelled";
  }
}

import type {
  AttentionFactors,
  NarrativeRole,
  NarrativeSegment,
  UIContext,
  VideoType,
} from "./firebase/schema";

export interface AnalysisJSON {
  summary: string;
  detectedMoments: Array<{
    id: string;
    startTime: number;
    endTime: number;
    label: string;
    reason: string;
    focusRegion: { x: number; y: number; width: number; height: number };
    effectType: "zoom" | "click-highlight" | "cursor-focus" | "speed-up";
    attentionScore: number;
    attentionFactors: AttentionFactors;
    uiContext: UIContext;
    sceneChange: boolean;
    narrativeRole: NarrativeRole;
    recommendedIntensity: number;
    /** legacy compatibility — older runs returned this; new ones return attentionScore */
    importance?: number;
  }>;
  suggestedCaptions: Array<{ startTime: number; text: string }>;
  boringSections: Array<{ startTime: number; endTime: number; reason: string }>;
  recommendedPresetIds: string[];
  videoType: VideoType;
  narrativeStructure: NarrativeSegment[];
}

/**
 * Inline-path analyze for small videos (< INLINE_BYTE_LIMIT). Doesn't go through
 * the Files API, so no ACTIVE wait. The route uses this directly when applicable.
 */
export async function analyzeInline(opts: {
  videoBuffer: Buffer;
  mimeType: string;
  hintedDuration?: number;
}): Promise<AnalysisJSON> {
  const ai = getGemini();
  const userPrompt = buildUserPrompt(opts.hintedDuration);

  const response: GenerateContentResponse = await ai.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              data: opts.videoBuffer.toString("base64"),
              mimeType: opts.mimeType,
            },
          } as never,
          { text: userPrompt },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_SCHEMA as never,
      temperature: 0.4,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response.");
  let parsed: AnalysisJSON;
  try {
    parsed = JSON.parse(text) as AnalysisJSON;
  } catch {
    throw new Error("Gemini returned non-JSON output.");
  }
  return sanitizeAnalysis(parsed);
}

/**
 * @deprecated Kept for backwards-compat — the new route in src/app/api/projects/[id]/analyze
 * uses `uploadVideoToGemini` + `waitForGeminiFileActive` + `analyzeWithGeminiFile` directly
 * so it can interleave Firestore stage updates and cancel checks.
 */
export async function analyzeVideo(opts: AnalyzeOptions): Promise<AnalysisJSON> {
  if (opts.uploadedFile) {
    await waitForGeminiFileActive(opts.uploadedFile.uri.split("/").pop() ?? opts.uploadedFile.uri);
    return analyzeWithGeminiFile(
      { name: opts.uploadedFile.uri, uri: opts.uploadedFile.uri, mimeType: opts.uploadedFile.mimeType },
      opts.hintedDuration
    );
  }
  if (opts.fileTooLargeForInline) {
    const file = await uploadVideoToGemini(opts.videoBuffer, opts.mimeType);
    await waitForGeminiFileActive(file.name);
    return analyzeWithGeminiFile(file, opts.hintedDuration);
  }
  return analyzeInline({
    videoBuffer: opts.videoBuffer,
    mimeType: opts.mimeType,
    hintedDuration: opts.hintedDuration,
  });
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

const UI_CONTEXTS = [
  "button",
  "modal",
  "dialog",
  "form",
  "code",
  "navigation",
  "scroll",
  "result",
  "media",
  "text",
  "menu",
  "other",
] as const;
const NARRATIVE_ROLES = [
  "intro",
  "setup",
  "action",
  "explanation",
  "result",
  "transition",
  "filler",
] as const;
const VIDEO_TYPES = [
  "coding-tutorial",
  "saas-demo",
  "talking-tutorial",
  "presentation",
  "vertical-short",
  "onboarding-flow",
  "mixed",
] as const;

function pickEnum<T extends string>(
  v: unknown,
  values: readonly T[],
  fallback: T
): T {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

function sanitizeAnalysis(a: AnalysisJSON): AnalysisJSON {
  const moments = (a.detectedMoments ?? [])
    .map((m, i) => {
      const attentionScore = clamp01(
        typeof m.attentionScore === "number"
          ? m.attentionScore
          : typeof m.importance === "number"
            ? m.importance
            : 0.5
      );
      const factors: AttentionFactors = {
        changeMagnitude: clamp01(m.attentionFactors?.changeMagnitude ?? attentionScore),
        motionIntensity: clamp01(m.attentionFactors?.motionIntensity ?? 0.4),
        semanticWeight: clamp01(m.attentionFactors?.semanticWeight ?? attentionScore),
        viewerConfusionRisk: clamp01(m.attentionFactors?.viewerConfusionRisk ?? 0.3),
      };
      return {
        id: m.id || `m${i + 1}`,
        startTime: Math.max(0, Number(m.startTime) || 0),
        endTime: Math.max(0, Number(m.endTime) || 0),
        label: (m.label || "Moment").slice(0, 80),
        reason: (m.reason || "").slice(0, 240),
        focusRegion: {
          x: clamp01(m.focusRegion?.x ?? 0.25),
          y: clamp01(m.focusRegion?.y ?? 0.25),
          width: clamp01(m.focusRegion?.width ?? 0.5),
          height: clamp01(m.focusRegion?.height ?? 0.5),
        },
        effectType:
          (["zoom", "click-highlight", "cursor-focus", "speed-up"] as const).includes(
            m.effectType
          )
            ? m.effectType
            : ("zoom" as const),
        attentionScore,
        attentionFactors: factors,
        uiContext: pickEnum<UIContext>(m.uiContext, UI_CONTEXTS, "other"),
        sceneChange: Boolean(m.sceneChange),
        narrativeRole: pickEnum<NarrativeRole>(m.narrativeRole, NARRATIVE_ROLES, "action"),
        recommendedIntensity: clamp01(
          typeof m.recommendedIntensity === "number" ? m.recommendedIntensity : attentionScore
        ),
        // Keep legacy importance mirrored for backwards-compat readers.
        importance: attentionScore,
      };
    })
    .filter((m) => m.endTime > m.startTime)
    .sort((x, y) => x.startTime - y.startTime);

  const captions = (a.suggestedCaptions ?? [])
    .map((c) => ({
      startTime: Math.max(0, Number(c.startTime) || 0),
      text: (c.text || "").slice(0, 80),
    }))
    .filter((c) => c.text.length > 0);

  const boring = (a.boringSections ?? [])
    .map((b) => ({
      startTime: Math.max(0, Number(b.startTime) || 0),
      endTime: Math.max(0, Number(b.endTime) || 0),
      reason: (b.reason || "").slice(0, 240),
    }))
    .filter((b) => b.endTime > b.startTime);

  // Drop any preset ids Gemini hallucinated, and dedupe.
  const recommendedSeen = new Set<string>();
  const recommended: string[] = [];
  for (const id of a.recommendedPresetIds ?? []) {
    if (typeof id === "string" && VALID_PRESET_IDS.has(id) && !recommendedSeen.has(id)) {
      recommendedSeen.add(id);
      recommended.push(id);
      if (recommended.length >= 3) break;
    }
  }

  const videoType = pickEnum<VideoType>(a.videoType, VIDEO_TYPES, "mixed");

  const narrativeStructure: NarrativeSegment[] = (a.narrativeStructure ?? [])
    .map((s) => ({
      startTime: Math.max(0, Number(s.startTime) || 0),
      endTime: Math.max(0, Number(s.endTime) || 0),
      role: pickEnum<NarrativeRole>(s.role, NARRATIVE_ROLES, "action"),
      label: ((s.label as string) || "").slice(0, 60),
    }))
    .filter((s) => s.endTime > s.startTime)
    .sort((x, y) => x.startTime - y.startTime);

  return {
    summary: (a.summary || "").slice(0, 480),
    detectedMoments: moments,
    suggestedCaptions: captions,
    boringSections: boring,
    recommendedPresetIds: recommended,
    videoType,
    narrativeStructure,
  };
}
