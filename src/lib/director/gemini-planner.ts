import "server-only";

/**
 * AI Director — the Gemini planner.
 *
 * The ONLY module that talks to a model. It is deliberately thin: it asks Gemini
 * for a `DirectorPlan`-shaped JSON, hands the raw response straight to
 * `sanitizeDirectorPlan`, and returns. Everything that decides whether the plan
 * is *acceptable* lives in `validate.ts`, which runs afterwards on every path.
 *
 * Two properties follow from that split, and both matter:
 *
 *   1. The model can't smuggle an edit type past the allowlist, invent a
 *      timestamp past the end of the video, or duplicate an operation — the same
 *      gate that guards the heuristic plan guards this one.
 *
 *   2. If Gemini is unavailable, rate-limited, slow, or returns junk, the
 *      Director still works. `planDirector` falls back to `buildHeuristicPlan`,
 *      which produces a complete plan from the project's own signals. The
 *      feature degrades in quality, never in function.
 *
 * The model never sees the video here — the expensive visual understanding
 * already happened during analysis and lives in the context. Planning is a text
 * call over what Framevo already knows, which is what keeps it fast enough to
 * re-run on every revision.
 */
import { Type, type GenerateContentResponse } from "@google/genai";
import { getGemini, ANALYSIS_MODEL } from "../gemini";
import { presetCatalogueForModel } from "../presets/director";
import { PRESET_IDS, presetsByCategory } from "../presets/registry";
import {
  describeContextForModel,
  type DirectorVideoContext,
} from "./context-builder";
import { buildHeuristicPlan, sanitizeDirectorPlan } from "./planner";
import { parseRevisionCommand, type DirectorRevisionIntent } from "./revision";
import {
  DIRECTOR_EDIT_TYPES,
  DIRECTOR_SECTION_KINDS,
  type DirectorPlan,
  type DirectorRequest,
} from "./types";

export const DIRECTOR_MODEL = process.env.GEMINI_DIRECTOR_MODEL || ANALYSIS_MODEL;

/** Planning is a text call over a digest — it should never take a minute. */
const PLAN_TIMEOUT_MS = 45_000;

/** Caption designs only — a `title-*` id in the caption slot is a category error. */
const CAPTION_PRESET_IDS: readonly string[] = presetsByCategory("captions").map((p) => p.id);

const EVIDENCE_SCHEMA = {
  type: Type.ARRAY,
  description:
    "Why you believe this. Cite the REAL datum you used — a moment id, a transcript segment id, a dead-zone id from the context. Never invent a reference.",
  items: {
    type: Type.OBJECT,
    required: ["kind", "detail"],
    properties: {
      kind: {
        type: Type.STRING,
        enum: [
          "transcript",
          "click",
          "moment",
          "silence",
          "scene",
          "narrative",
          "attention",
          "user-request",
          "heuristic",
        ],
      },
      detail: { type: Type.STRING, description: "One short sentence." },
      ref: { type: Type.STRING, description: "The id of the datum, when there is one." },
      at: { type: Type.NUMBER, description: "Source timestamp in seconds." },
    },
  },
} as const;

const OP_BASE_PROPS = {
  id: { type: Type.STRING, description: "Stable kebab-case id, unique in the plan." },
  startTime: { type: Type.NUMBER, description: "Seconds from the start of the SOURCE video." },
  endTime: { type: Type.NUMBER, description: "Seconds. Must be > startTime." },
  reason: { type: Type.STRING, description: "One sentence the user will read on the edit itself." },
  confidence: { type: Type.NUMBER, description: "0..1 — how sure you are." },
  priority: { type: Type.NUMBER, description: "0..1 — what to sacrifice LAST when the target duration bites." },
  sectionId: { type: Type.STRING, description: "The storyStructure section id this serves." },
  evidence: EVIDENCE_SCHEMA,
} as const;

