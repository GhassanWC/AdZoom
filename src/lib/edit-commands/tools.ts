/**
 * Model-agnostic tool definitions for the editing assistant.
 *
 * Plain JSON Schema + a pure mapping from a tool call to an `EditCommand`. No
 * SDK types here: the Gemini adapter passes `parameters` as
 * `parametersJsonSchema`; a Claude adapter would pass the same object as
 * `input_schema`. Adding a model never changes what a tool does — every edit
 * tool lands in the same validating executor (apply.ts).
 *
 * Three kinds:
 *   read    — inspect the timeline / search the footage (answered by the server)
 *   edit    — become EditCommands (dry-run validated, then applied by the client
 *             against the live timeline as ONE undo step)
 *   control — ask the user a focused question
 *
 * Footage sourcing is deliberately narrow: only the user's uploaded footage
 * can be searched. Stock search and AI footage generation are separate actions
 * the user must ask for, and are not available yet — the prompt says so rather
 * than exposing tools that would pretend.
 */

import type { EditCommand, GraphicPosition, EntranceAnimation } from "./types";
import { entranceAnimation } from "./apply";
import { capabilityTools, isCapabilityOp } from "./registry";

export interface ToolDef {
  name: string;
  kind: "read" | "edit" | "control";
  description: string;
  parameters: Record<string, unknown>;
}

const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });
const POSITIONS: GraphicPosition[] = ["top-left", "top", "top-right", "center", "bottom-left", "bottom", "bottom-right"];
const ANIMS: EntranceAnimation[] = ["slide-left", "slide-up", "fade", "pop", "none"];
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

