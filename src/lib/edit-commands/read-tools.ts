/**
 * Answers for the READ tools (tools.ts) — pure, except `inspect_footage`,
 * whose video access is injected by the server route. Shared by every model
 * adapter, so Gemini and a future Claude integration see identical answers.
 */

import type { ProjectDoc } from "@/lib/firebase/schema";
import { PRESETS } from "@/lib/presets/registry";
import { findFootage, findIntroductions, findRepeatedTakes, takeCutRange } from "./footage";
import type { AssistantDigest } from "./context";
import { framingCheck, framingAt, beatsFromKeyframes } from "./camera";

export interface ReadToolContext {
  project: Pick<ProjectDoc, "analysis"> & Partial<Pick<ProjectDoc, "clickMarks">>;
  digest: AssistantDigest;
  /** Close visual inspection of a source range; absent ⇒ the tool reports unavailable. */
  inspect?: (start: number, end: number, question: string) => Promise<string>;
  /** Locate named elements in the frame at a source time; absent ⇒ unavailable. */
  locate?: (at: number, elements: string[]) => Promise<LocatedElement[]>;
  /** Watch the whole clip once and return a shot list (cached by the route); absent ⇒ unavailable. */
  survey?: () => Promise<import("@/lib/firebase/schema").FootageShot[]>;
}

export interface LocatedElement {
  label: string;
  /** Bounding box, 0..1 of the frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  found: boolean;
  /** The text written on the element when it is text (a price, a name), else "". */
  text?: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function executeReadTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ReadToolContext
): Promise<unknown> {
  const transcript = ctx.project.analysis?.transcript;
  switch (name) {
    case "get_timeline":
      return ctx.digest;
    case "find_footage": {
      const query = typeof args.query === "string" ? args.query : "";
      const kind = args.kind === "speech" || args.kind === "visual" ? args.kind : "any";
      const hits = findFootage(ctx.project, query, { kind, limit: 8 });
      return {
        matches: hits.map((h) => ({ start: r2(h.start), end: r2(h.end), kind: h.kind, text: h.text, score: r2(h.score) })),
        note:
          hits.length === 0
            ? "No match in the transcript or stored analysis labels. Visual-only moments may need inspect_footage on a likely range, or ask the user."
            : "Visual matches come from analysis labels and are approximate — confirm precise events with inspect_footage.",
      };
    }
    case "get_transcript": {
      const start = Number(args.start) || 0;
      const end = Number(args.end) || 0;
      const segs = (transcript?.segments ?? []).filter((s) => s.endTime > start && s.startTime < end);
      return transcript?.status === "complete"
        ? { segments: segs.map((s) => ({ start: r2(s.startTime), end: r2(s.endTime), text: s.text })) }
        : { error: "No finished transcript for this video." };
    }
    case "find_repeated_takes": {
      if (transcript?.status !== "complete") return { error: "No finished transcript for this video." };
      return {
        takes: findRepeatedTakes(transcript).map((t) => ({
          first: { start: r2(t.first.start), end: r2(t.first.end), text: t.first.text },
          second: { start: r2(t.second.start), end: r2(t.second.end), text: t.second.text },
          similarity: t.similarity,
          suggestedRemoveFirst: takeCutRange(transcript, t.first, t.second.start),
        })),
        note: "Editors usually keep the LATER take. Use suggestedRemoveFirst with remove_range — it ends just before the kept take's first word.",
      };
    }
    case "find_introductions":
      if (transcript?.status !== "complete") return { error: "No finished transcript for this video." };
      return { introductions: findIntroductions(transcript).map((i) => ({ ...i, start: r2(i.start), end: r2(i.end) })) };
    case "survey_footage": {
      if (!ctx.survey) return { error: "Watching the footage isn't available for this project." };
      try {
        const shots = await ctx.survey();
        return { shots: shots.map((s) => ({ start: r2(s.start), end: r2(s.end), description: s.description, subjects: s.subjects })), note: "Times are source seconds. Pick the shot that matches the request, then locate_elements inside it for exact framing." };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Survey failed." };
      }
    }
    case "locate_elements": {
      const at = Number(args.at);
      const rawEls = args.elements;
      const elements = (Array.isArray(rawEls)
        ? rawEls.filter((e): e is string => typeof e === "string")
        : typeof rawEls === "string"
          ? rawEls.split(/\s*[,;|]\s*/)
          : []
      )
        .map((e) => e.trim())
        .filter(Boolean)
        .slice(0, 6);
      if (!Number.isFinite(at) || !elements.length) return { error: "Need a source time and at least one element to find." };
      if (!ctx.locate) return { error: "Locating elements in the frame isn't available for this project." };
      try {
        const found = await ctx.locate(at, elements);
        return {
          at: r2(at),
          elements: found.map((e) => ({
            ...e,
            cx: r2(e.x + e.w / 2),
            cy: r2(e.y + e.h / 2),
            framingAt150: framingAt({ cx: e.x + e.w / 2, cy: e.y + e.h / 2, w: e.w, h: e.h }, 1.5),
          })),
          note: "Boxes are approximate (±3% of the frame). cx/cy are what set_camera beats take as x/y. A subject near the frame edge is not centred at high zoom (see framingAt150.offsetX/offsetY) — use framing_check to pick a zoom where it is both visible and large enough.",
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Locating failed." };
      }
    }
    case "framing_check": {
      const x = Number(args.x), y = Number(args.y), w = Number(args.w), h = Number(args.h), zoom = Number(args.zoom);
      if (![x, y, w, h, zoom].every(Number.isFinite)) return { error: "x, y, w, h and zoom are required numbers." };
      return { ...framingCheck({ w, h }, zoom), ...framingAt({ cx: x, cy: y, w, h }, zoom) };
    }
    case "get_camera_moves":
      return {
        moves: (ctx.project.analysis?.detectedMoments ?? [])
          .filter((m) => (m.effectType === "zoom" || m.effectType === "cursor-focus") && m.enabled !== false)
          .map((m) => ({ id: m.id, start: r2(m.startTime), end: r2(m.endTime), preset: m.cameraMotion?.preset ?? "standard", beats: beatsFromKeyframes(m) })),
      };
    case "get_clicks":
      return {
        clicks: (ctx.project.clickMarks ?? []).map((c) => ({ t: r2(c.t), x: r2(c.x), y: r2(c.y), source: c.source })),
        searched: Array.isArray(ctx.project.clickMarks),
      };
    case "inspect_footage": {
      const start = Number(args.start);
      const end = Number(args.end);
      const question = typeof args.question === "string" ? args.question : "";
      if (!(end > start) || end - start > 60) return { error: "Range must be positive and at most 60 seconds." };
      if (!ctx.inspect) return { error: "Close inspection isn't available for this project." };
      try {
        return { answer: await ctx.inspect(start, end, question), range: { start: r2(start), end: r2(end) } };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Inspection failed." };
      }
    }
    case "list_graphics": {
      const cat = typeof args.category === "string" ? args.category : "";
      return {
        graphics: PRESETS.filter((p) => p.category !== "captions" && p.category !== "transitions" && (!cat || p.category === cat)).map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          description: p.description,
        })),
      };
    }
    default:
      return { error: `Unknown read tool "${name}".` };
  }
}