const DIRECTOR_PLAN_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "goal",
    "storyStructure",
    "clipOperations",
    "editOperations",
    "audioOperations",
    "captionInstructions",
    "explanation",
  ],
  properties: {
    goal: { type: Type.STRING, description: "Restate the user's goal in one sentence." },
    tone: { type: Type.STRING },
    explanation: {
      type: Type.STRING,
      description:
        "2-4 sentences: the structure you chose, what you removed and why, and anything you deliberately did NOT do.",
    },

    storyStructure: {
      type: Type.ARRAY,
      description:
        "The narrative spine, in order. Every kept second should belong to a section. Sections must not overlap.",
      items: {
        type: Type.OBJECT,
        required: ["id", "kind", "title", "startTime", "endTime", "reason", "confidence", "evidence"],
        properties: {
          id: { type: Type.STRING },
          kind: { type: Type.STRING, enum: [...DIRECTOR_SECTION_KINDS] },
          title: { type: Type.STRING, description: "3-5 word human title." },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          reason: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          evidence: EVIDENCE_SCHEMA,
        },
      },
    },

    clipOperations: {
      type: Type.ARRAY,
      description:
        "What survives and what goes. `keep` = protect this window. `remove` = drop it. `trim` = tighten an edge. NEVER use `reorder` — Framevo cannot render out-of-order clips and the operation will be rejected.",
      items: {
        type: Type.OBJECT,
        required: ["id", "kind", "startTime", "endTime", "reason", "confidence", "priority", "evidence"],
        properties: {
          ...OP_BASE_PROPS,
          kind: { type: Type.STRING, enum: ["keep", "remove", "trim"] },
        },
      },
    },

    editOperations: {
      type: Type.ARRAY,
      description:
        "The edits. `editType` MUST be one of the listed values — these are the only edits Framevo can apply. Do NOT emit `captions` here: captions come from the transcript via captionInstructions.",
      items: {
        type: Type.OBJECT,
        required: ["id", "editType", "startTime", "endTime", "reason", "confidence", "priority", "evidence"],
        properties: {
          ...OP_BASE_PROPS,
          editType: {
            type: Type.STRING,
            enum: DIRECTOR_EDIT_TYPES.filter((t) => t !== "captions"),
          },
          intensity: { type: Type.NUMBER, description: "0..1 camera strength (zoom / focus)." },
          focusRegion: {
            type: Type.OBJECT,
            description: "Normalized 0..1 rect to point the camera / callout at.",
            required: ["x", "y", "width", "height"],
            properties: {
              x: { type: Type.NUMBER },
              y: { type: Type.NUMBER },
              width: { type: Type.NUMBER },
              height: { type: Type.NUMBER },
            },
          },
          params: {
            type: Type.OBJECT,
            description: "Type-specific settings.",
            properties: {
              text: { type: Type.STRING, description: "REQUIRED for hook-text / text-overlay / callout." },
              ctaText: { type: Type.STRING, description: "REQUIRED for branding-cta." },
              speedMultiplier: { type: Type.NUMBER, description: "REQUIRED for speed-up. > 1." },
              transitionStyle: {
                type: Type.STRING,
                enum: ["fade", "zoom", "swipe", "flash", "smooth_cut"],
              },
              calloutStyle: {
                type: Type.STRING,
                enum: ["arrow", "box", "spotlight", "underline", "circle"],
              },
              aspectRatio: { type: Type.STRING, enum: ["original", "16:9", "9:16", "1:1"] },
              focusTarget: {
                type: Type.STRING,
                enum: ["center", "face", "motion", "screen_action", "manual"],
              },
              // The design, chosen BY ID from Framevo's real library. Constrained
              // to the registry's ids at the schema level, so "invent a look we
              // can't render" is not a reachable state — the decoder can only
              // emit an id that exists. `resolveDirectorPreset` re-checks anyway:
              // schema enums are a guardrail, not a guarantee.
              presetId: {
                type: Type.STRING,
                enum: [...PRESET_IDS],
                description:
                  "The design to dress this edit in, chosen from the PRESET LIBRARY. Omit to let Framevo pick the best match for the style/platform.",
              },
            },
          },
        },
      },
    },

    audioOperations: {
      type: Type.ARRAY,
      description:
        "Pauses / silences / filler words to remove. ONLY use windows that appear in the DEAD ZONES list — never guess where silence is.",
      items: {
        type: Type.OBJECT,
        required: ["id", "kind", "startTime", "endTime", "reason", "confidence", "priority", "evidence"],
        properties: {
          ...OP_BASE_PROPS,
          kind: {
            type: Type.STRING,
            enum: ["remove-silence", "remove-filler", "keep-audio"],
          },
        },
      },
    },

    captionInstructions: {
      type: Type.OBJECT,
      required: ["enabled", "stylePreset", "position", "reason"],
      properties: {
        enabled: {
          type: Type.BOOLEAN,
          description: "Set false when the user didn't ask for captions OR there is no transcript.",
        },
        stylePreset: {
          type: Type.STRING,
          enum: ["clean", "bold_social", "minimal", "podcast", "tutorial"],
        },
        position: { type: Type.STRING, enum: ["bottom", "center", "top"] },
        presetId: {
          type: Type.STRING,
          enum: [...CAPTION_PRESET_IDS],
          description:
            "The caption design, from the PRESET LIBRARY's `captions` category. Omit to let Framevo pick.",
        },
        reason: { type: Type.STRING },
      },
    },
  },
} as const;