const BASE_TOOLS: readonly ToolDef[] = [
  // ── Read ──────────────────────────────────────────────────────────────────
  {
    name: "get_timeline",
    kind: "read",
    description: "Current editable state: clips (kept footage in playback order, with source and output times), elements (graphics, zooms, cuts, speed) with ids, captions summary, selection and playhead. Call again after anything may have changed.",
    parameters: obj({}),
  },
  {
    name: "find_footage",
    kind: "read",
    description: "Search the user's uploaded footage for a moment by what is SAID (transcript) or what HAPPENS (analysis labels, story structure). Returns candidate source-time ranges, best first. Use before placing an edit at a described moment.",
    parameters: obj({ query: str("What to find, e.g. 'the celebration', 'when she mentions pricing'."), kind: { type: "string", enum: ["speech", "visual", "any"] } }, ["query"]),
  },
  {
    name: "get_transcript",
    kind: "read",
    description: "Word-timed transcript text between two source times.",
    parameters: obj({ start: num("Source seconds."), end: num("Source seconds.") }, ["start", "end"]),
  },
  {
    name: "find_repeated_takes",
    kind: "read",
    description: "Answers or lines the speaker said twice (false starts / retakes), with both takes' source ranges.",
    parameters: obj({}),
  },
  {
    name: "find_introductions",
    kind: "read",
    description: "Where a speaker introduces themselves, with the spoken name and role when available.",
    parameters: obj({}),
  },
  {
    name: "survey_footage",
    kind: "read",
    description: "Watch an asset and get a shot list: what is on screen when (asset seconds), with the subjects in each shot. The first call for any creative brief on footage without a transcript — it is how you find 'the dish reveal', 'the celebration' or 'the buildup'. asset_id defaults to 'source'; use another asset's id to look at that footage.",
    parameters: obj({ asset_id: str("Asset to watch ('source' or an added asset id).") }),
  },
  {
    name: "locate_elements",
    kind: "read",
    description: "Find where things are in the frame around a source time — the dish, the price, a button, a face. Returns each element's bounding box (0..1 of the frame) and centre. Use before composing a camera move or placing a graphic, so the focal point and the text position come from the footage.",
    parameters: obj({ at: num("Asset seconds."), elements: { type: "array", items: { type: "string" }, description: "What to find, e.g. ['the dish photo', 'the price']." }, asset_id: str("Asset to look at (default 'source').") }, ["at", "elements"]),
  },
  {
    name: "framing_check",
    kind: "read",
    description: "Will an element read at a zoom? Given its box (centre + size, 0..1) and the zoom, returns on-screen size, whether text would be legible (≥3% of frame height), whether it is fully visible, and how far off-centre it lands (offsetX/offsetY) because the window is kept inside the frame.",
    parameters: obj({ x: num("Centre 0..1"), y: num("Centre 0..1"), w: num("Width 0..1"), h: num("Height 0..1"), zoom: num("1.0–1.75") }, ["x", "y", "w", "h", "zoom"]),
  },
  {
    name: "get_camera_moves",
    kind: "read",
    description: "Existing zooms/camera moves with their beats in viewer terms (seconds into the move, focal centre, zoom factor) — what update_camera and set_camera's element_id refer to.",
    parameters: obj({}),
  },
  {
    name: "get_clicks",
    kind: "read",
    description: "Clicks already found in this footage (time + position). Empty = not searched yet: call prepare_footage with \"clicks\".",
    parameters: obj({}),
  },
  {
    name: "inspect_footage",
    kind: "read",
    description: "Watch a SHORT source range closely (max 60s) and answer a precise visual question, e.g. 'at what second does the ball cross the line?'. Use to place a cut exactly on a visible event after find_footage gave an approximate range.",
    parameters: obj({ start: num("Asset seconds."), end: num("Asset seconds."), question: str("What to determine."), asset_id: str("Asset to look at (default 'source').") }, ["start", "end", "question"]),
  },
  {
    name: "list_graphics",
    kind: "read",
    description: "Available graphic designs (preset ids) for add_graphic: lower thirds, titles, callouts, CTAs.",
    parameters: obj({ category: str("Optional filter: titles, callouts, intros, outros, ctas, hooks, text-animations.") }),
  },
  // ── Edit ──────────────────────────────────────────────────────────────────
  {
    name: "trim_clip",
    kind: "edit",
    description: "Remove footage from the start or end of a clip. `seconds` is as the viewer experiences it.",
    parameters: obj({ clip_id: str("Clip id from get_timeline."), edge: { type: "string", enum: ["start", "end"] }, seconds: num("Seconds to remove.") }, ["clip_id", "edge", "seconds"]),
  },
  {
    name: "delete_clip",
    kind: "edit",
    description: "Remove a whole clip from the edit (the source footage is kept and can be restored).",
    parameters: obj({ clip_id: str("Clip id from get_timeline.") }, ["clip_id"]),
  },
  {
    name: "remove_range",
    kind: "edit",
    description: "Remove a source-time range from the edit (e.g. a repeated take, a false start, dead air). Place boundaries in pauses between words.",
    parameters: obj({ start: num("Source seconds."), end: num("Source seconds."), reason: str("Short reason shown to the user.") }, ["start", "end"]),
  },
  {
    name: "restore_range",
    kind: "edit",
    description: "Put previously removed footage back.",
    parameters: obj({ start: num("Source seconds."), end: num("Source seconds.") }, ["start", "end"]),
  },
  {
    name: "set_speed",
    kind: "edit",
    description: "Speed up a source-time range (multiplier above 1, up to 16). Slow motion is not supported.",
    parameters: obj({ start: num("Source seconds."), end: num("Source seconds."), multiplier: num("e.g. 2 for double speed.") }, ["start", "end", "multiplier"]),
  },
  {
    name: "add_captions",
    kind: "edit",
    description: "Caption the speech from the word-timed transcript (optionally only a source range). Replaces existing captions in that range. Requires a transcript.",
    parameters: obj({ start: num("Optional source seconds."), end: num("Optional source seconds.") }),
  },
  {
    name: "add_graphic",
    kind: "edit",
    description: "Insert an editable animated graphic (lower third, title, callout…) from list_graphics. Text, position, colours, timing and animation stay editable afterwards.",
    parameters: obj(
      {
        preset_id: str("A preset id from list_graphics, e.g. callout-lower-third."),
        text: str("The text to show, e.g. 'Sarah Chen · Head of Design'."),
        start: num("Source seconds when it appears."),
        duration: num("Seconds on screen (optional)."),
        position: { type: "string", enum: POSITIONS },
        color: str("Text colour #rrggbb (optional)."),
        background_color: str("Plate colour #rrggbb (optional)."),
        animation: { type: "string", enum: ANIMS },
      },
      ["preset_id", "text", "start"]
    ),
  },
  {
    name: "add_zoom",
    kind: "edit",
    description: "Zoom the camera into part of the frame for a source range.",
    parameters: obj({ start: num("Source seconds."), end: num("Source seconds."), scale: num("1.1–4, default 1.6."), x: num("Focus centre 0..1 of width."), y: num("Focus centre 0..1 of height.") }, ["start", "end"]),
  },
  {
    name: "add_click_zooms",
    kind: "edit",
    description: "Add one zoom on every click found in the footage (or in a source range), framed on where the click happened. Needs clicks: call prepare_footage with \"clicks\" first if get_clicks returns none.",
    parameters: obj({ start: num("Optional source seconds."), end: num("Optional source seconds."), scale: num("1.2–3, default 1.8.") }),
  },
  {
    name: "tighten_pauses",
    kind: "edit",
    description: "Remove dead air: shorten every pause longer than min_pause to keep seconds, cutting between words. For a calm pace use min_pause 1.4 / keep 0.6; for a tight pace 0.9 / 0.35.",
    parameters: obj({ min_pause: num("Seconds, default 1.0."), keep: num("Seconds of pause to keep, default 0.35.") }),
  },
  {
    name: "set_camera",
    kind: "edit",
    description:
      "Compose a camera move as beats: hold wide, push into a subject off-centre, pan to a second subject, hold on a detail — the resolver eases between beats and eases back out at the end. A subject near the frame edge cannot be centred (the window is pulled inside the frame) — it stays visible at the edge of the shot; use framing_check to confirm it is visible, legible and where it lands. Pass element_id to recompose an existing zoom instead of adding one.",
    parameters: obj({ start: num("Source seconds."), end: num("Source seconds."), beats: {
          type: "array",
          description: "Beats in order. at = seconds into the move; x,y = focal centre 0..1; zoom = 1.0 (full frame) to 1.75; ease into the beat.",
          items: obj({ at: num("Seconds into the move."), x: num("0..1"), y: num("0..1"), zoom: num("1.0–1.75"), ease: { type: "string", enum: ["linear", "ease-in", "ease-out", "ease-in-out"] } }, ["at", "x", "y", "zoom"]),
        }, element_id: str("Existing zoom to recompose (optional).") }, ["start", "end", "beats"]),
  },
  {
    name: "update_camera",
    kind: "edit",
    description: "Targeted camera revisions on an existing zoom/move: slower or faster push-in, hold the final framing N seconds longer (keeps every beat), or rescale the strongest zoom. Only the given properties change.",
    parameters: obj({ element_id: str("Zoom id from get_timeline."), slower: { type: "boolean" }, faster: { type: "boolean" }, hold_seconds: num("Extend the end, holding the last framing."), zoom: num("New strongest zoom, 1.05–1.75.") }, ["element_id"]),
  },
  {
    name: "compose_graphic",
    kind: "edit",
    description:
      "Design a graphic from editable parts — text, rect, line — each with a position (0..1 of the canvas), style, z-order and a staggered entrance (delay + entrance). For a dish label pass label_title (+ label_sub for the price, label_tone, label_x, label_y): the house design composes accent line → title → sub. Keep text inside the safe area and away from the subject.",
    parameters: obj(
      {
        start: num("Source seconds."),
        duration: num("Seconds on screen, default 4."),
        label_title: str("Dish label main text."),
        label_sub: str("Dish label second line, e.g. 'Rs 380'."),
        label_tone: { type: "string", enum: ["clean", "premium", "bold"] },
        label_x: num("Label left edge 0..1, default 0.07."),
        label_y: num("Label title centre 0..1, default 0.78."),
        parts: {
          type: "array",
          description: "Explicit parts (alternative to label_*). At most 6.",
          items: obj(
            {
              id: str("Stable id, e.g. 'title', 'accent'."),
              kind: { type: "string", enum: ["text", "rect", "line"] },
              x: num("0..1"),
              y: num("0..1"),
              z: num("Draw order, higher on top."),
              opacity: num("0..1"),
              delay: num("Seconds after the graphic starts."),
              entrance: { type: "string", enum: ["fade", "slide-up", "slide-left", "pop", "grow", "none"] },
              text: str("Text parts only."),
              font_scale: num("Text size as a fraction of frame height, e.g. 0.05."),
              font_weight: num("400–800"),
              font_family: { type: "string", enum: ["sans", "serif", "mono"] },
              color: str("#rrggbb — text colour, or rect/line colour."),
              align: { type: "string", enum: ["left", "center", "right"] },
              uppercase: { type: "boolean" },
              background: { type: "string", enum: ["none", "box", "pill"] },
              background_color: str("#rrggbb plate behind text."),
              max_width: num("Text wrap width 0..1."),
              w: num("Rect width 0..1."),
              h: num("Rect height 0..1."),
              radius: num("Rect corner radius, fraction of height."),
              x2: num("Line end 0..1."),
              y2: num("Line end 0..1."),
              thickness: num("Line width, fraction of frame height."),
            },
            ["kind", "x", "y"]
          ),
        },
      },
      ["start"]
    ),
  },
  {
    name: "update_graphic",
    kind: "edit",
    description: "Targeted graphic revisions: remove parts (by id or kind: 'line', 'text', 'rect'; 'title' = first text, 'sub'/'price' = second), change a part's text or colour, nudge all parts, or retime. Only the given properties change.",
    parameters: obj(
      {
        element_id: str("Graphic id from get_timeline."),
        remove_parts: { type: "array", items: { type: "string" }, description: "Part ids or kinds to remove: 'line', 'text', 'rect', 'title', 'sub'." },
        set_text_part: str("Part id or kind whose text changes (with set_text)."),
        set_text: str("New text for set_text_part."),
        set_color_part: str("Part id or kind whose colour changes (with set_color)."),
        set_color: str("#rrggbb for set_color_part."),
        move_dx: num("Nudge all parts horizontally, 0..1 of width."),
        move_dy: num("Nudge all parts vertically, 0..1 of height."),
        start: num("New source start."),
        end: num("New source end."),
      },
      ["element_id"]
    ),
  },
  {
    name: "add_transition",
    kind: "edit",
    description: "Add a transition (fade = dip to black, zoom, swipe, flash, smooth_cut) starting at a source time — typically at the start of a clip.",
    parameters: obj({ at: num("Source seconds."), style: { type: "string", enum: ["fade", "zoom", "swipe", "flash", "smooth_cut"] }, duration: num("Seconds, 0.3–2.") }, ["at"]),
  },
  {
    name: "update_element",
    kind: "edit",
    description: "Change an existing element: timing, text, position, colours, size or entrance animation, or hide/show it. Only the fields given change.",
    parameters: obj(
      {
        element_id: str("Element id from get_timeline."),
        start: num("New source start."),
        end: num("New source end."),
        text: str("New text."),
        position: { type: "string", enum: POSITIONS },
        color: str("#rrggbb"),
        background_color: str("#rrggbb"),
        font_scale: num("Text size as a fraction of frame height, e.g. 0.05."),
        animation: { type: "string", enum: ANIMS },
        enabled: { type: "boolean" },
      },
      ["element_id"]
    ),
  },
  {
    name: "shift_element",
    kind: "edit",
    description: "Move an element in time by a number of seconds (positive = later, negative = earlier), keeping its duration.",
    parameters: obj({ element_id: str("Element id."), seconds: num("Seconds to shift.") }, ["element_id", "seconds"]),
  },
  {
    name: "split_element",
    kind: "edit",
    description: "Split an element in two at a source time.",
    parameters: obj({ element_id: str("Element id."), at: num("Source seconds.") }, ["element_id", "at"]),
  },
  {
    name: "remove_element",
    kind: "edit",
    description: "Delete an element (graphic, zoom, speed change, cut).",
    parameters: obj({ element_id: str("Element id.") }, ["element_id"]),
  },
  // ── Control ───────────────────────────────────────────────────────────────
  {
    name: "prepare_footage",
    kind: "control",
    description: "Run footage analysis the request depends on, then continue: \"transcript\" (speech-to-text — needed for captions, repeated takes, introductions), \"clicks\" (find clicks: recorded events, frame analysis, then watching the video), \"pauses\" (measure silences). Use this instead of asking the user to generate anything.",
    parameters: obj({ needs: { type: "array", items: { type: "string", enum: ["transcript", "clicks", "pauses"] } } }, ["needs"]),
  },
  {
    name: "ask_user",
    kind: "control",
    description: "Ask ONE focused question when a creative choice would materially change the result, or when the requested moment is missing or genuinely ambiguous. Offer the closest candidates as options. Do not make edits in the same turn.",
    parameters: obj({ question: str("The question."), options: { type: "array", items: { type: "string" } } }, ["question"]),
  },
];

