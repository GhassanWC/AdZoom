/**
 * Local understanding of DIRECT editing requests — the ones a professional
 * editor would just do without discussion:
 *
 *   "Trim the first two seconds"            (selected clip / clip under playhead)
 *   "Delete this clip" · "Remove clip 3"
 *   "Cut 0:12 to 0:15" · "Put back 0:12–0:15"
 *   "Speed up this clip 2x"
 *   "Add captions"
 *   "Remove the repeated answer"
 *   "Add an animated lower third when the speaker introduces herself"
 *   "Move it to the top left and delay it half a second"
 *   "Change the title to "Q3 results"" · "Remove that title"
 *
 * Returns commands for the shared executor, a focused QUESTION when a choice
 * would materially change the result, or `none` — which hands the request to
 * the model. It never guesses: an unresolved reference is a question, not a
 * pick.
 *
 * Pure. Tested in tests/edit-commands.test.ts.
 */

import type { EditCommand, GraphicPosition } from "./types";
import { resolveClipRef, resolveElementRef, type AssistantInput } from "./context";
import { findIntroductions, findRepeatedTakes, takeCutRange } from "./footage";
import { deriveClips } from "./clips";
import { visibleMoments } from "@/lib/timeline/layers";
import { parseEffectRevision } from "@/lib/effects/revise";
import type { DetectedMoment } from "@/lib/firebase/schema";

/**
 * Footage understanding a request depends on. The chat PREPARES these on its
 * own (transcribe, find clicks, measure pauses) and then parses again — a
 * missing transcript is a step to run, never a question for the user.
 */
export type FootageNeed = "transcript" | "clicks" | "pauses";

/**
 * Former right-toolbar tools, reachable by name in chat ("crop the frame",
 * "make it vertical", "show suggestions"). Same destinations as the timeline
 * menus and the chat's Tools menu.
 */
export type UiAction =
  | { kind: "crop" }
  | { kind: "canvas" }
  | { kind: "aspect"; aspect: "9:16" | "1:1" | "16:9" | "4:5" | "source" }
  | { kind: "captions-panel" }
  | { kind: "presets"; tab?: "looks" }
  | { kind: "clips" }
  | { kind: "insights" }
  | { kind: "full-edit" };

export type ParseOutcome =
  | {
      kind: "commands";
      commands: EditCommand[];
      notes: string[];
      /** "I like the ripple" clauses — recorded in the project's memory as approvals. */
      approvals?: string[];
    }
  | { kind: "needs"; needs: FootageNeed[] }
  | { kind: "ui"; action: UiAction }
  | { kind: "question"; question: string; options?: string[] }
  | { kind: "none" };

const hasTranscript = (input: AssistantInput) =>
  input.project.analysis?.transcript?.status === "complete" &&
  (input.project.analysis.transcript.segments?.length ?? 0) > 0;