const SYSTEM_INSTRUCTION = `You are Framevo's AI Director — a professional video editor, not a special-effects generator. You turn a raw recording into a nearly-finished video by producing ONE structured plan. You never touch the timeline yourself — an executor compiles your plan into real edits, a validator rejects anything you get wrong, and a decision engine THEN judges every edit you propose and drops any it can't justify. Nothing you emit is guaranteed to survive; only edits with a real reason do.

WHAT YOU ARE DECIDING
1. storyStructure — the narrative spine: hook → context → demo → result → cta. The finished video must be watchable as ONE connected piece.
2. clipOperations — what survives (keep) and what goes (remove/trim).
3. editOperations — the actual edits, using ONLY Framevo's existing edit types.
4. audioOperations — pauses / silences / filler to remove.
5. captionInstructions — whether and how to caption.

THE MOST IMPORTANT RULE: DO NOT SELECT TOP-N MOMENTS.
A video assembled from the highest-scoring moments is a reel of disconnected peaks that no viewer can follow. Build the STORY first, then fill each section with contiguous material. A viewer must be able to understand what is happening without having seen the original. Keep the connective explanation, not just the clicks.

QUALITY OVER QUANTITY — A PROFESSIONAL EDITOR'S BAR FOR EVERY EDIT
Before you emit ANY editOperation, ask yourself:
  · Does this edit actually improve the viewer's experience?
  · Does it make the message clearer or more engaging — or is it decoration?
  · Is this the best possible edit for this moment, or would NO edit be better?
  · Does it fit naturally with the edit right before it and the one right after it, or does it clash with the pacing you've already established?
  · Will this distract the viewer instead of helping them?
If you can't answer these honestly in favor of the edit, DO NOT EMIT IT. "No edit here" is a common, correct, professional outcome — not a gap you need to fill. A sparse but deliberate edit list beats a dense one padded with edits nobody would miss. The decision engine downstream will drop anything with a weak \`reason\`, no supporting \`evidence\`, or confidence too low to trust — so don't propose edits you can't back up; you will not get credit for volume.
Every edit you DO emit must have a real, specific answer to "why does this exist" — emphasizing an important point, maintaining pacing, guiding the viewer's attention, highlighting a real action, improving clarity, or increasing engagement. Write that into \`reason\`, not a generic label like "adds emphasis".

GROUNDING — EVERY claim needs a real referent
- You are given the transcript, the detected moments, the interaction (click) times, the narrative beats and the dead zones. Cite them.
- Never invent a timestamp. Never invent a click. Never invent a spoken sentence.
- If the context shows no dead zones, do NOT fabricate pauses to remove.
- If a stretch is genuinely idle, remove it — do not manufacture a reason to keep it.

EDIT TYPES — the allowlist is absolute
Valid editType values: ${DIRECTOR_EDIT_TYPES.filter((t) => t !== "captions").join(", ")}.
Anything else is REJECTED and the edit simply won't exist. There is no partial credit.
- Do NOT emit \`captions\` as an editOperation. Captions are generated from the REAL transcript (with the ASR's own word timings) via captionInstructions. Writing caption text yourself would be inventing dialogue.
- \`hook-text\`, \`text-overlay\` and \`callout\` REQUIRE params.text. \`branding-cta\` REQUIRES params.ctaText. \`speed-up\` REQUIRES params.speedMultiplier > 1. An op missing its required param is rejected.
- There is NO \`reorder\`. Framevo plays source time in order; a reordered clip cannot be rendered.
- Do not emit blur/redaction — there is no reliable auto-detector and a wrong blur is worse than none.

DESIGN — CHOOSE FROM THE LIBRARY. DO NOT INVENT A LOOK.
Framevo has a real library of designed presets (typography + motion), listed below under PRESET LIBRARY. Every one of them renders identically in the editor preview and in the final export.
- You do NOT describe a design. You do NOT invent one. You NAME one, by id, in \`params.presetId\` (and \`captionInstructions.presetId\` for captions).
- An id that is not in the list below does not exist. It will be rejected and reported to the user as a design you asked for that Framevo doesn't have.
- Match the preset's TONE to the requested style and the platform. An energetic TikTok hook wears an energetic hook preset, not a calm one.
- Pick the preset for the JOB the edit does:
  · captions → a \`captions\` preset · \`hook-text\` → a \`hooks\` preset · \`branding-cta\` → a \`ctas\` preset
  · \`callout\` → a \`callouts\` preset · \`transition\` → a \`transitions\` preset
  · \`text-overlay\` → depends on where it sits: in the HOOK section it's an \`intros\` design; in the CTA section it's an \`outros\` design; a short (≤2s) emphasis beat is a \`text-animations\` design; anything else is a \`titles\` design.
- If no preset genuinely fits, OMIT presetId. Framevo then scores the library and picks the closest real design. Omitting is always better than naming something that doesn't exist.

WHAT TO CUT
- Long pauses and silence (from the DEAD ZONES list).
- Repeated explanations and second attempts at the same action — keep the CLEANEST take, not the first.
- Mistakes, false starts, and stretches where nothing on screen changes.
- Waiting: loading spinners, page loads, idle cursor.
Cut whole coherent stretches. Do not shatter a demonstration into fragments to save four seconds.

TARGET DURATION
When a target is given, it is a real constraint. Sacrifice in this order: context first, then the tail of the demo, then the result. NEVER sacrifice the hook or the CTA — a shorter video that opens on nothing and ends mid-sentence is not shorter, it's broken. If you cannot reach the target without destroying the demonstration, get as close as you honestly can and SAY SO in the explanation.

ZOOMS AND EMPHASIS
- Zoom on what the viewer must see: a click that matters, a reveal, a result. Not on every action.
- Prefer moments grounded in a REAL click over CV guesses.
- Keep zooms at least 2 seconds apart. A cluster of zooms reads as a twitch.
- A callout must point at something that is actually there — only use focusRegions from real grounded moments.
- The decision engine keeps only the strongest of any callout, text-overlay, click-highlight or cursor-focus edits that land within about a second of another edit of the SAME type — so don't stack several of them on the same beat expecting all to survive; place them where they're genuinely spread across the video's flow.

CONFIDENCE AND PRIORITY ARE NOT DECORATION
- confidence = how sure you are this is right. Be honest — the decision engine uses it to decide whether a zoom, callout, text overlay, transition or speed-up is even worth creating. A genuinely low-confidence emphasis edit will be dropped rather than shown to the user, so if you're not confident, either find better grounding or leave it out yourself.
- priority = what survives a duration squeeze. Hook and CTA are 1.0. Connective context is 0.5.

PRESET LIBRARY — the complete set of designs that exist. There are no others.
Format: id · name · tone · description
${presetCatalogueForModel()}

Output ONLY data matching the JSON schema.`;