/** Every tool: the base set, the sequence READ tools, and one edit tool per registry capability. */
export const EDIT_TOOLS: readonly ToolDef[] = [
  ...BASE_TOOLS,
  {
    name: "get_sequence",
    kind: "read",
    description: "The multi-source timeline: clips in playback order (id, asset, source in/out, sequence start/end, speed, fades, transition, audio), frozen frames, independent audio tracks, and the project's assets. Call before any clip/freeze/speed/transition/audio operation — those take the clip ids returned here.",
    parameters: obj({}),
  },
  {
    name: "list_assets",
    kind: "read",
    description: "Media available to this project: 'source' (the original upload) plus added assets (second angles, music, narration) with duration and whether they have audio.",
    parameters: obj({}),
  },
  {
    name: "get_capabilities",
    kind: "read",
    description: "The editor's operation matrix: every sequence capability with its inputs, timing semantics and what it affects. Use it to plan a compound edit or to answer 'can you…'.",
    parameters: obj({}),
  },
  ...capabilityTools(),
];

export const TOOL_KIND = new Map(EDIT_TOOLS.map((t) => [t.name, t.kind]));

type Args = Record<string, unknown>;
const n = (a: Args, k: string): number | undefined => (typeof a[k] === "number" && Number.isFinite(a[k]) ? (a[k] as number) : undefined);
const s = (a: Args, k: string): string | undefined => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/** A model's edit-tool call → an EditCommand, or an error string for the model. */
export function toolCallToCommand(name: string, args: Args): EditCommand | string {
  const need = (v: unknown, what: string) => (v == null ? `Missing ${what}.` : null);
  switch (name) {
    case "trim_clip": {
      const edge = oneOf(args.edge, ["start", "end"] as const);
      const e = need(s(args, "clip_id"), "clip_id") ?? need(edge, "edge") ?? need(n(args, "seconds"), "seconds");
      return e ?? { op: "trim_clip", clipId: s(args, "clip_id")!, edge: edge!, seconds: n(args, "seconds")! };
    }
    case "delete_clip":
      return need(s(args, "clip_id"), "clip_id") ?? { op: "delete_clip", clipId: s(args, "clip_id")! };
    case "remove_range":
      return need(n(args, "start"), "start") ?? need(n(args, "end"), "end") ?? { op: "remove_range", start: n(args, "start")!, end: n(args, "end")!, ...(s(args, "reason") ? { reason: s(args, "reason") } : {}) };
    case "restore_range":
      return need(n(args, "start"), "start") ?? need(n(args, "end"), "end") ?? { op: "restore_range", start: n(args, "start")!, end: n(args, "end")! };
    case "set_speed":
      return need(n(args, "start"), "start") ?? need(n(args, "end"), "end") ?? need(n(args, "multiplier"), "multiplier") ?? { op: "set_speed", start: n(args, "start")!, end: n(args, "end")!, multiplier: n(args, "multiplier")! };
    case "add_captions":
      return { op: "add_captions", ...(n(args, "start") != null ? { start: n(args, "start") } : {}), ...(n(args, "end") != null ? { end: n(args, "end") } : {}) };
    case "add_graphic": {
      const e = need(s(args, "preset_id"), "preset_id") ?? need(s(args, "text"), "text") ?? need(n(args, "start"), "start");
      if (e) return e;
      return {
        op: "add_graphic",
        presetId: s(args, "preset_id")!,
        text: s(args, "text")!,
        start: n(args, "start")!,
        ...(n(args, "duration") != null ? { duration: n(args, "duration") } : {}),
        ...(oneOf(args.position, POSITIONS) ? { position: oneOf(args.position, POSITIONS) } : {}),
        ...(s(args, "color") ? { color: s(args, "color") } : {}),
        ...(s(args, "background_color") ? { backgroundColor: s(args, "background_color") } : {}),
        ...(oneOf(args.animation, ANIMS) ? { animation: oneOf(args.animation, ANIMS) } : {}),
      };
    }
    case "add_zoom":
      return need(n(args, "start"), "start") ?? need(n(args, "end"), "end") ?? { op: "add_zoom", start: n(args, "start")!, end: n(args, "end")!, scale: n(args, "scale"), x: n(args, "x"), y: n(args, "y") };
    case "set_camera": {
      const e = need(n(args, "start"), "start") ?? need(n(args, "end"), "end");
      if (e) return e;
      const beats = Array.isArray(args.beats)
        ? (args.beats as Record<string, unknown>[]).filter((b) => b && typeof b === "object").map((b) => ({
            at: Number(b.at), x: Number(b.x), y: Number(b.y), zoom: Number(b.zoom),
            ...(oneOf(b.ease, ["linear", "ease-in", "ease-out", "ease-in-out"] as const) ? { ease: oneOf(b.ease, ["linear", "ease-in", "ease-out", "ease-in-out"] as const) } : {}),
          }))
        : [];
      if (!beats.length) return "Missing beats.";
      return { op: "set_camera", start: n(args, "start")!, end: n(args, "end")!, beats, ...(s(args, "element_id") ? { elementId: s(args, "element_id") } : {}) };
    }
    case "update_camera": {
      const id = s(args, "element_id");
      if (!id) return "Missing element_id.";
      return {
        op: "update_camera", elementId: id,
        ...(args.slower === true ? { slower: true } : {}), ...(args.faster === true ? { faster: true } : {}),
        ...(n(args, "hold_seconds") != null ? { holdSeconds: n(args, "hold_seconds") } : {}),
        ...(n(args, "zoom") != null ? { zoom: n(args, "zoom") } : {}),
      };
    }
    case "compose_graphic": {
      if (n(args, "start") == null) return "Missing start.";
      const title = s(args, "label_title");
      const parts = Array.isArray(args.parts) ? (args.parts as Record<string, unknown>[]).slice(0, 6).map(flatPartToPart) : [];
      if (!title && parts.length === 0) return "Give label_title (a dish label) or parts.";
      return {
        op: "compose_graphic", start: n(args, "start")!,
        ...(n(args, "duration") != null ? { duration: n(args, "duration") } : {}),
        ...(title
          ? { label: { title, ...(s(args, "label_sub") ? { sub: s(args, "label_sub") } : {}), ...(oneOf(args.label_tone, ["clean", "premium", "bold"] as const) ? { tone: oneOf(args.label_tone, ["clean", "premium", "bold"] as const) } : {}), ...(n(args, "label_x") != null ? { x: n(args, "label_x") } : {}), ...(n(args, "label_y") != null ? { y: n(args, "label_y") } : {}) } }
          : {}),
        ...(parts.length ? { parts: parts as never[] } : {}),
      };
    }
    case "update_graphic": {
      const id = s(args, "element_id");
      if (!id) return "Missing element_id.";
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const hasMove = n(args, "move_dx") != null || n(args, "move_dy") != null;
      return {
        op: "update_graphic", elementId: id,
        ...(strs(args.remove_parts).length ? { removeParts: strs(args.remove_parts) } : {}),
        ...(s(args, "set_text_part") && typeof args.set_text === "string" ? { setText: [{ part: s(args, "set_text_part")!, text: args.set_text }] } : {}),
        ...(s(args, "set_color_part") && s(args, "set_color") ? { setColor: [{ part: s(args, "set_color_part")!, color: s(args, "set_color")! }] } : {}),
        ...(hasMove ? { move: { dx: n(args, "move_dx") ?? 0, dy: n(args, "move_dy") ?? 0 } } : {}),
        ...(n(args, "start") != null ? { start: n(args, "start") } : {}), ...(n(args, "end") != null ? { end: n(args, "end") } : {}),
      };
    }
    case "add_transition": {
      const style = oneOf(args.style, ["fade", "zoom", "swipe", "flash", "smooth_cut"] as const);
      return need(n(args, "at"), "at") ?? { op: "add_transition", at: n(args, "at")!, ...(style ? { style } : {}), ...(n(args, "duration") != null ? { duration: n(args, "duration") } : {}) };
    }
    case "add_click_zooms":
      return { op: "add_click_zooms", ...(n(args, "start") != null ? { start: n(args, "start") } : {}), ...(n(args, "end") != null ? { end: n(args, "end") } : {}), ...(n(args, "scale") != null ? { scale: n(args, "scale") } : {}) };
    case "tighten_pauses":
      return { op: "tighten_pauses", ...(n(args, "min_pause") != null ? { minPause: n(args, "min_pause") } : {}), ...(n(args, "keep") != null ? { keep: n(args, "keep") } : {}) };
    case "update_element": {
      const id = s(args, "element_id");
      if (!id) return "Missing element_id.";
      return {
        op: "update_element",
        elementId: id,
        ...(n(args, "start") != null ? { start: n(args, "start") } : {}),
        ...(n(args, "end") != null ? { end: n(args, "end") } : {}),
        ...(typeof args.text === "string" ? { text: args.text } : {}),
        ...(oneOf(args.position, POSITIONS) ? { position: oneOf(args.position, POSITIONS) } : {}),
        ...(s(args, "color") ? { color: s(args, "color") } : {}),
        ...(s(args, "background_color") ? { backgroundColor: s(args, "background_color") } : {}),
        ...(n(args, "font_scale") != null ? { fontScale: n(args, "font_scale") } : {}),
        ...(oneOf(args.animation, ANIMS) ? { animation: oneOf(args.animation, ANIMS) } : {}),
        ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
      };
    }
    case "shift_element":
      return need(s(args, "element_id"), "element_id") ?? need(n(args, "seconds"), "seconds") ?? { op: "shift_element", elementId: s(args, "element_id")!, seconds: n(args, "seconds")! };
    case "split_element":
      return need(s(args, "element_id"), "element_id") ?? need(n(args, "at"), "at") ?? { op: "split_element", elementId: s(args, "element_id")!, at: n(args, "at")! };
    case "remove_element":
      return need(s(args, "element_id"), "element_id") ?? { op: "remove_element", elementId: s(args, "element_id")! };
    default:
      // Registry capabilities carry their flat args straight to the executor,
      // which validates them against the live sequence.
      if (isCapabilityOp(name)) return { op: "capability", capability: name, args };
      return `Unknown edit tool "${name}".`;
  }
}

