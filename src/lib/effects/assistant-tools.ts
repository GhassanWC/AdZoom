/**
 * The assistant's effect tools — create, reuse, adapt and revise original
 * effects, find the footage events they belong to, and remember the user's
 * direction. Model-agnostic JSON-schema tools (flat fields; JSON payloads as
 * strings, which every function-calling model handles reliably) plus one
 * handler the model adapter calls.
 *
 * The library is staged in memory during a turn: an effect created and then
 * saved/reused in the same turn resolves without a round trip, and NOTHING is
 * persisted unless the command that needs it is accepted (the route writes
 * `ctx.writes` after the turn). Ids/versions derive from the request id, so a
 * retried request rewrites the same records instead of duplicating them.
 */

import type { AssistantMemoryItem, DetectedMoment } from "@/lib/firebase/schema";
import type { EditCommand } from "@/lib/edit-commands/types";
import type { ToolDef } from "@/lib/edit-commands/tools";
import { mergeMemory } from "@/lib/edit-commands/memory";
import { resolveParams, type EffectProgram, type FxInstanceInputs, type FxParamValues } from "./program";
import { testRenderProgram } from "./validate";
import {
  addVersion,
  bakeDefaults,
  effectIdFor,
  findEffect,
  fingerprint,
  newEntry,
  summarize,
  versionOf,
  type EffectLibraryEntry,
} from "./library";

export interface FoundEvent {
  time: number;
  x: number;
  y: number;
  description: string;
  confidence: number;
}

export interface FxToolContext {
  requestId: string;
  /** The user's library as loaded, overlaid with this turn's staged writes. */
  library: EffectLibraryEntry[];
  /** Staged writes, by effect id. The route persists these after the turn. */
  writes: Map<string, EffectLibraryEntry>;
  /** The timeline with every command accepted so far this turn. */
  momentsNow: () => DetectedMoment[];
  sourceDuration: number;
  /** Watch the video for events matching a description (absent ⇒ unavailable). */
  events?: (query: string, assetId?: string) => Promise<FoundEvent[]>;
  /** Positions of an element across a short window (absent ⇒ unavailable). */
  track?: (element: string, start: number, duration: number, assetId?: string) => Promise<{ t: number; x: number; y: number }[]>;
  memory: AssistantMemoryItem[];
  memoryWrites: AssistantMemoryItem[];
  now: number;
  /** Per-turn counter for deterministic ids. */
  seq: { create: number };
}

export type FxToolResult =
  | { kind: "read"; result: unknown }
  | { kind: "error"; message: string }
  /** A timeline command; `stage` persists its library records once it's accepted. */
  | { kind: "command"; cmd: EditCommand; note: string; stage?: () => void };

const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