function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(1, ms));
  });
  return Promise.race([p, timeout]).finally(() => timer && clearTimeout(timer)) as Promise<T>;
}

export interface PlanDirectorResult {
  plan: DirectorPlan;
  /** True when the model produced the plan; false when we fell back. */
  fromModel: boolean;
  /** Set when the model path failed — surfaced to the user, never swallowed. */
  fallbackReason?: string;
}

/**
 * Produce a Director plan.
 *
 * Tries Gemini; falls back to the deterministic heuristic planner on ANY failure
 * (no API key, network error, timeout, malformed JSON, or a response that
 * validates to nothing usable). The fallback reason is returned, not hidden — the
 * user is told their plan came from the offline planner.
 */
export async function planDirector(
  ctx: DirectorVideoContext,
  request: DirectorRequest,
  now = Date.now()
): Promise<PlanDirectorResult> {
  const heuristic = () => buildHeuristicPlan(ctx, request, now);

  if (!process.env.GEMINI_API_KEY) {
    return {
      plan: heuristic(),
      fromModel: false,
      fallbackReason:
        "No Gemini API key is configured, so the Director used its built-in planner.",
    };
  }

  try {
    const ai = getGemini();
    const userPrompt = [
      `USER REQUEST: ${request.prompt || `Create a ${request.goal.replace(/-/g, " ")}`}`,
      "",
      `SETTINGS: platform=${request.platform} · aspect=${request.aspectRatio} · style=${request.style} · captions=${request.captionStyle} · cta=${request.cta}${
        request.targetDurationSeconds
          ? ` · TARGET DURATION=${request.targetDurationSeconds}s (a real constraint)`
          : " · no duration target"
      }`,
      "",
      "=== WHAT FRAMEVO ALREADY KNOWS ABOUT THIS VIDEO ===",
      describeContextForModel(ctx),
      "",
      ctx.hasTranscript
        ? "A transcript EXISTS — captions can be generated from it."
        : "There is NO transcript. Set captionInstructions.enabled = false: captions cannot be generated without one, and you must not invent caption text.",
      "",
      "Produce the plan. Every timestamp must come from the data above.",
    ].join("\n");

    const response: GenerateContentResponse = await raceTimeout(
      ai.models.generateContent({
        model: DIRECTOR_MODEL,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: DIRECTOR_PLAN_SCHEMA as never,
          temperature: 0.35,
        },
      }),
      PLAN_TIMEOUT_MS,
      "The Director's planning call timed out."
    );

    const text = response.text;
    if (!text) throw new Error("Gemini returned an empty plan.");

    const raw: unknown = JSON.parse(text);
    const plan = sanitizeDirectorPlan(raw, request, DIRECTOR_MODEL, now);

    // A model response that shaped up to nothing is a model failure, not a plan.
    // Falling back beats handing the user an empty "success".
    if (
      plan.editOperations.length === 0 &&
      plan.clipOperations.length === 0 &&
      !plan.captionInstructions.enabled
    ) {
      throw new Error("Gemini returned a plan with no operations.");
    }

    return { plan, fromModel: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn("[director] Gemini planning failed — using the built-in planner", {
      error: detail.slice(0, 200),
    });
    return {
      plan: heuristic(),
      fromModel: false,
      fallbackReason: `The AI planner was unavailable (${detail.slice(0, 120)}), so the Director used its built-in planner.`,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Revisions
// ════════════════════════════════════════════════════════════════════════════

const REVISION_SCHEMA = {
  type: Type.OBJECT,
  required: ["intents"],
  properties: {
    intents: {
      type: Type.ARRAY,
      description:
        "The structured meaning of the user's command. Return [] when the command asks for something Framevo cannot do.",
      items: {
        type: Type.OBJECT,
        required: ["kind"],
        properties: {
          kind: {
            type: Type.STRING,
            enum: [
              "set-target-duration",
              "set-aspect",
              "set-caption-style",
              "toggle-captions",
              "adjust-edit-count",
              "remove-clip",
              "remove-section",
              "keep-more",
              "strengthen-cta",
              "remove-cta",
              "pace-section",
            ],
          },
          seconds: { type: Type.NUMBER },
          aspect: { type: Type.STRING, enum: ["9:16", "1:1", "4:5", "16:9"] },
          style: {
            type: Type.STRING,
            enum: ["energetic", "professional", "calm", "cinematic", "minimal"],
          },
          enabled: { type: Type.BOOLEAN },
          editType: {
            type: Type.STRING,
            enum: ["zoom", "callout", "transition", "text-overlay"],
          },
          direction: { type: Type.STRING, enum: ["fewer", "more", "faster", "slower"] },
          index: { type: Type.NUMBER, description: "1-based clip number." },
          section: {
            type: Type.STRING,
            enum: ["hook", "context", "demo", "result", "cta", "beginning", "ending"],
          },
          query: { type: Type.STRING, description: "The topic to keep more of." },
          text: { type: Type.STRING, description: "CTA copy, when the user supplied it." },
        },
      },
    },
  },
} as const;

const REVISION_SYSTEM = `You translate a user's follow-up editing command into structured intents for Framevo's AI Director. You do NOT edit anything — you only classify what they asked for.

Return ONE intent per distinct request. Return an EMPTY array if the command asks for something not in the list — do not force a bad match. A wrong intent silently rewrites the user's video, which is far worse than saying "I didn't understand that".

Intent notes:
- set-target-duration → needs \`seconds\`.
- set-aspect → needs \`aspect\`.
- set-caption-style → needs \`style\`. toggle-captions → needs \`enabled\`.
- adjust-edit-count → needs \`editType\` + \`direction\` ("fewer" | "more").
- remove-clip → needs 1-based \`index\`. remove-section → needs \`section\`.
- keep-more → needs \`query\`: the TOPIC ("pricing", "checkout"), not a time.
- pace-section → needs \`section\` + \`direction\` ("faster" | "slower").
- strengthen-cta → \`text\` only if the user actually supplied the copy.

Output ONLY the JSON schema.`;

/**
 * Understand a revision command.
 *
 * The deterministic parser runs FIRST — the common commands ("make it 30
 * seconds", "fewer zooms") are unambiguous and shouldn't cost a model round-trip
 * or risk a misread. Gemini is only consulted for what the parser couldn't place,
 * and if it too comes up empty we say so instead of guessing.
 */
export async function understandRevision(
  command: string
): Promise<{ intents: DirectorRevisionIntent[]; understood: boolean }> {
  const local = parseRevisionCommand(command);
  if (!local.unrecognized) {
    return { intents: local.intents, understood: true };
  }

  if (!process.env.GEMINI_API_KEY) {
    return { intents: [], understood: false };
  }

  try {
    const ai = getGemini();
    const response: GenerateContentResponse = await raceTimeout(
      ai.models.generateContent({
        model: DIRECTOR_MODEL,
        contents: [{ role: "user", parts: [{ text: `Command: "${command}"` }] }],
        config: {
          systemInstruction: REVISION_SYSTEM,
          responseMimeType: "application/json",
          responseSchema: REVISION_SCHEMA as never,
          temperature: 0.1,
        },
      }),
      20_000,
      "The revision call timed out."
    );

    const text = response.text;
    if (!text) return { intents: [], understood: false };
    const parsed = JSON.parse(text) as { intents?: Array<Record<string, unknown>> };
    const intents = (parsed.intents ?? [])
      .map(coerceIntent)
      .filter((i): i is DirectorRevisionIntent => i !== null);
    return { intents, understood: intents.length > 0 };
  } catch (err) {
    console.warn("[director] revision understanding failed", {
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return { intents: [], understood: false };
  }
}

/** Coerce one model intent, dropping anything missing its required field. */
function coerceIntent(raw: Record<string, unknown>): DirectorRevisionIntent | null {
  const kind = String(raw.kind ?? "");
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

  switch (kind) {
    case "set-target-duration": {
      const seconds = num(raw.seconds);
      return seconds && seconds > 0 ? { kind, seconds } : null;
    }
    case "set-aspect":
      return ["9:16", "1:1", "4:5", "16:9"].includes(String(raw.aspect))
        ? { kind, aspect: raw.aspect as never }
        : null;
    case "set-caption-style":
      return ["energetic", "professional", "calm", "cinematic", "minimal"].includes(
        String(raw.style)
      )
        ? { kind, style: raw.style as never }
        : null;
    case "toggle-captions":
      return typeof raw.enabled === "boolean" ? { kind, enabled: raw.enabled } : null;
    case "adjust-edit-count": {
      const ok =
        ["zoom", "callout", "transition", "text-overlay"].includes(String(raw.editType)) &&
        ["fewer", "more"].includes(String(raw.direction));
      return ok
        ? { kind, editType: raw.editType as never, direction: raw.direction as never }
        : null;
    }
    case "remove-clip": {
      const index = num(raw.index);
      return index && index >= 1 ? { kind, index: Math.round(index) } : null;
    }
    case "remove-section":
      return ["hook", "context", "demo", "result", "cta"].includes(String(raw.section))
        ? { kind, section: raw.section as never }
        : null;
    case "keep-more": {
      const query = String(raw.query ?? "").trim();
      return query ? { kind, query } : null;
    }
    case "strengthen-cta": {
      const text = String(raw.text ?? "").trim();
      return { kind, ...(text ? { text } : {}) };
    }
    case "remove-cta":
      return { kind };
    case "pace-section": {
      const ok =
        ["hook", "context", "demo", "result", "cta", "beginning", "ending"].includes(
          String(raw.section)
        ) && ["faster", "slower"].includes(String(raw.direction));
      return ok
        ? { kind, section: raw.section as never, direction: raw.direction as never }
        : null;
    }
    default:
      return null;
  }
}