/** A flat tool part (primitive fields only — Gemini can't emit nested objects reliably) → a GraphicPart. */
function flatPartToPart(p: Record<string, unknown>): Record<string, unknown> {
  const entrance = oneOf(p.entrance, ["fade", "slide-up", "slide-left", "pop", "grow", "none"] as const);
  const animation =
    entrance === "grow"
      ? { in: { durationSeconds: 0.45, ease: "ease-out", scale: [0.01, 1], opacity: [0, 1] }, out: { durationSeconds: 0.3, ease: "ease-in", opacity: [1, 0] } }
      : entrance && entrance !== "none"
        ? entranceAnimation(entrance)
        : undefined;
  const style: Record<string, unknown> = {};
  if (typeof p.font_scale === "number") style.fontScale = p.font_scale;
  if (typeof p.font_weight === "number") style.fontWeight = p.font_weight;
  if (typeof p.font_family === "string") style.fontFamily = p.font_family;
  if (typeof p.color === "string" && p.kind === "text") style.color = p.color;
  if (typeof p.align === "string") style.align = p.align;
  if (typeof p.uppercase === "boolean") style.uppercase = p.uppercase;
  if (typeof p.background === "string") style.background = p.background;
  if (typeof p.background_color === "string") { style.backgroundColor = p.background_color; if (!style.background) style.background = "box"; }
  return {
    id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, opacity: p.opacity, delay: p.delay,
    ...(animation ? { animation } : {}),
    text: p.text, maxWidth: p.max_width, ...(Object.keys(style).length ? { style } : {}),
    w: p.w, h: p.h, radius: p.radius, x2: p.x2, y2: p.y2, thickness: p.thickness,
    color: p.kind === "text" ? undefined : p.color,
  };
}