export const FX_TOOLS: readonly ToolDef[] = [
  {
    name: "list_effects",
    kind: "read",
    description: "The user's effect library: every effect created or saved before, with id, name, description, latest version, inputs and editable params. Check it before creating — reuse or adapt a match unless the user asks for something new.",
    parameters: obj({}),
  },
  {
    name: "get_effects",
    kind: "read",
    description: "Effect instances on the timeline: element id, library name/id/version, start/end, anchor, and each param's CURRENT value with its range. Call before revising an effect.",
    parameters: obj({}),
  },
  {
    name: "find_events",
    kind: "read",
    description: "Watch the footage for a described event ('the ball crosses the goal line', 'the second goal', 'the car passes the camera'). Returns each occurrence with its source time and where the key object is in the frame (x, y fractions). Confirm the exact position with locate_elements at the returned time.",
    parameters: obj({ query: str("The event to find, specific enough to recognise."), asset_id: str("Asset to watch (default 'source').") }, ["query"]),
  },
  {
    name: "track_element",
    kind: "read",
    description: "Positions of one element (e.g. 'the ball') every ~0.25s over a short window, as fractions of the frame — pass the result as track_json to create_effect/apply_effect so the effect follows it.",
    parameters: obj({ element: str("What to track."), start: num("Asset seconds."), duration: num("Seconds to track (≤ 4)."), asset_id: str("Asset to watch (default 'source').") }, ["element", "start"]),
  },
  {
    name: "test_effect",
    kind: "read",
    description: "Compile and test-render an effect program without adding it: returns issues to fix, warnings and stats (visible frames, shapes per frame, distance from the anchor at the start). Optional — create_effect runs the same checks.",
    parameters: obj({ program_json: str("The program as a JSON string."), anchor_x: num("0..1"), anchor_y: num("0..1") }, ["program_json"]),
  },
  {
    name: "create_effect",
    kind: "edit",
    description: "Author a NEW original effect program (see EFFECT PROGRAMS), validate + test-render it, save it to the user's library as version 1, and place it at `at` anchored at (anchor_x, anchor_y). Rejected programs come back with the issues to fix.",
    parameters: obj(
      {
        name: str("Short library name, e.g. 'Gold Ripple Burst'."),
        description: str("One sentence: what it looks like and when to use it."),
        program_json: str("The effect program as a JSON string."),
        at: num("Source seconds the effect starts (the event moment)."),
        anchor_x: num("Anchor x, 0..1 of the frame (e.g. the ball's cx)."),
        anchor_y: num("Anchor y, 0..1 of the frame."),
        track_json: str("Optional: track_element samples as JSON, times relative to `at`."),
        distinct: bool("True when the user asked for something NEW — it must differ from every library effect."),
      },
      ["name", "description", "program_json", "at"]
    ),
  },
  {
    name: "apply_effect",
    kind: "edit",
    description: "Reuse an effect FROM THE LIBRARY (by name or id, optionally a version) at a new moment and position. The new use gets the library version's defaults as its own settings; other uses keep theirs.",
    parameters: obj(
      {
        effect: str("Library name or id."),
        version: num("Optional exact version; default latest."),
        at: num("Source seconds."),
        anchor_x: num("0..1"),
        anchor_y: num("0..1"),
        params_json: str("Optional JSON object of param overrides for THIS use."),
        track_json: str("Optional track_element samples as JSON, times relative to `at`."),
      },
      ["effect", "at"]
    ),
  },
  {
    name: "update_effect",
    kind: "edit",
    description: "Revise ONE effect instance. params_json changes only the named settings (e.g. {\"sparkDecay\": 6}) — everything else, including other parts of the effect and its timing, is kept. program_json (only when no param covers the change) saves a new library version and switches this use to it.",
    parameters: obj(
      {
        element_id: str("The instance id from get_effects."),
        params_json: str("JSON object of param id → new value."),
        program_json: str("Optional full replacement program (an adaptation)."),
        note: str("What changed, for the version history."),
        at: num("Optional new start (source seconds)."),
        duration: num("Optional: play the WHOLE effect over this many seconds (slower drawing = longer). A freeze linked to the effect holds for the new length."),
        anchor_x: num("Optional new anchor x."),
        anchor_y: num("Optional new anchor y."),
      },
      ["element_id"]
    ),
  },
  {
    name: "save_effect",
    kind: "edit",
    description: "Save an instance's current look (program + its current settings as the new defaults) to the library under a name — 'save this look as Matchday Gold'. The instance itself is unchanged. Re-saving an existing name adds a version.",
    parameters: obj({ element_id: str("Instance id."), name: str("Library name."), description: str("Optional one sentence.") }, ["element_id", "name"]),
  },
  {
    name: "remember",
    kind: "edit",
    description: "Record the user's direction for this project so later turns respect it: a standing constraint ('keep the original commentary'), something they approved ('the ripple motion'), or something to avoid.",
    parameters: obj({ kind: { type: "string", enum: ["constraint", "approved", "avoid"] }, text: str("Short, specific.") }, ["kind", "text"]),
  },
];

export const FX_TOOL_NAMES: ReadonlySet<string> = new Set(FX_TOOLS.map((t) => t.name));

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const in01 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function parseJson<T>(raw: unknown, what: string): T | string {
  if (raw == null || raw === "") return `${what} is required.`;
  if (typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return `${what} must be a JSON string.`;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    return `${what} is not valid JSON: ${err instanceof Error ? err.message : "parse error"}.`;
  }
}