const NUM_WORDS: Record<string, number> = {
  zero: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

/** "two", "1.5", "half a", "a couple of", "one and a half" → seconds-count. */
export function parseAmount(s: string): number | null {
  const t = s.toLowerCase().trim();
  if (/^half(?: a| of a)?$/.test(t)) return 0.5;
  if (/^a couple(?: of)?$/.test(t)) return 2;
  const andHalf = /^(\w+) and a half$/.exec(t);
  if (andHalf) {
    const base = parseAmount(andHalf[1]);
    return base == null ? null : base + 0.5;
  }
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t in NUM_WORDS ? NUM_WORDS[t] : null;
}

const AMOUNT = String.raw`(\d+(?:\.\d+)?|half(?: a| of a)?|a couple(?: of)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|a|an)(?: and a half)?|zero|eleven|twelve|fifteen|twenty|thirty)`;
const SECONDS = String.raw`\s*(?:s|sec|secs|second|seconds)\b`;

/** "0:12", "1:05.5", "12s", "12 seconds", "at 12" → seconds. */
export function parseTimestamp(s: string): number | null {
  const mmss = /^(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(s.trim());
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const sec = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?$/.exec(s.trim());
  return sec ? Number(sec[1]) : null;
}

const TIME = String.raw`(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds?)?)`;

const POSITIONS: [RegExp, GraphicPosition][] = [
  [/\btop[ -]?left|upper[ -]?left\b/, "top-left"],
  [/\btop[ -]?right|upper[ -]?right\b/, "top-right"],
  [/\bbottom[ -]?left|lower[ -]?left\b/, "bottom-left"],
  [/\bbottom[ -]?right|lower[ -]?right\b/, "bottom-right"],
  [/\b(center|centre|middle)\b/, "center"],
  [/\btop\b/, "top"],
  [/\bbottom\b/, "bottom"],
];

/** Split a compound request into clauses: "move it … and delay it …". */
export function clauses(text: string): string[] {
  return text
    .split(/\s*(?:,?\s+and then\s+|,?\s+then\s+|;\s*|\.\s+|,?\s+and\s+(?=(?:also\s+)?(?:move|delay|push|change|make|add|remove|delete|trim|cut|put|set|speed|shift|bring|place)\b))/i)
    .map((c) => c.trim().replace(/[.!?]+$/, ""))
    .filter(Boolean);
}

export function parseEditRequest(raw: string, input: AssistantInput): ParseOutcome {
  const parts = clauses(raw);
  const commands: EditCommand[] = [];
  const notes: string[] = [];
  // A clause's "it" can refer to something an EARLIER clause in the same
  // message created/changed; track it so "add a lower third and move it up" works.
  let lastElementId: string | null = null;
  const ctx = (): AssistantInput =>
    lastElementId ? { ...input, recentElementIds: [lastElementId, ...input.recentElementIds] } : input;

  const needs = new Set<FootageNeed>();
  const approvals: string[] = [];
  for (const part of parts) {
    // "I like the ripple." is direction, not an edit: remember it, keep parsing.
    const liked = APPROVAL.exec(part.trim().toLowerCase().replace(/[’']/g, "'"));
    if (liked && parts.length > 1) {
      approvals.push(liked[1].replace(/[.!]+$/, "").trim());
      continue;
    }
    const r = parseClause(part, ctx(), (id) => (lastElementId = id));
    if (r.kind === "question") return r;
    if (r.kind === "ui") return parts.length === 1 ? r : { kind: "none" };
    if (r.kind === "none") return parts.length === 1 ? r : { kind: "none" };
    if (r.kind === "needs") {
      r.needs.forEach((n) => needs.add(n));
      continue;
    }
    commands.push(...r.commands);
    notes.push(...r.notes);
  }
  // Prepare everything any clause needs, then the caller parses again.
  if (needs.size > 0) return { kind: "needs", needs: [...needs] };
  return commands.length ? { kind: "commands", commands, notes, ...(approvals.length ? { approvals } : {}) } : { kind: "none" };
}

/** An approval clause; group 1 is what they liked. */
const APPROVAL = /^(?:i (?:really )?(?:like|love)|love|nice|great|perfect)\s+(?:the\s+|that\s+|this\s+)?(.{1,40})$/;

/** The fx instance a revision means: selected → just changed → under the playhead → the only one. */
function effectTarget(input: AssistantInput): DetectedMoment | null {
  const fx = input.moments.filter((m) => m.effectType === "fx" && m.fx);
  if (!fx.length) return null;
  const sel = fx.find((m) => m.id === input.selection.elementId);
  if (sel) return sel;
  for (const id of input.recentElementIds) {
    const m = fx.find((x) => x.id === id);
    if (m) return m;
  }
  const here = fx.filter((m) => input.playhead >= m.startTime && input.playhead < m.endTime);
  if (here.length === 1) return here[0];
  return fx.length === 1 ? fx[0] : null;
}

function parseClause(
  text: string,
  input: AssistantInput,
  setLast: (id: string) => void
): ParseOutcome {
  const t = text.toLowerCase().replace(/[’']/g, "'").trim();
  const one = (c: EditCommand, note?: string): ParseOutcome => ({ kind: "commands", commands: [c], notes: note ? [note] : [] });

  // ── Effect settings ("make only the sparks fade faster", "make this one blue") ──
  if (input.moments.some((m) => m.effectType === "fx")) {
    const rev = parseEffectRevision(t, effectTarget(input), input.moments.filter((m) => m.effectType === "fx").length);
    if (rev.kind === "question") return { kind: "question", question: rev.question };
    if (rev.kind === "params") {
      setLast(rev.elementId);
      // The change summary already says "Spark fade 1.6 → 2.88" — no second note.
      return one({ op: "update_effect", elementId: rev.elementId, params: rev.params });
    }
  }

  const wantsCaptions =
    /\b(add|generate|create|put|turn on|include|with|plus)\b[^.]*\b(captions?|subtitles?|subs)\b/.test(t) ||
    /^(captions?|subtitles?|caption it|subtitle it)\b/.test(t);

  // ── Pacing: "make a calm walkthrough (with captions)", "remove dead air" ──
  // "calm" alone is a creative brief ("a calm menu walkthrough" is about camera
  // and graphics, not speech pauses) — it is only a pacing command when the
  // request also names pauses / pacing / captions. Explicit pause words always are.
  const calm =
    /\b(calm|calmer|relaxed|gentle|unhurried|slower[- ]paced|easy[- ]paced)\b/.test(t) &&
    /\b(pauses?|pacing|pace|silences?|dead air|captions?|subtitles?)\b/.test(t);
  const tighten = /\b(dead air|long pauses?|silences?|silent parts?|awkward pauses?|tighten( up)?( the)? (pauses|pacing)|remove( the)? pauses)\b/.test(t);
  if (calm || tighten) {
    const needsList: FootageNeed[] = [];
    if (!hasTranscript(input)) needsList.push(wantsCaptions ? "transcript" : "pauses");
    if (needsList.length && !input.prepared?.includes(needsList[0])) return { kind: "needs", needs: needsList };
    const cmds: EditCommand[] = [
      // Calm keeps more breathing room between sentences than a tight cut.
      calm ? { op: "tighten_pauses", minPause: 1.4, keep: 0.6 } : { op: "tighten_pauses", minPause: 0.9, keep: 0.35 },
    ];
    if (wantsCaptions) cmds.push({ op: "add_captions" });
    return { kind: "commands", commands: cmds, notes: [] };
  }

  // ── Zooms on clicks ───────────────────────────────────────────────────────
  if (/\bzoom(s|ing)?\b.*\b(clicks?|clicked|click(ing)?)\b|\bclicks?\b.*\bzoom/.test(t)) {
    if (!input.prepared?.includes("clicks") && !(input.clicks && input.clicks.length)) return { kind: "needs", needs: ["clicks"] };
    return one({ op: "add_click_zooms" });
  }

  // ── Captions ──────────────────────────────────────────────────────────────
  if (wantsCaptions) {
    if (!hasTranscript(input) && !input.prepared?.includes("transcript")) return { kind: "needs", needs: ["transcript"] };
    return one({ op: "add_captions" });
  }

  // ── Camera-move revisions ─────────────────────────────────────────────────
  const slower = /\b(slower|slow(er)? down|more slowly|less abrupt|gentler|ease in more)\b/.test(t) && /\b(push[- ]?in|zoom|camera|move|pan)\b/.test(t);
  const faster = /\b(faster|quicker|speed up|snappier|punchier)\b/.test(t) && /\b(push[- ]?in|zoom|camera|move|pan)\b/.test(t);
  const holdM = /\b(keep|hold|stay|linger)\b.*?\b(visible|on screen|in frame|in view|longer|a bit longer|for (longer|a while))\b/.exec(t) ?? /\bhold (on )?(it|that|the \w+)( for)? longer\b/.exec(t);
  if (slower || faster || holdM) {
    const el = resolveElementRef(t.replace(/\bthe (price|dish|title|label)\b/g, "zoom"), { ...input, recentElementIds: input.recentElementIds });
    const zoom = el && (el.effectType === "zoom" || el.effectType === "cursor-focus") ? el : zoomUnderPlayheadOrOnly(input);
    if (!zoom) return { kind: "question", question: "Which camera move do you mean? Select the zoom on the timeline and ask again." };
    setLast(zoom.id);
    if (holdM && !slower && !faster) {
      const amt = new RegExp(String.raw`${AMOUNT}${SECONDS}`).exec(t);
      const holdSeconds = amt ? parseAmount(amt[1]) ?? 1.5 : 1.5;
      return one({ op: "update_camera", elementId: zoom.id, holdSeconds }, "The last framing now holds longer before easing back out.");
    }
    return one({ op: "update_camera", elementId: zoom.id, ...(slower ? { slower: true } : { faster: true }) });
  }

  // ── Graphic-part revisions ("remove the line but keep the title") ─────────
  const partWord = "(line|accent( line)?|rule|underline|box|rect(angle)?|shape|plate|background|title|price|sub(title| ?line)?|second line)";
  const removePart = new RegExp(String.raw`\b(remove|delete|drop|get rid of|lose|hide)\s+(the\s+)?${partWord}\b`).exec(t);
  if (removePart && /\b(keep|but|from the (label|graphic))\b/.test(t) || (removePart && input.moments.some((m) => m.effectType === "graphic"))) {
    const g = resolveElementRef("graphic", input);
    const graphic = g && g.effectType === "graphic" ? g : input.moments.filter((m) => m.effectType === "graphic").length === 1 ? input.moments.find((m) => m.effectType === "graphic")! : null;
    if (graphic && removePart) {
      const ref = removePart[3].replace(/\s+line$/, "").replace(/^accent.*/, "line").replace(/^(rule|underline)$/, "line").replace(/^(box|rect|rectangle|shape|plate|background)$/, "rect").replace(/^(sub.*|second line)$/, "sub");
      setLast(graphic.id);
      return one({ op: "update_graphic", elementId: graphic.id, removeParts: [ref] });
    }
    if (removePart && input.moments.filter((m) => m.effectType === "graphic").length > 1) {
      return { kind: "question", question: "Which graphic do you mean? Select it on the timeline (or move the playhead onto it) and ask again." };
    }
  }

  // ── A designed label ("add a label for the dish saying Chicken Tikka, Rs 380") ─
  const addLabel = /\b(add|put|place|create|design)\b.*\b(label|name card|dish (card|tag)|title card)\b/.exec(t);
  if (addLabel) {
    const q = quoted(text);
    const [title, ...rest] = (q ?? "").split(/\s*[,·|–—-]\s*(?=rs|\$|€|£|\d)/i);
    const premium = /\b(premium|luxury|elegant|cinematic|high[- ]end)\b/.test(t);
    const bold = /\b(bold|loud|punchy|social)\b/.test(t);
    const at = new RegExp(String.raw`\bat\s+${TIME}`).exec(t);
    const start = at ? parseTimestamp(at[1]) ?? input.playhead : input.playhead;
    if (!title.trim()) return { kind: "question", question: "What should the label say? For example: add a label saying “Chicken Tikka, Rs 380”." };
    return one({
      op: "compose_graphic",
      start: Math.round(start * 1000) / 1000,
      label: { title: title.trim(), ...(rest.length ? { sub: rest.join(" ").trim() } : {}), tone: premium ? "premium" : bold ? "bold" : "clean" },
    });
  }

  // ── Former toolbar tools, by name ─────────────────────────────────────────
  const ui = parseUiAction(t);
  if (ui) return { kind: "ui", action: ui };

  // ── Repeated takes ────────────────────────────────────────────────────────
  if (/\b(repeated|duplicate|repeat|second|double|redundant)\s+(answer|take|line|bit|part|sentence)s?\b|\bsaid (it|that) twice\b/.test(t)) {
    const takes = findRepeatedTakes(input.project.analysis?.transcript);
    if (!hasTranscript(input)) {
      if (!input.prepared?.includes("transcript")) return { kind: "needs", needs: ["transcript"] };
      return { kind: "question", question: "Nobody speaks in this video, so there's no repeated answer to remove." };
    }
    if (takes.length === 0) return { kind: "question", question: "I couldn't find an answer that's said twice. Can you tell me roughly when the repeat happens?" };
    const keepFirst = /\b(keep|use) the first\b/.test(t);
    if (takes.length > 1 && !/\ball\b/.test(t)) {
      return {
        kind: "question",
        question: `I found ${takes.length} repeated answers. Which one should I remove?`,
        options: takes.map((k, i) => `${i + 1}. ${clock(k.first.start)} "${snippet(k.first.text)}" (repeated at ${clock(k.second.start)})`),
      };
    }
    const cmds: EditCommand[] = takes.map((k) => {
      const drop = keepFirst ? k.second : k.first;
      const nextStart = keepFirst ? drop.end + 0.6 : k.second.start;
      const range = takeCutRange(input.project.analysis?.transcript, drop, nextStart);
      return { op: "remove_range", start: range.start, end: range.end, reason: keepFirst ? "repeated take (kept the first)" : "earlier take of a repeated answer" };
    });
    return {
      kind: "commands",
      commands: cmds,
      notes: [keepFirst ? "Kept the first take." : "Kept the later take — usually the one the speaker meant. Say “keep the first take” to swap."],
    };
  }

  // ── Lower third / title ───────────────────────────────────────────────────
  const addGraphic = /\b(add|insert|put|place|create|show)\b.*\b(lower[ -]?third|name ?(?:bar|tag|title)|title|caption card)\b/.exec(t);
  if (addGraphic) {
    const isLower = /lower[ -]?third|name ?(bar|tag)/.test(t);
    const presetId = isLower ? "callout-lower-third" : /\banimated\b/.test(t) ? "title-slide-in" : "title-cinematic-rise";
    let start: number | null = null;
    let label = quoted(text);
    const introWanted = /\bintroduc|\bsays (her|his|their) name|\bname is\b/.test(t);
    if (introWanted && !hasTranscript(input) && !input.prepared?.includes("transcript")) {
      return { kind: "needs", needs: ["transcript"] };
    }
    if (introWanted) {
      const intros = findIntroductions(input.project.analysis?.transcript);
      if (intros.length === 0) {
        return {
          kind: "question",
          question: input.project.analysis?.transcript?.status === "complete"
            ? "I couldn't find where the speaker introduces themselves in the transcript. What time should the lower third appear?"
            : "I need a transcript to find the introduction. Generate captions first, or tell me the time.",
        };
      }
      const intro = intros[0];
      start = intro.start;
      if (!label && intro.name) label = intro.role ? `${intro.name} · ${titleCase(intro.role)}` : intro.name;
    }
    const at = /\bat\s+(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:s|sec|seconds?))/.exec(t);
    if (at) start = parseTimestamp(at[1]);
    if (start == null) start = input.playhead;
    if (!label) label = isLower ? "Name · Role" : "Title";
    const position = POSITIONS.find(([re]) => re.test(t))?.[1];
    const dur = new RegExp(`\\bfor\\s+${AMOUNT}${SECONDS}`).exec(t);
    return {
      kind: "commands",
      commands: [{
        op: "add_graphic",
        presetId,
        text: label,
        start: Math.round(start * 1000) / 1000,
        ...(dur ? { duration: parseAmount(dur[1]) ?? undefined } : {}),
        ...(position ? { position } : {}),
      }],
      notes: label === "Name · Role" || label === "Title" ? ["I used placeholder text — tell me the name and role and I'll update it."] : [],
    };
  }

  // ── Transitions ───────────────────────────────────────────────────────────
  const tr = /\b(add|put|use|insert)\b.*?\b(?:(fade|zoom|swipe|flash|smooth|cross ?fade|dissolve)\s+)?(transitions?|fades)\b/.exec(t);
  if (tr) {
    const word = (tr[2] ?? "fade").replace(/\s+/g, "");
    const style: "fade" | "zoom" | "swipe" | "flash" | "smooth_cut" =
      word === "smooth" ? "smooth_cut" : word === "crossfade" || word === "dissolve" ? "fade" : (word as "fade" | "zoom" | "swipe" | "flash");
    if (/\bbetween\b.*\b(clips|shots|cuts)\b|\bat (every|each) (cut|join)\b/.test(t)) {
      const clips = clipsFor(input);
      if (clips.length < 2) return { kind: "question", question: "There's only one clip, so there's no join to put a transition on. Where should it go?" };
      return { kind: "commands", commands: clips.slice(1).map((c) => ({ op: "add_transition", at: c.sourceStart, style })), notes: [] };
    }
    const at = new RegExp(String.raw`\bat\s+${TIME}`).exec(t);
    const when = at ? parseTimestamp(at[1]) : null;
    return one({ op: "add_transition", at: when ?? input.playhead, style });
  }

  // ── Trim a clip ───────────────────────────────────────────────────────────
  const trim = new RegExp(
    String.raw`\b(trim|cut|chop|shave|remove|drop|lose|take off|delete)\b(?:\s+off)?\s+(?:the\s+)?(first|last|opening|final|initial)\s+${AMOUNT}${SECONDS}`
  ).exec(t) ??
    new RegExp(String.raw`\b(trim|cut|shave|take)\s+${AMOUNT}${SECONDS}\s+(?:off\s+|from\s+)(?:the\s+)?(start|beginning|end|front|back)`).exec(t);
  if (trim) {
    const firstForm = /first|last|opening|final|initial/.test(trim[2] ?? "");
    const amount = parseAmount(firstForm ? trim[3] : trim[2]);
    const where = firstForm ? trim[2] : trim[3];
    if (amount == null || !(amount > 0)) return { kind: "none" };
    const edge: "start" | "end" = /last|final|end|back/.test(where) ? "end" : "start";
    // An element reference ("trim the first second of the title") shortens the element.
    if (/\b(title|lower[ -]?third|graphic|zoom|caption)\b/.test(t)) {
      const el = resolveElementRef(t, input);
      if (!el) return { kind: "question", question: "Which element should I shorten? Select it on the timeline and ask again." };
      setLast(el.id);
      return one(edge === "start"
        ? { op: "update_element", elementId: el.id, start: el.startTime + amount }
        : { op: "update_element", elementId: el.id, end: el.endTime - amount });
    }
    const clip = resolveClipRef(/of the video/.test(t) ? `${edge === "start" ? "first" : "last"} clip` : t, input);
    if (!clip) return { kind: "question", question: "Which clip should I trim? Select it on the Clips row of the timeline." };
    return one({ op: "trim_clip", clipId: clip.id, edge, seconds: amount });
  }

  // ── Delete a clip ─────────────────────────────────────────────────────────
  if (/\b(delete|remove|cut|drop|lose)\s+(?:this|that|the selected|selected|the current|the)\s+(clip|shot)\b|\b(delete|remove|cut|drop)\s+(clip|shot)\s*#?\d+\b/.test(t) || /\b(delete|remove|cut|drop)\b.*\b(clip|shot) (before|after) this\b/.test(t)) {
    const clip = resolveClipRef(t, input);
    if (!clip) return { kind: "question", question: "Which clip should I remove? Select it on the Clips row of the timeline." };
    return one({ op: "delete_clip", clipId: clip.id });
  }

  // ── Remove / restore a time range ─────────────────────────────────────────
  const range = new RegExp(String.raw`\b(cut|remove|delete|drop|put back|restore|bring back|keep)\b.*?(?:from\s+)?${TIME}\s*(?:to|-|–|until|through)\s*${TIME}`).exec(t);
  if (range) {
    const a = parseTimestamp(range[2]);
    const b = parseTimestamp(range[3]);
    if (a == null || b == null || b <= a) return { kind: "none" };
    return one(/put back|restore|bring back|keep/.test(range[1]) ? { op: "restore_range", start: a, end: b } : { op: "remove_range", start: a, end: b });
  }

  // ── Speed ─────────────────────────────────────────────────────────────────
  const speed = /\bspeed\s*(?:it\s+|this\s+|the clip\s+|this clip\s+)?up\b.*?(\d+(?:\.\d+)?)\s*(?:x|×|times)/.exec(t) ?? /\b(\d+(?:\.\d+)?)\s*(?:x|×)\s+speed\b/.exec(t);
  if (speed) {
    const mult = Number(speed[1]);
    const clip = resolveClipRef(t, input);
    if (!clip) return { kind: "question", question: "Which part should I speed up? Select a clip or give me a time range." };
    return one({ op: "set_speed", start: clip.sourceStart, end: clip.sourceEnd, multiplier: mult });
  }

  // ── Element edits: shift / position / text / remove ───────────────────────
  const shift = new RegExp(String.raw`\b(delay|push back|push|move|shift|bring)\b(?:\s+(.+?))?\s+(?:by\s+)?${AMOUNT}${SECONDS}(?:\s+(later|earlier|sooner|back|forward))?`).exec(t);
  if (shift) {
    const amount = parseAmount(shift[3]);
    if (amount == null) return { kind: "none" };
    const el = resolveElementRef(shift[2] ?? "it", input);
    if (!el) return { kind: "question", question: "Which element should I move? Select it on the timeline (or name it, e.g. “the lower third”)." };
    const earlier = /earlier|sooner|forward/.test(shift[4] ?? "") || (/\bbring\b/.test(shift[1]) && !/later|back/.test(shift[4] ?? ""));
    setLast(el.id);
    return one({ op: "shift_element", elementId: el.id, seconds: earlier ? -amount : amount });
  }

  const pos = POSITIONS.find(([re]) => re.test(t));
  if (pos && /\b(move|put|place|position|shift|send|place)\b/.test(t)) {
    const el = resolveElementRef(t, input);
    if (!el) return { kind: "question", question: "Which element should I move? Select it on the timeline." };
    setLast(el.id);
    return one({ op: "update_element", elementId: el.id, position: pos[1] });
  }

  const newText = quoted(text);
  if (newText && /\b(change|set|make|rename|update|edit)\b.*\b(text|title|name|it|say|read|label)\b/.test(t)) {
    const el = resolveElementRef(t, input);
    if (!el) return { kind: "question", question: "Which text should I change? Select it on the timeline." };
    setLast(el.id);
    return one({ op: "update_element", elementId: el.id, text: newText });
  }

  if (
    /^(please\s+)?(remove|delete|get rid of|drop)\s+(it|that|this)$/.test(t) ||
    /^(please\s+)?(remove|delete|get rid of|drop)\s+(the|that|this)(\s+(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final))?\s+(title|lower[ -]?third|graphic|zoom|name tag|banner)$/.test(t)
  ) {
    const el = resolveElementRef(t, input);
    if (!el) return { kind: "question", question: "Which element should I remove? Select it on the timeline." };
    return one({ op: "remove_element", elementId: el.id });
  }

  return { kind: "none" };
}

/** Natural-language routes to the former right-toolbar tools. */
export function parseUiAction(t: string): UiAction | null {
  const aspect = /\b(make it|change (it|the (video|format|canvas|aspect( ratio)?))( back)? to|(switch|go)( back)? to|convert( it)?( back)? to|turn it( back)? into|resize( it)? (to|for)|restore)\b.*?\b(vertical|portrait|9:16|tiktok|reels?|shorts|square|1:1|landscape|horizontal|16:9|widescreen|4:5|instagram feed|original(?: size)?|source)\b/.exec(t);
  if (aspect) {
    const w = aspect[aspect.length - 1];
    const a = /vertical|portrait|9:16|tiktok|reel|shorts/.test(w)
      ? "9:16"
      : /square|1:1/.test(w)
        ? "1:1"
        : /4:5|instagram feed/.test(w)
          ? "4:5"
          : /original|source/.test(w)
            ? "source"
            : "16:9";
    return { kind: "aspect", aspect: a };
  }
  if (/\b(crop)( the)?( frame| video| screen| edges| sides)?\b|\bcut off the (top|bottom|sides|edges)\b/.test(t)) return { kind: "crop" };
  if (/\b(canvas|background colou?r|letterbox|blurred background|aspect ratio|sharing bar)\b/.test(t)) return { kind: "canvas" };
  if (/\b(caption (settings|language|style)|subtitle (settings|language)|transcri(be|ption) (again|language)|retranscribe|change the language)\b/.test(t)) return { kind: "captions-panel" };
  // Only a direct "apply/open a look" — never "save this look as …" (an effect library action).
  if (!/\bsave\b/.test(t) && /^(please\s+)?(apply|use|show|open|browse|try|add|pick)\b[^.]*\b(looks?|colou?r grade|filters?)\b/.test(t)) return { kind: "presets", tab: "looks" };
  if (/\b(presets?|templates?|preset library)\b/.test(t)) return { kind: "presets" };
  if (/\b(short clips|smart clips|shorts from|highlights? clips|make (some )?clips|clip ideas)\b/.test(t)) return { kind: "clips" };
  if (/\b(suggestions?|insights?|what should i (improve|change|fix)|any ideas|recommendations?)\b/.test(t)) return { kind: "insights" };
  if (/\b(edit (the whole|my|the) video for me|auto[- ]?edit|full (ai )?edit|re-?edit (the )?(whole )?video|edit it in a style|pick a style)\b/.test(t)) return { kind: "full-edit" };
  return null;
}

function quoted(s: string): string | null {
  const m = /["“]([^"“”]{1,120})["”]/.exec(s) ?? /\b(?:saying|that says|reading|to say|to read)\s+(.{1,80})$/i.exec(s);
  return m ? m[1].trim() : null;
}

/** Broadcast-style title case: "head of design at lumen" → "Head of Design at Lumen". */
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function snippet(s: string): string {
  return s.length > 48 ? `${s.slice(0, 46)}…` : s;
}

function clock(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${Math.floor(t - m * 60).toString().padStart(2, "0")}`;
}

/** The zoom under the playhead, else the only zoom, else null (never a guess among several). */
function zoomUnderPlayheadOrOnly(input: AssistantInput): DetectedMomentLike | null {
  const zooms = input.moments.filter((m) => (m.effectType === "zoom" || m.effectType === "cursor-focus") && m.enabled !== false);
  const here = zooms.filter((m) => input.playhead >= m.startTime && input.playhead < m.endTime);
  if (here.length === 1) return here[0];
  if (zooms.length === 1) return zooms[0];
  return null;
}
type DetectedMomentLike = AssistantInput["moments"][number];

/** Clips for the UI and tests, from the live (layer-filtered) timeline. */
export function clipsFor(input: Pick<AssistantInput, "moments" | "layers" | "sourceDuration">) {
  return deriveClips(visibleMoments(input.moments, input.layers), input.sourceDuration);
}
