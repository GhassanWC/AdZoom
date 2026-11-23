import "server-only";

/**
 * Gemini adapter for the editing assistant — function calling over the
 * model-agnostic tools in tools.ts.
 *
 * The model PROPOSES; it never writes. Edit-tool calls are converted to
 * EditCommands and dry-run through the same executor the client uses, against
 * the saved project. Invalid calls go back to the model as errors so it can
 * correct itself (a stale clip id, a range past the end). The client then
 * re-validates against its LIVE timeline when applying, so a manual edit made
 * while the model was thinking is respected.
 */

import type { Content, FunctionCall, Part } from "@google/genai";
import { getGemini, ANALYSIS_MODEL } from "@/lib/gemini";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { applyEditCommands } from "./apply";
import { EDIT_TOOLS, TOOL_KIND, toolCallToCommand } from "./tools";
import { executeReadTool, type ReadToolContext } from "./read-tools";
import type { AssistantDigest } from "./context";
import type { EditCommand } from "./types";
import type { AssistantMemoryItem } from "@/lib/firebase/schema";
import { FX_TOOLS, FX_TOOL_NAMES, handleFxTool, type FoundEvent, type FxToolContext } from "@/lib/effects/assistant-tools";
import type { EffectLibraryEntry } from "@/lib/effects/library";
import { FX_DOCS } from "@/lib/effects/docs";
import { isAudioLocked } from "./memory";

export const ASSISTANT_MODEL = process.env.GEMINI_ASSISTANT_MODEL || process.env.GEMINI_DIRECTOR_MODEL || ANALYSIS_MODEL;
const MAX_ROUNDS = 12;