function parseTrack(raw: unknown): FxInstanceInputs["track"] | string | undefined {
  if (raw == null || raw === "") return undefined;
  const v = parseJson<unknown>(raw, "track_json");
  if (typeof v === "string") return v;
  const list = Array.isArray(v) ? v : Array.isArray((v as { samples?: unknown }).samples) ? (v as { samples: unknown[] }).samples : null;
  if (!list) return "track_json must be an array of {t, x, y}.";
  const out = list
    .map((s) => s as { t?: unknown; x?: unknown; y?: unknown })
    .filter((s) => typeof s.t === "number" && in01(s.x) && in01(s.y))
    .map((s) => ({ t: r3(s.t as number), x: r3(s.x as number), y: r3(s.y as number) }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 40);
  return out.length ? out : undefined;
}

function issuesText(r: ReturnType<typeof testRenderProgram>): string {
  return r.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}

function stageEntry(ctx: FxToolContext, entry: EffectLibraryEntry): void {
  ctx.writes.set(entry.id, entry);
  const at = ctx.library.findIndex((e) => e.id === entry.id);
  if (at >= 0) ctx.library[at] = entry;
  else ctx.library.push(entry);
}

function instancesOf(ctx: FxToolContext): DetectedMoment[] {
  return ctx.momentsNow().filter((m) => m.effectType === "fx" && m.fx);
}

export async function handleFxTool(name: string, args: Record<string, unknown>, ctx: FxToolContext): Promise<FxToolResult> {
  switch (name) {
    case "list_effects":
      return { kind: "read", result: { effects: ctx.library.map(summarize), note: ctx.library.length ? "Reuse with apply_effect, adapt with update_effect, or create_effect when nothing fits." : "The library is empty." } };

    case "get_effects":
      return {
        kind: "read",
        result: {
          effects: instancesOf(ctx).map((m) => {
            const fx = m.fx!;
            const values = resolveParams(fx.program, fx.params);
            return {
              element_id: m.id,
              name: fx.ref.name,
              library: { effectId: fx.ref.effectId, version: fx.ref.version },
              start: r3(m.startTime),
              end: r3(m.endTime),
              anchor: fx.inputs.anchor ?? null,
              params: fx.program.params.map((p) => ({ id: p.id, label: p.label, type: p.type, value: values[p.id], ...(p.min != null ? { min: p.min } : {}), ...(p.max != null ? { max: p.max } : {}) })),
            };
          }),
        },
      };

    case "find_events": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { kind: "error", message: "Say which event to find." };
      if (!ctx.events) return { kind: "read", result: { error: "Watching the footage isn't available for this project." } };
      try {
        const events = await ctx.events(query, typeof args.asset_id === "string" && args.asset_id ? args.asset_id : "source");
        return {
          kind: "read",
          result: {
            events: events.map((e) => ({ ...e, time: r3(e.time), x: r3(e.x), y: r3(e.y) })),
            note: events.length ? "Times are source seconds; x/y locate the key object. Confirm the position with locate_elements at that time before anchoring." : "No matching event found.",
          },
        };
      } catch (err) {
        return { kind: "read", result: { error: err instanceof Error ? err.message : "Finding events failed." } };
      }
    }

    case "track_element": {
      const element = typeof args.element === "string" ? args.element.trim() : "";
      const start = Number(args.start);
      const duration = Math.min(4, Math.max(0.5, Number(args.duration) || 2));
      if (!element || !Number.isFinite(start)) return { kind: "error", message: "element and start are required." };
      if (!ctx.track) return { kind: "read", result: { error: "Tracking isn't available for this project." } };
      try {
        const samples = await ctx.track(element, start, duration, typeof args.asset_id === "string" && args.asset_id ? args.asset_id : "source");
        return { kind: "read", result: { samples: samples.map((s) => ({ t: r3(s.t - start), x: r3(s.x), y: r3(s.y) })), note: "t is seconds after `start` — pass this array as track_json with at = start." } };
      } catch (err) {
        return { kind: "read", result: { error: err instanceof Error ? err.message : "Tracking failed." } };
      }
    }

    case "test_effect": {
      const program = parseJson<EffectProgram>(args.program_json, "program_json");
      if (typeof program === "string") return { kind: "read", result: { ok: false, issues: [program] } };
      const anchor = in01(args.anchor_x) && in01(args.anchor_y) ? { x: args.anchor_x, y: args.anchor_y } : { x: 0.5, y: 0.5 };
      const r = testRenderProgram(program, { inputs: { anchor } });
      return { kind: "read", result: { ok: r.ok, issues: r.issues, warnings: r.warnings, stats: r.stats } };
    }

    case "create_effect": {
      const nm = typeof args.name === "string" ? args.name.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const at = Number(args.at);
      if (!nm) return { kind: "error", message: "Give the effect a short name." };
      if (!(at >= 0 && at < ctx.sourceDuration)) return { kind: "error", message: `at must be inside the video (0–${ctx.sourceDuration.toFixed(2)}s).` };
      const program = parseJson<EffectProgram>(args.program_json, "program_json");
      if (typeof program === "string") return { kind: "error", message: program };
      const needsAnchor = Array.isArray(program.inputs) && program.inputs.includes("anchor");
      const anchor = in01(args.anchor_x) && in01(args.anchor_y) ? { x: r3(args.anchor_x), y: r3(args.anchor_y) } : undefined;
      if (needsAnchor && !anchor) return { kind: "error", message: "This program uses the anchor — pass anchor_x/anchor_y (locate the subject first)." };
      const track = parseTrack(args.track_json);
      if (typeof track === "string") return { kind: "error", message: track };
      if (args.distinct === true) {
        const fp = fingerprint(program);
        const same = ctx.library.find((e) => e.versions.some((v) => fingerprint(v.program) === fp));
        if (same) return { kind: "error", message: `That is the same design as "${same.name}" in the library. The user asked for something new — author a visibly different effect.` };
      }
      const inputs: FxInstanceInputs = { ...(anchor ? { anchor } : {}), ...(track ? { track } : {}) };
      const test = testRenderProgram(program, { inputs: anchor ? inputs : { anchor: { x: 0.5, y: 0.5 } } });
      if (!test.ok) return { kind: "error", message: `Test render failed — fix and call create_effect again: ${issuesText(test)}` };
      const n = ++ctx.seq.create;
      const id = effectIdFor(ctx.requestId, `create:${n}`);
      const entry = newEntry({ id, name: nm, description, program, requestId: ctx.requestId, preview: test.preview, origin: "created", note: "created", now: ctx.now });
      const cmd: EditCommand = {
        op: "add_effect",
        at: r3(at),
        fx: { ref: { effectId: id, version: 1, name: entry.name }, program, params: {}, inputs },
      };
      return {
        kind: "command",
        cmd,
        note: `created "${entry.name}" (${id} v1); test render ok — ${test.stats?.visibleFrames}/${test.stats?.frames} frames visible, up to ${test.stats?.maxPrimitives} shapes${test.warnings.length ? `; warnings: ${test.warnings.join(" ")}` : ""}`,
        stage: () => stageEntry(ctx, entry),
      };
    }

    case "apply_effect": {
      const ref = typeof args.effect === "string" ? args.effect : "";
      const entry = findEffect(ctx.library, ref);
      if (!entry) return { kind: "error", message: `No effect "${ref}" in the library. Library: ${ctx.library.map((e) => e.name).join(", ") || "empty"}.` };
      const v = versionOf(entry, typeof args.version === "number" ? args.version : undefined);
      if (!v) return { kind: "error", message: `"${entry.name}" has no version ${String(args.version)}.` };
      const at = Number(args.at);
      if (!(at >= 0 && at < ctx.sourceDuration)) return { kind: "error", message: `at must be inside the video (0–${ctx.sourceDuration.toFixed(2)}s).` };
      const anchor = in01(args.anchor_x) && in01(args.anchor_y) ? { x: r3(args.anchor_x), y: r3(args.anchor_y) } : undefined;
      if (v.program.inputs.includes("anchor") && !anchor) return { kind: "error", message: `"${entry.name}" is anchored — pass anchor_x/anchor_y for this use.` };
      const overrides = args.params_json ? parseJson<FxParamValues>(args.params_json, "params_json") : {};
      if (typeof overrides === "string") return { kind: "error", message: overrides };
      const track = parseTrack(args.track_json);
      if (typeof track === "string") return { kind: "error", message: track };
      return {
        kind: "command",
        cmd: {
          op: "add_effect",
          at: r3(at),
          fx: { ref: { effectId: entry.id, version: v.version, name: entry.name }, program: v.program, params: overrides, inputs: { ...(anchor ? { anchor } : {}), ...(track ? { track } : {}) } },
        },
        note: `reused "${entry.name}" v${v.version} from the library`,
      };
    }

    case "update_effect": {
      const id = typeof args.element_id === "string" ? args.element_id : "";
      const m = instancesOf(ctx).find((x) => x.id === id);
      if (!m) return { kind: "error", message: `No effect instance "${id}" — call get_effects for the ids.` };
      const fx = m.fx!;
      const cmd: Extract<EditCommand, { op: "update_effect" }> = { op: "update_effect", elementId: id };
      if (args.params_json != null && args.params_json !== "") {
        const p = parseJson<FxParamValues>(args.params_json, "params_json");
        if (typeof p === "string") return { kind: "error", message: p };
        cmd.params = p;
      }
      let stage: (() => void) | undefined;
      let note = "updated settings";
      if (args.program_json != null && args.program_json !== "") {
        const program = parseJson<EffectProgram>(args.program_json, "program_json");
        if (typeof program === "string") return { kind: "error", message: program };
        const test = testRenderProgram(program, { inputs: fx.inputs.anchor ? fx.inputs : { anchor: { x: 0.5, y: 0.5 } } });
        if (!test.ok) return { kind: "error", message: `Test render failed — fix and retry: ${issuesText(test)}` };
        const libEntry =
          ctx.library.find((e) => e.id === fx.ref.effectId) ??
          newEntry({ id: fx.ref.effectId, name: fx.ref.name, description: "", program: fx.program, requestId: ctx.requestId, preview: null, origin: "created", note: "restored", now: ctx.now });
        const noteText = typeof args.note === "string" && args.note.trim() ? args.note.trim() : "adapted";
        const { entry, version } = addVersion(libEntry, { program, note: noteText, requestId: ctx.requestId, preview: test.preview, now: ctx.now });
        cmd.program = { program, version, note: noteText };
        stage = () => stageEntry(ctx, entry);
        note = `new version v${version} of "${entry.name}"`;
      }
      if (typeof args.at === "number") cmd.at = r3(args.at);
      if (typeof args.duration === "number") cmd.duration = r3(args.duration);
      if (in01(args.anchor_x) && in01(args.anchor_y)) cmd.anchor = { x: r3(args.anchor_x), y: r3(args.anchor_y) };
      if (!cmd.params && !cmd.program && cmd.at == null && !cmd.anchor && cmd.duration == null) return { kind: "error", message: "Nothing to change — pass params_json (or program_json, at, anchor, duration)." };
      return { kind: "command", cmd, note, stage };
    }

    case "save_effect": {
      const id = typeof args.element_id === "string" ? args.element_id : "";
      const nm = typeof args.name === "string" ? args.name.trim() : "";
      const m = instancesOf(ctx).find((x) => x.id === id);
      if (!m) return { kind: "error", message: `No effect instance "${id}" — call get_effects for the ids.` };
      if (!nm) return { kind: "error", message: "Give the look a name." };
      const fx = m.fx!;
      const program = bakeDefaults(fx.program, resolveParams(fx.program, fx.params));
      const test = testRenderProgram(program, { inputs: fx.inputs.anchor ? fx.inputs : { anchor: { x: 0.5, y: 0.5 } } });
      const description = typeof args.description === "string" && args.description.trim() ? args.description.trim() : `Saved from "${fx.ref.name}" v${fx.ref.version} with its current settings.`;
      const existing = ctx.library.find((e) => e.name.toLowerCase() === nm.toLowerCase());
      let entry: EffectLibraryEntry;
      let version = 1;
      if (existing) {
        const r = addVersion(existing, { program, note: `saved from "${fx.ref.name}" v${fx.ref.version}`, requestId: ctx.requestId, preview: test.preview, now: ctx.now });
        entry = r.entry;
        version = r.version;
      } else {
        entry = newEntry({
          id: effectIdFor(ctx.requestId, `save:${nm.toLowerCase()}`),
          name: nm,
          description,
          program,
          requestId: ctx.requestId,
          preview: test.preview,
          origin: "saved",
          basedOn: { effectId: fx.ref.effectId, version: fx.ref.version, name: fx.ref.name },
          note: `saved from "${fx.ref.name}" v${fx.ref.version}`,
          now: ctx.now,
        });
      }
      // Saving is a library action, not a timeline edit — staged immediately.
      stageEntry(ctx, entry);
      return { kind: "read", result: { saved: { effectId: entry.id, name: entry.name, version }, note: `Saved. Reuse it with apply_effect effect="${entry.name}".` } };
    }

    case "remember": {
      const kind = args.kind === "constraint" || args.kind === "approved" || args.kind === "avoid" ? args.kind : null;
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!kind || !text) return { kind: "error", message: "kind (constraint/approved/avoid) and text are required." };
      const item: AssistantMemoryItem = { kind, text: text.slice(0, 200), at: ctx.now };
      ctx.memoryWrites.push(item);
      ctx.memory = mergeMemory(ctx.memory, [item]);
      return { kind: "read", result: { remembered: item } };
    }

    default:
      return { kind: "error", message: `Unknown effect tool "${name}".` };
  }
}
