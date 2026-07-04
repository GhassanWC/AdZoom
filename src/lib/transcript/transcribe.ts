/**
 * transcribeVideo — the single entry the analysis pipeline calls. Resolves the
 * configured provider; with none configured it returns `unavailable` instantly
 * (no fake data, no cost). A provider failure is caught + reported as `failed`
 * so transcription can NEVER break the surrounding analysis.
 */
import type { Transcript } from "@/lib/firebase/schema";
import { getTranscriptProvider, type TranscribeInput } from "./provider";

export async function transcribeVideo(input: TranscribeInput): Promise<Transcript> {
  const provider = await getTranscriptProvider();
  if (!provider) {
    console.info("[transcript:analysis]", { provider: "none", status: "unavailable" });
    return { status: "unavailable" };
  }
  try {
    const t = await provider.transcribeVideo(input);
    console.info("[transcript:analysis]", {
      provider: provider.name,
      model: provider.model,
      status: t.status,
      language: t.language,
      segments: t.segments?.length ?? 0,
      words: t.words?.length ?? 0,
    });
    return t;
  } catch (err) {
    console.warn("[transcript:analysis] failed", err);
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "transcription failed",
    };
  }
}

/** True when a transcript is REAL + usable for caption generation. */
export function hasUsableTranscript(t: Transcript | null | undefined): boolean {
  return !!t && t.status === "complete" && (t.segments?.length ?? 0) > 0;
}
