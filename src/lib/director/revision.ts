/**
 * AI Director — revision engine.
 *
 * A revision PATCHES THE PLAN and re-executes it. It never re-analyzes the video
 * (no CV pass, no Gemini video upload, no re-transcription) — the expensive
 * understanding work is already done and stored in the context. "Make it 30
 * seconds" is a change to one field of the plan followed by a deterministic
 * re-execution, and it should feel that fast.
 *
 * The plan stays the single source of truth: a revision produces a NEW plan,
 * which is validated, executed and reviewed by exactly the same code path as the
 * first run. There is no separate "revision executor" that could drift.
 *
 * Commands are parsed deterministically first (the common ones are unambiguous
 * and shouldn't cost a model round-trip). `parseRevisionCommand` reports what it
 * couldn't understand so the caller can escalate to the model — or tell the user
 * plainly, rather than silently doing nothing.
 *
 * Pure. No I/O.
 */
import type { DirectorVideoContext } from "./context-builder";
import { captionTextStyleFor, MIN_KEEP_SECONDS } from "./planner";
import { parseAspect, parseTargetDuration } from "./request";
import {
  DIRECTOR_SECTION_ORDER,
  type DirectorAspect,
  type DirectorEditOperation,
  type DirectorPlan,
  type DirectorSectionKind,
  type DirectorStyle,
} from "./types";

/** The structured meaning of a follow-up command. */
export type DirectorRevisionIntent =
  | { kind: "set-target-duration"; seconds: number }
  | { kind: "set-aspect"; aspect: DirectorAspect }
  | { kind: "set-caption-style"; style: DirectorStyle }
  | { kind: "toggle-captions"; enabled: boolean }
  | { kind: "adjust-edit-count"; editType: "zoom" | "callout" | "transition" | "text-overlay"; direction: "fewer" | "more" }
  | { kind: "remove-clip"; index: number }
  | { kind: "remove-section"; section: DirectorSectionKind }
  | { kind: "keep-more"; query: string }
  | { kind: "strengthen-cta"; text?: string }
  | { kind: "remove-cta" }
  | { kind: "pace-section"; section: DirectorSectionKind | "beginning" | "ending"; direction: "faster" | "slower" };

export interface ParsedRevision {
  intents: DirectorRevisionIntent[];
  /** True when nothing in the command was understood. */
  unrecognized: boolean;
}

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5,
};

function sectionFromText(s: string): DirectorSectionKind | undefined {
  if (/\bhook\b/.test(s)) return "hook";
  if (/\b(context|intro|setup|introduction)\b/.test(s)) return "context";
  if (/\b(demo|demonstration|main|middle|body)\b/.test(s)) return "demo";
  if (/\b(result|payoff|outcome)\b/.test(s)) return "result";
  if (/\b(cta|call[- ]to[- ]action|end\s?card|ending|outro)\b/.test(s)) return "cta";
  return undefined;
}

/**
 * Parse a natural-language revision command into structured intents.
 *
 * Deliberately deterministic and conservative: it recognises the commands people
 * actually send, and it says so when it doesn't understand rather than guessing.
 * A wrong guess here silently rewrites the user's video.
 */
