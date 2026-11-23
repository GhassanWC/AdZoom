"use client";

/**
 * Footage preparation for chat requests — the steps a request depends on, run
 * ON DEMAND instead of being sent back to the user as homework:
 *
 *   transcript → speech-to-text (transcript only; the chat adds the captions
 *                itself as ONE undoable change)
 *   clicks     → the recording's click events → cached detections → stored
 *                frame analysis → a fresh frame analysis → a model watching
 *                the video (each only if the previous found nothing)
 *   pauses     → word gaps from the transcript, else audio silence analysis
 *
 * Every result is persisted on the project, so a follow-up request is instant
 * and the same video is never scanned twice. A step that can't run returns
 * `ok: false` with a short, specific reason the chat reports verbatim.
 */

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { apiFetch } from "@/lib/platform/api";
import { serverTimestamp } from "@/lib/platform";
import { useEditorReal } from "./context";
import { HiddenVideoCvEngine } from "@/lib/cv/engine/hidden-video";
import { analyzeAudio } from "@/lib/audio/analyze-audio";
import type { ProjectDoc, Transcript } from "@/lib/firebase/schema";
import type { ClickMark } from "@/lib/edit-commands/types";
import type { FootageNeed } from "@/lib/edit-commands/parse";

export interface PrepResult {
  need: FootageNeed;
  ok: boolean;
  /** Plain-language status for the chat ("Transcribed 31s of speech"). */
  note: string;
}

export interface PreparedData {
  transcript?: Transcript | null;
  clicks?: ClickMark[];
  silences?: { start: number; end: number }[];
}

const TRANSCRIPT_WAIT_MS = 6 * 60_000;

