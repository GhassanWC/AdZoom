/**
 * Footage-survey post-processing — pure.
 *
 * A model logging a scrolling page tends to cut a new "shot" at every scroll
 * step, so one dish section arrives as three 1-second beats. Camera moves and
 * labels need the WHOLE stretch the dish is on screen, so adjacent beats that
 * share a specific subject (a dish name, a product) are merged. Generic words
 * ("website", "scrolling", "prices") never justify a merge.
 */

import type { FootageShot } from "@/lib/firebase/schema";

const GENERIC = new Set([
  "website", "web page", "page", "screen", "text", "scrolling", "scroll", "prices", "price", "add buttons", "add button",
  "button", "buttons", "menu", "menu categories", "menu bar", "header", "footer", "section", "cards", "card", "image", "photo",
  "hand", "cursor", "pointer", "ui", "layout", "background", "logo", "delivery info", "delivery details", "operating hours",
]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function specific(subjects: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of subjects) {
    const s = norm(raw);
    if (!s || GENERIC.has(s)) continue;
    // Drop trailing generic qualifiers ("zinger burger image" → "zinger burger").
    const trimmed = s.replace(/\b(image|photo|picture|section|card|details|dish photo)\b/g, "").replace(/\s+/g, " ").trim();
    if (trimmed && !GENERIC.has(trimmed)) out.add(trimmed);
  }
  return out;
}

/** Merge runs of adjacent shots that share a specific subject. Keeps order; unions subjects. */
export function mergeSurveyShots(shots: readonly FootageShot[], maxMergedSeconds = 12): FootageShot[] {
  const out: FootageShot[] = [];
  for (const s of shots) {
    const prev = out[out.length - 1];
    if (prev) {
      const a = specific(prev.subjects);
      const b = specific(s.subjects);
      const shared = [...a].some((x) => b.has(x) || [...b].some((y) => y.includes(x) || x.includes(y)));
      const contiguous = s.start - prev.end < 0.35;
      if (shared && contiguous && s.end - prev.start <= maxMergedSeconds) {
        out[out.length - 1] = {
          start: prev.start,
          end: Math.max(prev.end, s.end),
          description: prev.description.length >= s.description.length ? prev.description : s.description,
          subjects: [...new Set([...prev.subjects, ...s.subjects])].slice(0, 8),
        };
        continue;
      }
    }
    out.push({ ...s, subjects: [...s.subjects] });
  }
  return out;
}