export function parseRevisionCommand(command: string): ParsedRevision {
  const s = (command ?? "").trim().toLowerCase();
  const intents: DirectorRevisionIntent[] = [];
  if (!s) return { intents, unrecognized: true };

  // "Make it 30 seconds" / "cut it to a minute"
  const dur = parseTargetDuration(s);
  if (dur !== undefined && /\b(make|cut|trim|keep|get|bring|shorten|under|to)\b/.test(s)) {
    intents.push({ kind: "set-target-duration", seconds: dur });
  }

  // "Change it to vertical" / "make it 9:16"
  const aspect = parseAspect(s);
  if (aspect && /\b(change|make|switch|convert|turn|to)\b/.test(s)) {
    intents.push({ kind: "set-aspect", aspect });
  }

  // "Make the captions more professional"
  if (/\bcaptions?\b/.test(s)) {
    if (/\b(no|remove|delete|drop|without|turn\s+off)\b/.test(s)) {
      intents.push({ kind: "toggle-captions", enabled: false });
    } else if (/\b(add|turn\s+on|enable)\b/.test(s)) {
      intents.push({ kind: "toggle-captions", enabled: true });
    }
    const style: DirectorStyle | undefined =
      /\b(professional|corporate|business|formal)\b/.test(s)
        ? "professional"
        : /\b(energetic|bold|punchy|hype|exciting)\b/.test(s)
          ? "energetic"
          : /\b(minimal|subtle|understated|simple)\b/.test(s)
            ? "minimal"
            : /\b(cinematic|dramatic)\b/.test(s)
              ? "cinematic"
              : /\b(calm|relaxed|gentle)\b/.test(s)
                ? "calm"
                : undefined;
    if (style) intents.push({ kind: "set-caption-style", style });
  }

  // "Reduce the number of zooms" / "add more callouts"
  const fewer = /\b(fewer|less|reduce|reducing|cut\s+down|too\s+many|tone\s+down|remove\s+some)\b/.test(s);
  const more = /\b(more|add\s+more|increase|too\s+few)\b/.test(s);
  for (const [re, editType] of [
    [/\bzooms?\b/, "zoom"],
    [/\bcallouts?\b/, "callout"],
    [/\btransitions?\b/, "transition"],
    [/\b(text\s+overlays?|labels?)\b/, "text-overlay"],
  ] as const) {
    if (!re.test(s)) continue;
    if (fewer) intents.push({ kind: "adjust-edit-count", editType, direction: "fewer" });
    else if (more) intents.push({ kind: "adjust-edit-count", editType, direction: "more" });
  }

  // "Remove the third clip"
  const clipMatch = s.match(
    /\b(?:remove|delete|drop|cut)\b[^.]*?\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|\d{1,2})\b[^.]*?\bclips?\b/
  );
  if (clipMatch) {
    const token = clipMatch[1];
    const index = ORDINALS[token] ?? Number(token);
    if (Number.isFinite(index) && index >= 1) {
      intents.push({ kind: "remove-clip", index });
    }
  }

  // "Remove the context section"
  const removeSection = s.match(/\b(?:remove|delete|drop|cut|skip)\b[^.]*?\bsection\b/);
  if (removeSection) {
    const sec = sectionFromText(s);
    if (sec) intents.push({ kind: "remove-section", section: sec });
  }

  // "Keep more of the pricing section"
  const keepMore = s.match(
    /\b(?:keep|show|include|leave)\b\s+(?:a\s+bit\s+)?more\s+(?:of\s+)?(?:the\s+)?([\w\s'-]{2,40}?)(?:\s+(?:section|part|bit))?\s*$/
  );
  if (keepMore) {
    const query = keepMore[1].trim();
    if (query && !/^(video|it|this|that)$/.test(query)) {
      intents.push({ kind: "keep-more", query });
    }
  }

  // "Add a stronger CTA" / "remove the CTA"
  if (/\b(cta|call[- ]to[- ]action|end\s?card)\b/.test(s)) {
    if (/\b(no|remove|delete|drop|without)\b/.test(s)) {
      intents.push({ kind: "remove-cta" });
    } else if (/\b(add|stronger|better|punchier|improve|change)\b/.test(s)) {
      // Quoted text becomes the CTA copy verbatim: `add a CTA saying "Book a demo"`.
      const quoted = command.match(/["“']([^"”']{2,60})["”']/);
      intents.push({
        kind: "strengthen-cta",
        ...(quoted ? { text: quoted[1].trim() } : {}),
      });
    }
  }

  // "Make the beginning faster"
  const paceFaster = /\b(faster|quicker|snappier|speed\s+up|tighten|punchier)\b/.test(s);
  const paceSlower = /\b(slower|calmer|slow\s+down|breathe|relax)\b/.test(s);
  if (paceFaster || paceSlower) {
    const direction = paceFaster ? "faster" : "slower";
    const target: DirectorRevisionIntent | null = /\b(beginning|start|opening|intro)\b/.test(s)
      ? { kind: "pace-section", section: "beginning", direction }
      : /\b(end|ending|outro|finish)\b/.test(s)
        ? { kind: "pace-section", section: "ending", direction }
        : (() => {
            const sec = sectionFromText(s);
            return sec ? { kind: "pace-section" as const, section: sec, direction } : null;
          })();
    if (target) intents.push(target);
    else if (!intents.length) {
      // "make it faster" with no target = shorten the whole thing.
      intents.push({ kind: "pace-section", section: "demo", direction });
    }
  }

  return { intents, unrecognized: intents.length === 0 };
}

// ════════════════════════════════════════════════════════════════════════════
// Applying intents to a plan
// ════════════════════════════════════════════════════════════════════════════

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

let revSeq = 0;
function revOpId(kind: string): string {
  revSeq += 1;
  return `rev${revSeq}-${kind}`;
}

export interface ApplyRevisionResult {
  plan: DirectorPlan;
  /** Plain-English record of what each intent actually changed. */
  changes: string[];
  /** Intents that matched nothing on the plan (e.g. "remove the 9th clip"). */
  noops: string[];
}

/**
 * Apply intents to a plan, producing a NEW plan.
 *
 * Every mutation is expressed as a change to the plan's operations, so the
 * result goes back through `validateDirectorPlan` → `executePlan` →
 * `reviewDirectorResult` like any other plan. A revision cannot produce a
 * timeline the first run couldn't have produced.
 */
export function applyRevision(
  plan: DirectorPlan,
  intents: DirectorRevisionIntent[],
  ctx: DirectorVideoContext,
  revisionIndex: number
): ApplyRevisionResult {
  revSeq = 0;
  const changes: string[] = [];
  const noops: string[] = [];

  let next: DirectorPlan = {
    ...plan,
    storyStructure: plan.storyStructure.map((s) => ({ ...s })),
    clipOperations: plan.clipOperations.map((o) => ({ ...o })),
    editOperations: plan.editOperations.map((o) => ({ ...o, params: { ...o.params } })),
    audioOperations: plan.audioOperations.map((o) => ({ ...o })),
    captionInstructions: { ...plan.captionInstructions },
    createdAt: plan.createdAt,
  };

  const dur = ctx.durationSeconds;
  /** Windows currently kept, in source order — "the clips" the user sees. */
  const keptOps = () =>
    next.clipOperations
      .filter((o) => o.kind === "keep")
      .sort((a, b) => a.startTime - b.startTime);

  for (const intent of intents) {
    switch (intent.kind) {
      // ── Duration ───────────────────────────────────────────────────────
      case "set-target-duration": {
        next.targetDurationSeconds = intent.seconds;
        const kept = keptOps();
        const total = kept.reduce((a, o) => a + (o.endTime - o.startTime), 0);

        if (total > intent.seconds) {
          // Trim from the LOWEST-priority kept windows first, so the hook and
          // the result survive and only the connective tissue shrinks.
          let excess = total - intent.seconds;
          const order = kept
            .slice()
            .sort((a, b) => a.priority - b.priority);
          const dropIds = new Set<string>();
          for (const op of order) {
            if (excess <= 0) break;
            const len = op.endTime - op.startTime;
            if (len <= excess) {
              dropIds.add(op.id);
              excess -= len;
            } else {
              const keepLen = len - excess;
              if (keepLen >= MIN_KEEP_SECONDS) {
                op.endTime = round(op.startTime + keepLen);
                excess = 0;
              } else {
                dropIds.add(op.id);
                excess -= len;
              }
            }
          }
          next.clipOperations = next.clipOperations.filter((o) => !dropIds.has(o.id));
          changes.push(`Tightened the edit to about ${intent.seconds}s.`);
        } else if (total < intent.seconds * 0.85) {
          // Give time BACK: grow the highest-priority windows toward the source.
          let deficit = intent.seconds - total;
          const grow = keptOps().sort((a, b) => b.priority - a.priority);
          for (const op of grow) {
            if (deficit <= 0) break;
            const room = Math.min(deficit, dur - op.endTime);
            const blocked = next.clipOperations.some(
              (o) =>
                o.kind === "keep" &&
                o.id !== op.id &&
                overlaps(op.startTime, op.endTime + room, o.startTime, o.endTime)
            );
            if (room > 0.2 && !blocked) {
              op.endTime = round(Math.min(dur, op.endTime + room));
              deficit -= room;
            }
          }
          changes.push(`Loosened the edit toward ${intent.seconds}s.`);
        } else {
          changes.push(`Target set to ${intent.seconds}s (already close).`);
        }
        // The removals are always the complement of what's kept — recomputing
        // them here is what keeps "kept" and "removed" from ever contradicting.
        next = rebuildRemovals(next, ctx);
        break;
      }

      // ── Aspect ─────────────────────────────────────────────────────────
      case "set-aspect": {
        next.aspectRatio = intent.aspect;
        const crop = next.editOperations.find((o) => o.editType === "smart-crop");
        const smartAspect = intent.aspect === "4:5" ? "1:1" : intent.aspect;
        if (crop) {
          crop.params = { ...crop.params, aspectRatio: smartAspect as never };
          crop.reason = `Reframes to ${intent.aspect}.`;
        } else {
          next.editOperations.push({
            id: revOpId("smartcrop"),
            editType: "smart-crop",
            startTime: 0,
            endTime: round(dur),
            reason: `Reframes to ${intent.aspect}.`,
            confidence: 0.9,
            priority: 0.9,
            evidence: [{ kind: "user-request", detail: `revision: ${intent.aspect}` }],
            params: {
              aspectRatio: smartAspect as never,
              focusTarget: ctx.hasInteractionData ? "screen_action" : "motion",
            },
          });
        }
        // A vertical feed hides bottom-anchored captions behind platform UI.
        if (intent.aspect === "9:16" || intent.aspect === "4:5") {
          next.captionInstructions.position = "center";
        }
        changes.push(`Switched the canvas to ${intent.aspect}.`);
        break;
      }

      // ── Captions ───────────────────────────────────────────────────────
      case "toggle-captions": {
        if (intent.enabled && !ctx.hasTranscript) {
          noops.push(
            "Captions need a transcript, and this project doesn't have one yet. Generate one from the Captions panel, then ask again."
          );
          break;
        }
        next.captionInstructions.enabled = intent.enabled;
        changes.push(intent.enabled ? "Turned captions on." : "Turned captions off.");
        break;
      }

      case "set-caption-style": {
        next.captionInstructions.textStyle = captionTextStyleFor(intent.style);
        next.captionInstructions.stylePreset =
          intent.style === "energetic"
            ? "bold_social"
            : intent.style === "minimal"
              ? "minimal"
              : "clean";
        // DROP the pinned caption design. A pinned preset beats the scorer and
        // bakes its OWN typography over the plan's — so leaving the old id here
        // would keep the previous look (say, an energetic Bold Pop) while the
        // summary claimed the captions were now minimal. Clearing it lets the
        // scorer re-pick for the tone the user just asked for.
        delete next.captionInstructions.presetId;
        next.captionInstructions.reason = `${intent.style} captions (revision).`;
        next.tone = intent.style;
        changes.push(`Restyled the captions to feel more ${intent.style}.`);
        break;
      }

      // ── Edit counts ────────────────────────────────────────────────────
      case "adjust-edit-count": {
        const ofType = next.editOperations
          .filter((o) => o.editType === intent.editType)
          .sort((a, b) => a.confidence - b.confidence);

        if (intent.direction === "fewer") {
          if (!ofType.length) {
            noops.push(`There are no ${intent.editType}s to reduce.`);
            break;
          }
          // Drop the weakest half (at least one) — keeps the strongest emphasis.
          const drop = Math.max(1, Math.floor(ofType.length / 2));
          const dropIds = new Set(ofType.slice(0, drop).map((o) => o.id));
          next.editOperations = next.editOperations.filter((o) => !dropIds.has(o.id));
          changes.push(
            `Removed ${drop} ${intent.editType}${drop === 1 ? "" : "s"} — kept the strongest ${ofType.length - drop}.`
          );
        } else {
          const added = addMoreEdits(next, ctx, intent.editType);
          if (added === 0) {
            noops.push(
              `No further ${intent.editType} candidates were grounded in the video — adding more would mean inventing them.`
            );
          } else {
            changes.push(`Added ${added} more ${intent.editType}${added === 1 ? "" : "s"}.`);
          }
        }
        break;
      }

      // ── Clips ──────────────────────────────────────────────────────────
      case "remove-clip": {
        const kept = keptOps();
        const target = kept[intent.index - 1];
        if (!target) {
          noops.push(
            `There is no clip #${intent.index} — the edit has ${kept.length} clip${kept.length === 1 ? "" : "s"}.`
          );
          break;
        }
        next.clipOperations = next.clipOperations.filter((o) => o.id !== target.id);
        // Any edit that lived only inside that clip goes with it.
        next.editOperations = next.editOperations.filter(
          (o) =>
            o.editType === "smart-crop" ||
            !(o.startTime >= target.startTime && o.endTime <= target.endTime)
        );
        next = rebuildRemovals(next, ctx);
        changes.push(
          `Removed clip #${intent.index} (${target.startTime.toFixed(1)}s–${target.endTime.toFixed(1)}s).`
        );
        break;
      }

      case "remove-section": {
        const sec = next.storyStructure.find((s) => s.kind === intent.section);
        if (!sec) {
          noops.push(`There's no ${intent.section} section in the current edit.`);
          break;
        }
        next.storyStructure = next.storyStructure.filter((s) => s.id !== sec.id);
        next.clipOperations = next.clipOperations.filter((o) => o.sectionId !== sec.id);
        next.editOperations = next.editOperations.filter(
          (o) => o.editType === "smart-crop" || o.sectionId !== sec.id
        );
        next = rebuildRemovals(next, ctx);
        changes.push(`Dropped the ${intent.section} section.`);
        break;
      }

      // ── Keep more of X ─────────────────────────────────────────────────
      case "keep-more": {
        // Find where the user's words are actually SPOKEN. This is what makes
        // "keep more of the pricing section" a real instruction instead of a
        // vibe — we look it up in the transcript and expand around the hits.
        const hits = findTopicWindows(ctx, intent.query);
        if (!hits.length) {
          noops.push(
            `Couldn't find "${intent.query}" in the transcript, so there was nothing to keep more of.`
          );
          break;
        }
        const PAD = 2;
        for (const h of hits) {
          const start = round(Math.max(0, h.start - PAD));
          const end = round(Math.min(dur, h.end + PAD));
          // Un-remove it: delete any removal covering this topic…
          next.clipOperations = next.clipOperations.filter(
            (o) => !(o.kind === "remove" && overlaps(o.startTime, o.endTime, start, end))
          );
          // …and any silence cut sitting inside it.
          next.audioOperations = next.audioOperations.filter(
            (o) => !overlaps(o.startTime, o.endTime, start, end)
          );
          // …then keep it explicitly, at high priority so a later duration
          // squeeze doesn't immediately throw it away again.
          const existing = next.clipOperations.find(
            (o) => o.kind === "keep" && overlaps(o.startTime, o.endTime, start, end)
          );
          if (existing) {
            existing.startTime = round(Math.min(existing.startTime, start));
            existing.endTime = round(Math.max(existing.endTime, end));
            existing.priority = 0.95;
            existing.reason = `Expanded — you asked to keep more of "${intent.query}".`;
          } else {
            next.clipOperations.push({
              id: revOpId("keep"),
              kind: "keep",
              startTime: start,
              endTime: end,
              reason: `You asked to keep more of "${intent.query}".`,
              confidence: 0.85,
              priority: 0.95,
              evidence: h.evidence,
            });
          }
        }
        next = rebuildRemovals(next, ctx);
        changes.push(
          `Kept ${hits.length} more stretch${hits.length === 1 ? "" : "es"} covering "${intent.query}".`
        );
        break;
      }

      // ── CTA ────────────────────────────────────────────────────────────
      case "strengthen-cta": {
        const existing = next.editOperations.find((o) => o.editType === "branding-cta");
        const text = intent.text ?? "Get started today";
        if (existing) {
          existing.params = { ...existing.params, ctaText: text };
          existing.reason = "Stronger closing call to action (revision).";
          existing.priority = 1;
          // Give it room to land.
          existing.startTime = round(Math.max(0, Math.min(existing.startTime, dur - 4)));
          existing.endTime = round(dur);
          changes.push(`Strengthened the CTA to "${text}".`);
        } else {
          const start = round(Math.max(0, dur - 4));
          const ctaSection = next.storyStructure.find((s) => s.kind === "cta");
          if (!ctaSection) {
            next.storyStructure.push({
              id: "sec-cta",
              kind: "cta",
              title: "Call to action",
              startTime: start,
              endTime: round(dur),
              reason: "Added on request.",
              confidence: 0.9,
              evidence: [{ kind: "user-request", detail: "revision: add a CTA" }],
            });
            next.storyStructure.sort(
              (a, b) => DIRECTOR_SECTION_ORDER[a.kind] - DIRECTOR_SECTION_ORDER[b.kind]
            );
            // The CTA needs kept time to sit on, or it'd land inside a cut.
            next.clipOperations.push({
              id: revOpId("keep"),
              kind: "keep",
              sectionId: "sec-cta",
              startTime: start,
              endTime: round(dur),
              reason: "Holds the closing CTA.",
              confidence: 0.9,
              priority: 1,
              evidence: [{ kind: "user-request", detail: "revision: add a CTA" }],
            });
            next = rebuildRemovals(next, ctx);
          }
          next.editOperations.push({
            id: revOpId("cta"),
            editType: "branding-cta",
            sectionId: "sec-cta",
            startTime: start,
            endTime: round(dur),
            reason: "Closing call to action (revision).",
            confidence: 0.9,
            priority: 1,
            evidence: [{ kind: "user-request", detail: "revision: add a CTA" }],
            params: { ctaText: text },
          });
          changes.push(`Added a closing CTA — "${text}".`);
        }
        break;
      }

      case "remove-cta": {
        const before = next.editOperations.length;
        next.editOperations = next.editOperations.filter(
          (o) => o.editType !== "branding-cta"
        );
        if (next.editOperations.length === before) {
          noops.push("There was no CTA to remove.");
        } else {
          changes.push("Removed the CTA.");
        }
        break;
      }

      // ── Pacing ─────────────────────────────────────────────────────────
      case "pace-section": {
        const window = resolvePaceWindow(next, intent.section, dur);
        if (!window) {
          noops.push(`Couldn't find the ${intent.section} to re-pace.`);
          break;
        }

        if (intent.direction === "faster") {
          // Two real levers, in order of least damage:
          //   1. Tighten kept windows in this range (remove slack).
          //   2. Add a speed-up over what's left.
          const kept = next.clipOperations.filter(
            (o) => o.kind === "keep" && overlaps(o.startTime, o.endTime, window.start, window.end)
          );
          let tightened = 0;
          for (const op of kept) {
            const len = op.endTime - op.startTime;
            const target = Math.max(MIN_KEEP_SECONDS, len * 0.7);
            if (target < len - 0.2) {
              op.endTime = round(op.startTime + target);
              tightened += 1;
            }
          }

          const hasSpeed = next.editOperations.some(
            (o) =>
              o.editType === "speed-up" &&
              overlaps(o.startTime, o.endTime, window.start, window.end)
          );
          if (!hasSpeed && window.end - window.start > 1.5) {
            next.editOperations.push({
              id: revOpId("speed"),
              editType: "speed-up",
              startTime: round(window.start),
              endTime: round(window.end),
              reason: `You asked for a faster ${intent.section}.`,
              confidence: 0.75,
              priority: 0.6,
              evidence: [
                { kind: "user-request", detail: `revision: faster ${intent.section}` },
              ],
              params: { speedMultiplier: 1.6 },
            });
          }
          next = rebuildRemovals(next, ctx);
          changes.push(
            `Sped up the ${intent.section}${tightened ? ` and tightened ${tightened} clip${tightened === 1 ? "" : "s"}` : ""}.`
          );
        } else {
          // Slower: drop any speed-ups here and give the windows their time back.
          const before = next.editOperations.length;
          next.editOperations = next.editOperations.filter(
            (o) =>
              !(
                o.editType === "speed-up" &&
                overlaps(o.startTime, o.endTime, window.start, window.end)
              )
          );
          const removed = before - next.editOperations.length;
          next.audioOperations = next.audioOperations.filter(
            (o) => !overlaps(o.startTime, o.endTime, window.start, window.end)
          );
          next = rebuildRemovals(next, ctx);
          changes.push(
            `Let the ${intent.section} breathe${removed ? ` — removed ${removed} speed-up${removed === 1 ? "" : "s"}` : ""}.`
          );
        }
        break;
      }
    }
  }

  // Re-stamp identity: a revision is a new plan, and it says which one it is.
  next.planVersion = plan.planVersion;
  next.modelVersion = `${plan.modelVersion}+rev${revisionIndex}`;

  return { plan: next, changes, noops };
}

/**
 * Recompute `remove` ops as the exact complement of the `keep` ops.
 *
 * Called after ANY change to what's kept. It's the invariant that makes the plan
 * internally consistent: kept + removed always tile [0, duration] exactly, so
 * the executor can never emit a cut over a window the user asked to keep.
 */
function rebuildRemovals(plan: DirectorPlan, ctx: DirectorVideoContext): DirectorPlan {
  const dur = ctx.durationSeconds;
  const keeps = plan.clipOperations
    .filter((o) => o.kind === "keep")
    .map((o) => ({ start: o.startTime, end: o.endTime }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  // Merge kept windows.
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of keeps) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.2) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  // Complement.
  const removals: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor + 0.25) removals.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < dur - 0.25) removals.push({ start: cursor, end: dur });

  const kept = plan.clipOperations.filter((o) => o.kind !== "remove");
  const rebuilt = removals.map((r, i) => {
    const zone = ctx.deadZones.find((d) => overlaps(d.startTime, d.endTime, r.start, r.end));
    return {
      id: `auto-remove-${i}`,
      kind: "remove" as const,
      startTime: round(r.start),
      endTime: round(r.end),
      reason: zone ? zone.reason : "Removed — outside the kept story.",
      confidence: zone ? 0.85 : 0.65,
      priority: 0.8,
      evidence: zone
        ? zone.evidence.slice(0, 2)
        : [{ kind: "heuristic" as const, detail: "outside the kept sections", at: r.start }],
    };
  });

  return { ...plan, clipOperations: [...kept, ...rebuilt] };
}