export function useFootagePrep() {
  const { project, writeProject, interactions, cloudAvailable } = useEditorReal();
  const { getIdToken } = useAuth();

  // The live document, plus waiters resolved when it changes — transcription
  // completes server-side and arrives through the project subscription.
  const projectRef = React.useRef(project);
  const waitersRef = React.useRef(new Set<(p: ProjectDoc) => void>());
  React.useEffect(() => {
    projectRef.current = project;
    for (const w of [...waitersRef.current]) w(project);
  }, [project]);

  const waitFor = React.useCallback(
    (pred: (p: ProjectDoc) => boolean, timeoutMs: number): Promise<ProjectDoc | null> =>
      new Promise((resolve) => {
        if (pred(projectRef.current)) return resolve(projectRef.current);
        const waiter = (p: ProjectDoc) => {
          if (!pred(p)) return;
          waitersRef.current.delete(waiter);
          clearTimeout(timer);
          resolve(p);
        };
        const timer = setTimeout(() => {
          waitersRef.current.delete(waiter);
          resolve(null);
        }, timeoutMs);
        waitersRef.current.add(waiter);
      }),
    []
  );

  const authed = React.useCallback(
    async (path: string, body: unknown) => {
      const token = await getIdToken();
      if (!token) throw new Error("Sign in to use this.");
      return apiFetch(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    [getIdToken]
  );

  // ── Transcript ────────────────────────────────────────────────────────────
  const prepareTranscript = React.useCallback(async (): Promise<PrepResult & { transcript?: Transcript | null }> => {
    const done = (t?: Transcript | null) => t?.status === "complete";
    const current = projectRef.current.analysis?.transcript;
    if (done(current)) return { need: "transcript", ok: true, note: "", transcript: current };
    if (!cloudAvailable) {
      return { need: "transcript", ok: false, note: "speech-to-text runs in the cloud — upload this project to the cloud first" };
    }
    try {
      if (current?.status !== "processing") {
        const res = await authed(`/api/projects/${projectRef.current.id}/captions`, {
          mode: "auto",
          locale: typeof navigator !== "undefined" ? navigator.language : undefined,
          transcriptOnly: true,
        });
        const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
        if (body.status === "blocked" || body.status === "unavailable") {
          return { need: "transcript", ok: false, note: body.message ?? "speech-to-text isn't available" };
        }
        if (!res.ok && res.status !== 409) {
          return { need: "transcript", ok: false, note: body.message ?? `speech-to-text failed (${res.status})` };
        }
      }
      const settled = await waitFor((p) => {
        const s = p.analysis?.transcript?.status;
        return s === "complete" || s === "failed" || s === "unavailable";
      }, TRANSCRIPT_WAIT_MS);
      const t = settled?.analysis?.transcript;
      if (!t) return { need: "transcript", ok: false, note: "speech-to-text is taking too long — try again in a minute" };
      if (t.status !== "complete") return { need: "transcript", ok: false, note: t.error ? `speech-to-text failed: ${t.error}` : "speech-to-text failed" };
      return {
        need: "transcript",
        ok: true,
        note: (t.segments?.length ?? 0) > 0 ? "Transcribed the speech" : "No speech found",
        transcript: t,
      };
    } catch (err) {
      return { need: "transcript", ok: false, note: err instanceof Error ? err.message : "speech-to-text failed" };
    }
  }, [authed, cloudAvailable, waitFor]);

  // ── Clicks ────────────────────────────────────────────────────────────────
  const prepareClicks = React.useCallback(async (): Promise<PrepResult & { clicks?: ClickMark[] }> => {
    const p = projectRef.current;
    const save = async (clicks: ClickMark[]) => {
      await writeProject({ clickMarks: clicks, updatedAt: serverTimestamp() }).catch(() => undefined);
    };
    const say = (clicks: ClickMark[], where: string): PrepResult & { clicks: ClickMark[] } => ({
      need: "clicks",
      ok: true,
      note: clicks.length ? `Found ${clicks.length} click${clicks.length === 1 ? "" : "s"} ${where}` : "",
      clicks,
    });

    // 1. Real click events recorded with the video.
    const recorded = (interactions ?? [])
      .filter((e) => e.type === "click" || e.type === "dblclick")
      .map((e) => ({ t: e.t, x: (e as { x: number }).x, y: (e as { y: number }).y, source: "recording" as const }))
      .filter((c) => [c.t, c.x, c.y].every(Number.isFinite));
    if (recorded.length) {
      await save(recorded);
      return say(recorded, "in your recording");
    }
    // 2. Already searched (an empty list means "searched, none").
    if (Array.isArray(p.clickMarks) && p.clickMarks.length) return say(p.clickMarks, "");
    // 3. Frame analysis already on the project.
    const fromVa = (va: ProjectDoc["visualAnalysis"]): ClickMark[] =>
      (va?.inferredClicks ?? []).map((c) => ({
        t: c.t,
        x: c.region.x + c.region.w / 2,
        y: c.region.y + c.region.h / 2,
        source: "frames" as const,
      }));
    let clicks = fromVa(p.visualAnalysis);
    // 4. Run the frame analysis now.
    if (!clicks.length && !p.visualAnalysis && p.originalVideoUrl && (p.duration ?? 0) > 0) {
      const engine = new HiddenVideoCvEngine({ url: p.originalVideoUrl, mimeType: p.mimeType, sourceCrop: p.sourceCrop });
      try {
        const va = await engine.analyzeChunk({ startTime: 0, endTime: p.duration!, duration: p.duration! });
        await writeProject({ visualAnalysis: va, updatedAt: serverTimestamp() }).catch(() => undefined);
        clicks = fromVa(va);
      } catch {
        // CORS-tainted or undecodable in this browser — the model still can look.
      } finally {
        engine.dispose();
      }
    }
    if (clicks.length) {
      await save(clicks);
      return say(clicks, "by analysing the frames");
    }
    // 5. Watch the video with the model.
    if (!cloudAvailable) {
      return { need: "clicks", ok: false, note: "this video has no recorded clicks, and watching it for clicks needs the cloud" };
    }
    try {
      const res = await authed(`/api/projects/${p.id}/assistant`, { action: "detect-clicks" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; clicks?: ClickMark[]; reason?: string };
      if (!body.ok) return { need: "clicks", ok: false, note: body.reason ?? "watching the video for clicks failed" };
      return say(body.clicks ?? [], "by watching the video");
    } catch (err) {
      return { need: "clicks", ok: false, note: err instanceof Error ? err.message : "watching the video for clicks failed" };
    }
  }, [authed, cloudAvailable, interactions, writeProject]);

  // ── Pauses ────────────────────────────────────────────────────────────────
  const preparePauses = React.useCallback(async (): Promise<PrepResult & { silences?: { start: number; end: number }[] }> => {
    const p = projectRef.current;
    if (p.analysis?.transcript?.status === "complete") return { need: "pauses", ok: true, note: "" };
    const existing = p.analysis?.audioAnalysis;
    if (existing?.status === "complete" && existing.hasUsableSpeech === false) {
      return { need: "pauses", ok: false, note: "there's no speech in this video to pace around" };
    }
    const fromAudio = (a: typeof existing) => (a?.silenceSegments ?? []).map((s) => ({ start: s.startTime, end: s.endTime }));
    if (existing?.status === "complete" || existing?.silenceSegments?.length) return { need: "pauses", ok: true, note: "", silences: fromAudio(existing) };
    const a = await analyzeAudio(p.originalVideoUrl, p.duration);
    if (a.status !== "complete") return { need: "pauses", ok: false, note: a.error ? `couldn't analyse the audio: ${a.error}` : "couldn't analyse the audio" };
    await writeProject({ analysis: { audioAnalysis: JSON.parse(JSON.stringify(a)) }, updatedAt: serverTimestamp() }).catch(() => undefined);
    if (a.hasUsableSpeech === false) return { need: "pauses", ok: false, note: "there's no speech in this video to pace around" };
    return { need: "pauses", ok: true, note: "", silences: fromAudio(a) };
  }, [writeProject]);

  /** Run every need; returns per-need results plus the data they produced. */
  const prepare = React.useCallback(
    async (needs: FootageNeed[], onStep?: (label: string) => void): Promise<{ results: PrepResult[]; data: PreparedData }> => {
      const results: PrepResult[] = [];
      const data: PreparedData = {};
      for (const need of needs) {
        if (need === "transcript") {
          onStep?.("Transcribing the speech…");
          const r = await prepareTranscript();
          results.push(r);
          if (r.transcript) data.transcript = r.transcript;
        } else if (need === "clicks") {
          onStep?.("Looking for clicks in the footage…");
          const r = await prepareClicks();
          results.push(r);
          if (r.clicks) data.clicks = r.clicks;
        } else if (need === "pauses") {
          onStep?.("Measuring the pauses…");
          const r = await preparePauses();
          results.push(r);
          if (r.silences) data.silences = r.silences;
        }
      }
      return { results, data };
    },
    [prepareTranscript, prepareClicks, preparePauses]
  );

  return { prepare };
}