/** One tool call the model made — returned only when `debug` is set (dev). */
export interface ToolTrace {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export type AssistantResponse = (
  | { kind: "commands"; commands: EditCommand[]; reply: string | null; model: string }
  | { kind: "prepare"; needs: ("transcript" | "clicks" | "pauses")[]; model: string }
  | { kind: "question"; question: string; options: string[]; model: string }
  | { kind: "reply"; reply: string; model: string }
) & {
  trace?: ToolTrace[];
  /**
   * Library records and memory this turn produced — persisted by the route
   * (never sent to the client as-is). Present whatever the response kind: a
   * "save this look" turn changes the library without touching the timeline.
   */
  sideEffects?: { library: EffectLibraryEntry[]; memory: AssistantMemoryItem[] };
};

const SYSTEM = `You are Framevo's video editor. The user is the director: they control story, tone, pacing and which footage is used. You carry out their requests precisely and use professional editorial judgment only for details they leave to you.

How the project works:
- There is ONE uploaded source video. The edit is that video with ranges removed (cuts), speed changes, zooms, captions and graphics layered on top. Original media is never modified.
- All times you send are SOURCE seconds (time in the original upload). Clips are the kept spans between cuts, listed in playback order by get_timeline.
- The renderer plays footage in source order. Clips cannot be reordered, and there is no second camera angle to swap to. If the user asks to reorder shots or switch angles, do not fake it with cuts: explain this limit in one sentence with ask_user and offer what IS possible (e.g. remove the buildup, or open with a title over the celebration).
- Only the user's uploaded footage can be used. Stock footage search and AI footage generation are not available — say so if asked.
- Never tell the user to generate a transcript, run an analysis or find clicks themselves: call prepare_footage and continue. After preparing, if the data is still empty (no speech, no clicks), say so in one sentence.

Rules:
1. Follow explicit instructions exactly ("two seconds" means 2). Change only what was asked; never touch unrelated edits, including manual edits the user made.
2. Resolve references from the context: "the selected clip" = selection.clip; "it"/"that title" = recentlyChanged first, then selection.element; "the shot before this one" = the clip before the selected (or playhead) clip.
3. Find moments with find_footage / find_repeated_takes / find_introductions. When the footage has no transcript, or the request is about what is SEEN ("the dish reveal", "the celebration"), call survey_footage FIRST — it watches the whole clip and returns the shots with times — then locate_elements inside the chosen shot. Never ask the user where something is before you have looked.
4. If the moment is missing or genuinely ambiguous, or a creative choice would materially change the result (e.g. a target duration that can't fit a passage they want kept whole), call ask_user with the closest candidates instead of guessing.
5. Cut in pauses between words so speech stays continuous; keep the later take of a repeated answer unless told otherwise.
6. Make all edits for one request in the same turn, then stop. Reply with one short sentence saying what you did, then ONE short question about the result that would actually change the next edit (e.g. "Should the sparks reach further, or is this the right size?"). Never ask about details you were told.
7. Address EVERY part of a request: "a calm walkthrough with captions" = pacing (tighten_pauses calm) AND captions. If one part is impossible, still make the others.

Creative control — camera and graphics:
- You compose camera moves with set_camera as beats (hold wide → push into a subject off-centre → pan to a second subject → hold on a detail). Ground every focal point in the footage: call locate_elements at the moment first, use the returned cx/cy, and respect maxZoomKeepingCentre (a subject near the edge can't be framed at high zoom). Check text legibility with framing_check before holding on a price or a label.
- "Zoom into the dish, then reveal the price": locate both; beats = [wide at 0s], [dish centre at ~1.2s, zoom 1.5], [hold dish ~1s], [pan to the price at ~3.5s, zoom that keeps it readable AND inside the frame], [hold ~1.5s]. One set_camera, 5–7s long.
- Calm/menu walkthrough = slow subtle moves (zoom ≤1.3, 4–6s, ease-in-out, long holds) and clean graphics. Premium food ad = stronger pushes (1.45–1.62), tighter holds, premium-tone labels, and the move lands on the subject exactly when the label enters.
- Graphics are designed from parts with compose_graphic: a dish label = label {title, sub: price, tone, x, y} placed away from the subject (left when the dish is right). Use parts for anything else (a thin rect plate behind text, an accent line, a staggered reveal via delay). Keep text out of the camera's subject area and inside the safe area.
- Revisions change ONLY what was asked: update_camera {slower} for "make the push-in slower", update_camera {hold_seconds} for "keep the price visible", update_graphic {remove_parts:["line"]} for "remove the line but keep the title". Never recompose from scratch for a targeted change.

Creative-brief playbook (a brief names a feel — "calm menu walkthrough", "premium food ad" — not one edit). Deliver a complete first edit, not a single move:
1. survey_footage. Choose the 2–4 shots that carry the brief (for food: the shots where a DISH PHOTO is large on screen; the dish is the food photograph, never the headline text or the menu grid).
2. A dish's "shot" is the whole stretch its photo stays on screen (adjacent survey beats of the same dish count as one; if unsure, inspect_footage the range). Prefer the longest such stretches. For each chosen shot: locate_elements at its midpoint for the dish photo, the dish name and the price — and use the text field it returns for the label (the REAL name and price from the frame; never guess or reuse a price from another dish). Compose ONE set_camera per shot that stays inside that shot's time range: wide → push onto the dish photo's cx/cy (zoom 1.45–1.6 for a premium ad, 1.15–1.3 for calm) → hold → (if the price is on screen) pan so the price is visible and readable (framing_check) → hold. Never let the move run past the shot's end — the footage changes there.
3. Add one compose_graphic per featured dish with label_title = the dish name and label_sub = the price (both from locate_elements text), starting ~1.0–1.4s after that move starts (when the push lands) and lasting at least 2.5s — ideally until ~0.5s before the shot ends. Camera moves last 3–6s (never under 2.5s) and the move + label for one dish must end before the next shot begins. Tone: premium → "premium", calm → "clean", energetic → "bold". Place it on the side AWAY from the dish photo (label_x 0.06 when the dish is on the right; 0.55 when it is on the left).
4. A brief ALWAYS yields at least one camera move and one label — never a question about shot length. Short stretches (2–4s) are decided by you: a 2–3s move, the label entering together with the push (label start = move start) and running to the stretch's end. If every dish stretch is under 2s, place the move on the longest shot that shows food at all.
5. If a tool result says a move or label was rejected or extended, adjust (extend the end, shorten the hold) and continue — never abandon the plan or ask the user because of a duration.
6. Then stop. Report in one sentence what you featured.

Original effects — the user is the director, you are the editor:
- When a request calls for a look the standard edits can't produce (a ripple from the ball, sparks, a light sweep, a custom burst), author an EFFECT PROGRAM. First list_effects: reuse a library effect that matches (apply_effect), adapt a close one (update_effect with params or a new program version), and create only when nothing fits. "Create something new" / "something original" means create_effect with distinct=true — never reuse then.
- Ground it in the footage: find_events for the moment ("the ball crosses the goal line"), then locate_elements at that exact time for the subject ("the ball") and anchor at its cx/cy. Use the event time as at. If the subject moves fast during the effect, track_element and pass track_json.
- Expose every property the user may revise as a param, one per part (rippleSpeed, rippleColor, sparkDecay, sparkCount-like spread…), so revisions never regenerate the effect.
- Revisions change only what was named: "make only the sparks fade faster" = get_effects, then update_effect with params_json {"<the spark decay param>": a clearly faster value} — the ripple's params, the timing and the anchor stay exactly as they are.
- "Save this look as X" = save_effect on that instance (its current settings become X's defaults). "Use it on the second goal" = find_events for that goal, locate the ball there, apply_effect effect="X" at that time — never re-create it.
- Respect the project memory below. When the user states a standing rule ("keep the commentary") or approves something ("I like the ripple"), call remember. Effects never touch the soundtrack; with the commentary locked, never cut, trim or retime footage.

${FX_DOCS}`;

/** Text parts of a model turn (reading `res.text` on a function-call turn logs an SDK warning). */
function textParts(content: Content | undefined): string {
  return (content?.parts ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).join("").trim();
}

/** Close-inspection callback factory — see the route, which owns media access. */
export type InspectFn = ReadToolContext["inspect"];
export type LocateFn = ReadToolContext["locate"];
export type SurveyFn = ReadToolContext["survey"];

export async function runGeminiAssistant(input: {
  message: string;
  requestId: string;
  digest: AssistantDigest;
  project: ProjectDoc;
  inspect?: InspectFn;
  locate?: LocateFn;
  survey?: SurveyFn;
  /** Footage steps the client already ran for this request. */
  prepared?: string[];
  /** Collect a tool-call trace (dev tuning). */
  debug?: boolean;
  /** The user's effect library (loaded by the route). */
  library?: EffectLibraryEntry[];
  events?: (query: string) => Promise<FoundEvent[]>;
  track?: FxToolContext["track"];
  memory?: AssistantMemoryItem[];
}): Promise<AssistantResponse> {
  const trace: ToolTrace[] = [];
  // Effect library + memory, staged for the turn (see effects/assistant-tools).
  const fxCtx: FxToolContext = {
    requestId: input.requestId,
    library: [...(input.library ?? [])],
    writes: new Map(),
    momentsNow: () => [],
    sourceDuration: input.digest.sourceDuration,
    events: input.events,
    track: input.track,
    memory: [...(input.memory ?? [])],
    memoryWrites: [],
    now: Date.now(),
    seq: { create: 0 },
  };
  const traced = (r: AssistantResponse): AssistantResponse => ({
    ...r,
    ...(input.debug ? { trace } : {}),
    sideEffects: { library: [...fxCtx.writes.values()], memory: fxCtx.memoryWrites },
  });
  const ai = getGemini();
  const model = ASSISTANT_MODEL;
  const declarations = [...EDIT_TOOLS, ...FX_TOOLS].map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
  const ctx: ReadToolContext = { project: input.project, digest: input.digest, inspect: input.inspect, locate: input.locate, survey: input.survey };

  const contents: Content[] = [
    {
      role: "user",
      parts: [
        {
          text: `Editing context (JSON):\n${JSON.stringify({
            brief: input.digest.brief,
            selection: input.digest.selection,
            playhead: input.digest.playhead,
            clips: input.digest.clips,
            recentlyChanged: input.digest.recentlyChanged,
            transcriptAvailable: input.digest.transcript.available,
            footageSurveyed: Array.isArray(input.project.footageSurvey?.shots),
            captions: input.digest.captions,
            sourceDuration: input.digest.sourceDuration,
            outputDuration: input.digest.outputDuration,
            projectMemory: (input.memory ?? []).map((m) => ({ kind: m.kind, text: m.text })),
            effectLibrary: (input.library ?? []).map((e) => e.name),
            effectsOnTimeline: (input.project.analysis?.detectedMoments ?? []).filter((m) => m.effectType === "fx").length,
          })}${input.prepared?.length ? `\nAlready prepared for this request: ${input.prepared.join(", ")} (do not prepare these again).` : ""}\n\nRequest: ${input.message}`,
        },
      ],
    },
  ];

  const state = {
    moments: input.project.analysis?.detectedMoments ?? [],
    layers: input.project.timelineLayers ?? {},
    sourceDuration: input.digest.sourceDuration,
    canvasWidth: input.project.effectsSettings?.outputCanvas?.width || input.project.width || 1920,
    canvasHeight: input.project.effectsSettings?.outputCanvas?.height || input.project.height || 1080,
    transcript: input.project.analysis?.transcript ?? null,
    videoType: input.project.selectedVideoType,
    clicks: input.project.clickMarks ?? [],
    silences: (input.project.analysis?.audioAnalysis?.silenceSegments ?? []).map((x) => ({ start: x.startTime, end: x.endTime })),
    audioLocked: isAudioLocked(input.memory, input.message),
  };
  // Edits ACCUMULATE across rounds. A plan ("push onto the dish, then label
  // it, then the next dish") arrives as several tool calls, often one per
  // round; each is validated against the timeline WITH the edits already
  // accepted, and the model is told the result so it can build on it. The
  // whole set is returned when the model stops calling tools — and applied
  // by the client as ONE undoable request.
  const accepted: EditCommand[] = [];
  fxCtx.momentsNow = () => {
    if (!accepted.length) return state.moments;
    const dry = applyEditCommands(state, accepted, input.requestId, { partial: true });
    return dry.ok ? dry.moments : state.moments;
  };
  let lastText = "";
  const finishWith = (): AssistantResponse =>
    traced(
      accepted.length
        ? { kind: "commands", commands: accepted, reply: lastText || null, model }
        : { kind: "reply", reply: lastText || "I'm not sure what to change — can you say it another way?", model }
    );

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: SYSTEM,
        temperature: 0.2,
        tools: [{ functionDeclarations: declarations }],
      },
    });
    const calls: FunctionCall[] = res.functionCalls ?? [];
    const finish = res.candidates?.[0]?.finishReason;
    const modelContent = res.candidates?.[0]?.content;
    const text = textParts(modelContent);
    if (text) lastText = text;

    if (calls.length === 0 && finish && finish !== "STOP") {
      // Typically MALFORMED_FUNCTION_CALL: the model tried a tool call whose
      // JSON didn't parse. Say so and let it retry instead of giving up.
      console.warn(`[assistant] model finished with ${finish} and no usable parts (round ${round + 1})`);
      contents.push({
        role: "user",
        parts: [{ text: `Your previous reply could not be used (finish reason: ${finish}). Call the tools again with valid JSON arguments (flat fields only).` }],
      });
      continue;
    }
    if (calls.length === 0) return finishWith();
    if (modelContent) contents.push(modelContent);

    const prep = calls.find((c) => c.name === "prepare_footage");
    if (prep) {
      const raw = ((prep.args ?? {}) as { needs?: unknown }).needs;
      const needs = (Array.isArray(raw) ? raw : [])
        .filter((x): x is "transcript" | "clicks" | "pauses" => x === "transcript" || x === "clicks" || x === "pauses")
        .filter((x) => !input.prepared?.includes(x));
      // Preparation restarts the request on the client; anything accepted so
      // far would be lost, so only honour it before any edit was made.
      if (needs.length && accepted.length === 0) return traced({ kind: "prepare", needs: [...new Set(needs)], model });
    }
    const ask = calls.find((c) => c.name === "ask_user");
    if (ask && accepted.length === 0) {
      const a = (ask.args ?? {}) as { question?: unknown; options?: unknown };
      return traced({
        kind: "question",
        question: typeof a.question === "string" ? a.question : "Can you tell me a bit more?",
        options: Array.isArray(a.options) ? a.options.filter((o): o is string => typeof o === "string").slice(0, 6) : [],
        model,
      });
    }

    const responses: Part[] = [];
    const batch: { cmd: EditCommand; at: number; stage?: () => void; note?: string }[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const args = (call.args ?? {}) as Record<string, unknown>;
      const kind = TOOL_KIND.get(name);
      if (FX_TOOL_NAMES.has(name)) {
        const r = await handleFxTool(name, args, fxCtx);
        if (r.kind === "command") {
          batch.push({ cmd: r.cmd, at: responses.length, stage: r.stage, note: r.note });
          responses.push({ functionResponse: { id: call.id, name, response: { result: "pending" } } });
        } else {
          const response = r.kind === "error" ? { error: r.message } : { result: r.result };
          trace.push({ tool: name, args, result: JSON.stringify(response).slice(0, 600) });
          responses.push({ functionResponse: { id: call.id, name, response } });
        }
      } else if (kind === "read") {
        const result = await executeReadTool(name, args, ctx);
        trace.push({ tool: name, args, result: JSON.stringify(result).slice(0, 600) });
        responses.push({ functionResponse: { id: call.id, name, response: { result } } });
      } else if (kind === "edit") {
        const cmd = toolCallToCommand(name, args);
        if (typeof cmd === "string") {
          responses.push({ functionResponse: { id: call.id, name, response: { error: cmd } } });
        } else {
          batch.push({ cmd, at: responses.length });
          responses.push({ functionResponse: { id: call.id, name, response: { result: "pending" } } });
        }
      } else if (name === "ask_user" || name === "prepare_footage") {
        responses.push({ functionResponse: { id: call.id, name, response: { error: "Edits are already in progress for this request — finish them, then stop. The user will see your question next time." } } });
      } else {
        responses.push({ functionResponse: { id: call.id, name, response: { error: `Unknown tool "${name}".` } } });
      }
    }

    if (batch.length) {
      // Validate the new calls together with everything accepted so far.
      const combined = [...accepted, ...batch.map((b) => b.cmd)];
      const dry = applyEditCommands(state, combined, input.requestId, { partial: true });
      const failed = new Map<number, string>();
      const errors = dry.ok ? dry.errors : dry.errors;
      for (const e of errors) failed.set(e.commandIndex, `${e.code}: ${e.message}`);
      batch.forEach((b, i) => {
        const idx = accepted.length + i;
        const fr = responses[b.at]?.functionResponse;
        const err = failed.get(idx);
        if (err) {
          if (fr) fr.response = { error: err };
          trace.push({ tool: b.cmd.op, args: b.cmd as unknown as Record<string, unknown>, result: `REJECTED ${err}` });
        } else {
          b.stage?.();
          if (fr) fr.response = { result: `accepted — ${b.note ?? describeCommand(b.cmd)}. Continue with the next step, or stop if the request is complete.` };
          trace.push({ tool: b.cmd.op, args: b.cmd as unknown as Record<string, unknown>, result: "accepted" });
        }
      });
      // Keep only the ones that validated, in order.
      const keep = batch.filter((_, i) => !failed.has(accepted.length + i)).map((b) => b.cmd);
      accepted.push(...keep);
    }
    contents.push({ role: "user", parts: responses });
  }
  return accepted.length ? finishWith() : traced({ kind: "reply", reply: "I couldn't settle on a valid edit for that. Could you rephrase or point me at the moment?", model });
}

/** One line per command for the model's tool result. */
function describeCommand(c: EditCommand): string {
  switch (c.op) {
    case "set_camera":
      return `camera move ${c.start}s–${c.end}s with ${c.beats.length} beats`;
    case "compose_graphic":
      return `graphic at ${c.start}s${c.label ? ` "${c.label.title}"` : ""}`;
    case "remove_range":
      return `removed ${c.start}s–${c.end}s`;
    default:
      return c.op;
  }
}