/** The source window a pacing command refers to. */
function resolvePaceWindow(
  plan: DirectorPlan,
  section: DirectorSectionKind | "beginning" | "ending",
  duration: number
): { start: number; end: number } | null {
  if (section === "beginning") {
    const hook = plan.storyStructure.find((s) => s.kind === "hook");
    const ctxSec = plan.storyStructure.find((s) => s.kind === "context");
    const start = hook?.startTime ?? 0;
    const end = ctxSec?.endTime ?? hook?.endTime ?? Math.min(duration, duration * 0.3);
    return end > start ? { start, end } : null;
  }
  if (section === "ending") {
    const result = plan.storyStructure.find((s) => s.kind === "result");
    const cta = plan.storyStructure.find((s) => s.kind === "cta");
    const start = result?.startTime ?? Math.max(0, duration * 0.7);
    const end = cta?.endTime ?? duration;
    return end > start ? { start, end } : null;
  }
  const sec = plan.storyStructure.find((s) => s.kind === section);
  return sec ? { start: sec.startTime, end: sec.endTime } : null;
}

/** Transcript windows where the user's topic is actually spoken. */
function findTopicWindows(
  ctx: DirectorVideoContext,
  query: string
): Array<{ start: number; end: number; evidence: DirectorEditOperation["evidence"] }> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (!words.length) return [];

  const out: Array<{ start: number; end: number; evidence: DirectorEditOperation["evidence"] }> = [];

  for (const seg of ctx.transcript?.segments ?? []) {
    const text = seg.text.toLowerCase();
    if (!words.some((w) => text.includes(w))) continue;
    out.push({
      start: seg.startTime,
      end: seg.endTime,
      evidence: [
        {
          kind: "transcript",
          ref: seg.id,
          detail: `"${seg.text.slice(0, 80)}"`,
          at: seg.startTime,
        },
      ],
    });
  }

  // Also match narrative beat labels ("Pricing", "Checkout") — a screen recording
  // with no speech can still have a labelled beat the user is referring to.
  for (const [i, seg] of ctx.narrative.entries()) {
    const label = seg.label.toLowerCase();
    if (!words.some((w) => label.includes(w))) continue;
    if (out.some((o) => overlaps(o.start, o.end, seg.startTime, seg.endTime))) continue;
    out.push({
      start: seg.startTime,
      end: seg.endTime,
      evidence: [
        {
          kind: "narrative",
          detail: `beat "${seg.label}"`,
          at: seg.startTime,
        },
      ],
    });
    void i;
  }

  // Merge adjacent hits so "pricing" mentioned three times in a row becomes one
  // continuous stretch rather than three fragments with gaps between them.
  out.sort((a, b) => a.start - b.start);
  const merged: typeof out = [];
  for (const h of out) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end + 2.5) {
      last.end = Math.max(last.end, h.end);
      last.evidence = [...last.evidence, ...h.evidence].slice(0, 3);
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

/**
 * Add more edits of a type — but ONLY on windows that are genuinely grounded in
 * the video. If the evidence runs out, we add nothing and say so, rather than
 * scattering decorative zooms over stretches where nothing happens.
 */
function addMoreEdits(
  plan: DirectorPlan,
  ctx: DirectorVideoContext,
  editType: "zoom" | "callout" | "transition" | "text-overlay"
): number {
  const kept = plan.clipOperations.filter((o) => o.kind === "keep");
  const inKept = (s: number, e: number) =>
    kept.some((k) => overlaps(k.startTime, k.endTime, s, e));
  const taken = (s: number, e: number) =>
    plan.editOperations.some(
      (o) => o.editType === editType && overlaps(o.startTime, o.endTime, s, e)
    );

  let added = 0;
  const LIMIT = 3;

  if (editType === "zoom" || editType === "callout") {
    const pool = ctx.moments
      .filter(
        (m) =>
          (m.effectType === "zoom" ||
            m.effectType === "click-highlight" ||
            m.effectType === "cursor-focus") &&
          inKept(m.startTime, m.endTime) &&
          !taken(m.startTime, m.endTime)
      )
      .sort((a, b) => (b.attentionScore ?? 0) - (a.attentionScore ?? 0));

    for (const m of pool) {
      if (added >= LIMIT) break;
      if (editType === "callout" && m.targetRegionSource !== "click-event") continue;
      plan.editOperations.push({
        id: revOpId(editType),
        editType,
        startTime: round(m.startTime),
        endTime: round(editType === "callout" ? Math.min(m.endTime, m.startTime + 2.5) : m.endTime),
        reason: `Added on request — grounded in ${m.label || "a detected moment"}.`,
        confidence: clamp01(m.confidenceScore ?? m.attentionScore ?? 0.5),
        priority: 0.5,
        evidence: [
          { kind: "moment", ref: m.id, detail: m.reason || m.label, at: m.startTime },
        ],
        focusRegion: m.focusRegion,
        ...(editType === "zoom" ? { intensity: clamp01(m.recommendedIntensity ?? 0.7) } : {}),
        ...(editType === "callout"
          ? { params: { text: m.label && m.label.length > 4 ? m.label : "Here", calloutStyle: "box" as const } }
          : {}),
      });
      added += 1;
    }
    return added;
  }

  if (editType === "transition") {
    for (const k of kept) {
      if (added >= LIMIT) break;
      if (k.startTime <= 0.3 || taken(k.startTime, k.startTime + 0.4)) continue;
      plan.editOperations.push({
        id: revOpId("transition"),
        editType: "transition",
        startTime: round(k.startTime),
        endTime: round(k.startTime + 0.4),
        reason: "Added on request — softens this cut.",
        confidence: 0.7,
        priority: 0.4,
        evidence: [{ kind: "heuristic", detail: "cut boundary", at: k.startTime }],
        params: { transitionStyle: "fade" },
      });
      added += 1;
    }
    return added;
  }

  // text-overlay: reuse REAL moment labels. A label we invent is a caption we
  // made up, which is exactly what this system refuses to do.
  const labelled = ctx.moments
    .filter(
      (m) =>
        m.label &&
        m.label.length > 4 &&
        inKept(m.startTime, m.endTime) &&
        !taken(m.startTime, m.endTime)
    )
    .sort((a, b) => (b.attentionScore ?? 0) - (a.attentionScore ?? 0));

  for (const m of labelled) {
    if (added >= LIMIT) break;
    plan.editOperations.push({
      id: revOpId("text"),
      editType: "text-overlay",
      startTime: round(m.startTime),
      endTime: round(Math.min(m.endTime, m.startTime + 3)),
      reason: "Added on request — labels this step.",
      confidence: 0.6,
      priority: 0.45,
      evidence: [{ kind: "moment", ref: m.id, detail: m.label, at: m.startTime }],
      params: { text: m.label },
    });
    added += 1;
  }
  return added;
}
