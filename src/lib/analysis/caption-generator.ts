/**
 * Caption generation from a REAL transcript. Pure + DOM-free (type-only imports)
 * so it's unit-testable. Turns transcript segments/words into `captions`
 * `DetectedMoment`s with recipe-chosen styling. NEVER invents words: it emits
 * captions ONLY when the transcript is `complete` with segments, using the
 * transcript's own timings. Manual captions are untouched (the caller dedups).
 */
import type {
  DetectedMoment,
  OverlayTextPreset,
  SelectedVideoType,
  Transcript,
  TranscriptSegment,
  TranscriptWord,
} from "@/lib/firebase/schema";
import { textDirection } from "@/lib/render/text-shaping";

/** Per video type → caption style preset (product spec §5). */
export function captionStyleForVideoType(v: SelectedVideoType): OverlayTextPreset {
  switch (v) {
    case "reels-shorts":
    case "ad-promo":
      return "bold_social";
    case "podcast-clip":
      return "podcast";
    case "tutorial":
      return "tutorial";
    case "screen-recording":
      return "tutorial";
    case "talking-head":
    case "product-demo":
    case "vlog":
    case "auto":
    default:
      return "clean";
  }
}

const MAX_WORDS_PER_LINE = 7;
const MAX_LINE_SEC = 3.2;
const MIN_LINE_SEC = 0.6;
/** Firestore-doc-size guard — cap total generated caption lines. */
const MAX_CAPTIONS = 600;

interface Line {
  text: string;
  start: number;
  end: number;
  words?: TranscriptWord[];
}

function wordsInSegment(seg: TranscriptSegment, all: TranscriptWord[] | undefined): TranscriptWord[] {
  if (!all || all.length === 0) return [];
  const eps = 0.05;
  return all.filter((w) => w.startTime >= seg.startTime - eps && w.endTime <= seg.endTime + eps);
}

/** Split one segment into short, readable caption lines using real word timings when present. */
function splitSegment(seg: TranscriptSegment, all: TranscriptWord[] | undefined): Line[] {
  const text = seg.text.trim();
  if (!text) return [];
  const segWords = wordsInSegment(seg, all);

  if (segWords.length > 0) {
    const lines: Line[] = [];
    let cur: TranscriptWord[] = [];
    const flush = () => {
      if (!cur.length) return;
      lines.push({
        text: cur.map((w) => w.word).join(" ").trim(),
        start: cur[0].startTime,
        end: cur[cur.length - 1].endTime,
        words: cur,
      });
      cur = [];
    };
    for (const w of segWords) {
      const wouldSpan = cur.length ? w.endTime - cur[0].startTime : 0;
      if (cur.length >= MAX_WORDS_PER_LINE || (cur.length && wouldSpan > MAX_LINE_SEC)) flush();
      cur.push(w);
    }
    flush();
    return lines;
  }

  // No word timings → split by word count + distribute the segment time evenly.
  const tokens = text.split(/\s+/).filter(Boolean);
  const dur = Math.max(0, seg.endTime - seg.startTime);
  const chunks: string[][] = [];
  for (let i = 0; i < tokens.length; i += MAX_WORDS_PER_LINE) {
    chunks.push(tokens.slice(i, i + MAX_WORDS_PER_LINE));
  }
  if (chunks.length === 0) return [];
  const per = dur / chunks.length;
  return chunks.map((c, i) => ({
    text: c.join(" "),
    start: seg.startTime + i * per,
    end: seg.startTime + (i + 1) * per,
  }));
}

export interface CaptionGenResult {
  moments: DetectedMoment[];
  truncated: boolean;
}

/**
 * Generate caption moments from a transcript. Returns `[]` unless the transcript
 * is `complete` with segments (no fake captions). Style follows the video type.
 */
export function generateCaptionMoments(
  transcript: Transcript | null | undefined,
  videoType: SelectedVideoType
): CaptionGenResult {
  if (!transcript || transcript.status !== "complete" || !(transcript.segments?.length)) {
    return { moments: [], truncated: false };
  }
  const stylePreset = captionStyleForVideoType(videoType);
  // Metadata only: `lang` from the transcript, `direction` derived from the actual
  // caption TEXT via the shared resolver (§3 — direction comes from the script, not
  // the ASR language). Rendering itself re-derives font + direction from the text
  // at draw time (overlay-draw.ts), so captions stay in the spoken language and
  // shape/order correctly in preview AND every export without translation.
  const lang = transcript.language ?? undefined;
  const moments: DetectedMoment[] = [];
  let truncated = false;

  outer: for (let s = 0; s < transcript.segments.length; s++) {
    const lines = splitSegment(transcript.segments[s], transcript.words);
    for (let l = 0; l < lines.length; l++) {
      if (moments.length >= MAX_CAPTIONS) {
        truncated = true;
        break outer;
      }
      const line = lines[l];
      const end = Math.max(line.start + MIN_LINE_SEC, line.end);
      moments.push({
        id: `cap-${s}-${l}`,
        startTime: line.start,
        endTime: end,
        label: "Caption",
        reason: "Auto-caption from the transcript.",
        focusRegion: { x: 0, y: 0, width: 1, height: 1 },
        effectType: "captions",
        enabled: true,
        source: "ai",
        provenance: "ai",
        recipe: {
          source: "recipe",
          recipeType: videoType,
          category: "captions",
          reason: "Transcript-derived captions.",
        },
        captions: {
          text: line.text,
          stylePreset,
          position: "bottom",
          direction: textDirection(line.text),
          ...(lang ? { lang } : {}),
          ...(line.words && line.words.length
            ? {
                words: line.words.map((w) => ({
                  text: w.word,
                  start: w.startTime,
                  end: w.endTime,
                })),
              }
            : {}),
        },
      });
    }
  }
  return { moments, truncated };
}
