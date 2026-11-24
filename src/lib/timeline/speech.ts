/**
 * Spoken windows of the original asset, in source seconds — what music
 * ducking lowers under. Derived from the transcript so every renderer and the
 * preview duck in the same places.
 */
import type { ProjectDoc } from "@/lib/firebase/schema";

export function speechWindowsOf(project: Pick<ProjectDoc, "analysis">): { start: number; end: number }[] {
  const t = project.analysis?.transcript;
  if (!t || t.status !== "complete") return [];
  const out: { start: number; end: number }[] = [];
  for (const s of t.segments ?? []) {
    if (!(s.endTime > s.startTime)) continue;
    const last = out[out.length - 1];
    // Merge gaps under 300 ms so ducking doesn't flutter between words.
    if (last && s.startTime - last.end < 0.3) last.end = Math.max(last.end, s.endTime);
    else out.push({ start: s.startTime, end: s.endTime });
  }
  return out;
}
