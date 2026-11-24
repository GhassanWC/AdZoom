/**
 * POST /api/projects/[id]/assistant — the editing assistant's model turn.
 *
 * Request (Bearer ID token):
 *   { message, requestId, selection: {clipId?, elementId?}, playhead, recentElementIds? }
 * Response:
 *   { kind: "commands", commands, reply }   — validated EditCommands to apply
 *   { kind: "question", question, options } — the model needs a decision
 *   { kind: "reply", reply }                — nothing to change
 *   { kind: "unavailable", reason }         — no model configured / failed
 *
 * This route NEVER writes the timeline. The client applies `commands` through
 * the same executor as a typed command, against its LIVE timeline, as one undo
 * step (EditorRealContext.applyEditRequest). The only write here is a cache of
 * the uploaded Gemini file reference (`assistantMedia`), so close inspection
 * of a long video uploads it once, not on every request.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { materializeProject } from "@/lib/firebase/materialize-project";
import { hydrateProjectDoc } from "@/lib/firebase/payload-store";
import { Type } from "@google/genai";
import { getGemini, uploadVideoToGemini, waitForGeminiFileActive, type GeminiVideoRef } from "@/lib/gemini";
import { buildAssistantDigest } from "@/lib/edit-commands/context";
import { runGeminiAssistant, ASSISTANT_MODEL } from "@/lib/edit-commands/gemini-assistant";
import { recordEvent } from "@/lib/analytics/recordEvent";
import { mergeSurveyShots } from "@/lib/edit-commands/survey";
import { EVENTS } from "@/lib/analytics/events";
import type { EffectLibraryEntry } from "@/lib/effects/library";
import type { FoundEvent } from "@/lib/effects/assistant-tools";
import { audioLockFromMessage, mergeMemory } from "@/lib/edit-commands/memory";
import type { AssistantMemoryItem } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MESSAGE = 1000;
/** Same inline ceiling the analyze route uses. */
const INLINE_BYTE_LIMIT = 18 * 1024 * 1024;
/** Gemini files live 48h; refresh well before that. */
const FILE_TTL_MS = 40 * 3600_000;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: projectId } = await params;
  const authHeader = req.headers.get("authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });

  const { auth, db, storage } = getAdmin();
  let uid: string;
  try {
    uid = (await auth.verifyIdToken(idToken)).uid;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let body: {
    message?: unknown;
    requestId?: unknown;
    selection?: { clipId?: unknown; elementId?: unknown };
    playhead?: unknown;
    recentElementIds?: unknown;
    /** "detect-clicks": find clicks by watching the video (no message needed). */
    action?: unknown;
    /** Footage steps the client already ran for this request. */
    prepared?: unknown;
    /** Dev only: include the tool-call trace in the response. */
    debug?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.slice(0, 80) : "";
  const action = body.action === "detect-clicks" ? "detect-clicks" : null;
  if (!action && (!message || !requestId)) {
    return NextResponse.json({ error: "message and requestId are required." }, { status: 400 });
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ kind: "unavailable", reason: "The AI model isn't configured on this server." });
  }

  const ref = db.doc(`users/${uid}/projects/${projectId}`);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const raw = await hydrateProjectDoc(snap.data() as Record<string, unknown>);
  const project = materializeProject(projectId, raw);

  const sel = body.selection ?? {};
  const digest = buildAssistantDigest({
    project,
    moments: project.analysis?.detectedMoments ?? [],
    layers: project.timelineLayers ?? {},
    sourceDuration: project.duration ?? 0,
    playhead: typeof body.playhead === "number" && Number.isFinite(body.playhead) ? body.playhead : 0,
    selection: {
      clipId: typeof sel.clipId === "string" ? sel.clipId : null,
      elementId: typeof sel.elementId === "string" ? sel.elementId : null,
    },
    recentElementIds: Array.isArray(body.recentElementIds)
      ? body.recentElementIds.filter((x): x is string => typeof x === "string").slice(0, 20)
      : [],
  });
  if (!(digest.sourceDuration > 0)) {
    return NextResponse.json({ kind: "unavailable", reason: "This video's duration isn't known yet — wait for the upload to finish." });
  }

  // Close visual inspection: the source video, uploaded to Gemini at most once
  // per ~40h, then queried with start/end offsets so only the range is watched.
  // One media reference per ASSET ("source" = the original; others from the
  // project's assets). The source's upload is cached on the document; added
  // assets are small enough to inline in practice and are re-uploaded otherwise.
  const videoRefs = new Map<string, GeminiVideoRef>();
  const assetStoragePath = (assetId: string): { path: string; mimeType: string } => {
    if (assetId === "source") {
      if (!project.storagePath) throw new Error("The source video isn't in cloud storage.");
      return { path: project.storagePath, mimeType: project.mimeType || "video/mp4" };
    }
    const a = (project.assets ?? []).find((x) => x.id === assetId);
    if (!a?.storagePath) throw new Error(`Asset "${assetId}" isn't in cloud storage.`);
    return { path: a.storagePath, mimeType: a.mimeType || "video/mp4" };
  };
  const ensureVideo = async (assetId = "source"): Promise<GeminiVideoRef> => {
    const hit = videoRefs.get(assetId);
    if (hit) return hit;
    const { path, mimeType } = assetStoragePath(assetId);
    if (assetId === "source") {
      const cached = raw.assistantMedia as { uri?: string; mimeType?: string; expiresAt?: number } | undefined;
      if (cached?.uri && (cached.expiresAt ?? 0) > Date.now()) {
        const v: GeminiVideoRef = { kind: "file", uri: cached.uri, mimeType: cached.mimeType || mimeType };
        videoRefs.set(assetId, v);
        return v;
      }
    }
    const [buffer] = await storage.bucket().file(path).download();
    if (buffer.length <= INLINE_BYTE_LIMIT) {
      const v: GeminiVideoRef = { kind: "inline", buffer, mimeType };
      videoRefs.set(assetId, v);
      return v;
    }
    const uploaded = await uploadVideoToGemini(buffer, mimeType, { retries: 1, perAttemptTimeoutMs: 60_000 });
    await waitForGeminiFileActive(uploaded.name, { timeoutMs: 60_000 });
    const v: GeminiVideoRef = { kind: "file", uri: uploaded.uri, mimeType: uploaded.mimeType };
    videoRefs.set(assetId, v);
    if (assetId === "source") {
      await ref.set({ assistantMedia: { uri: uploaded.uri, name: uploaded.name, mimeType: uploaded.mimeType, expiresAt: Date.now() + FILE_TTL_MS } }, { merge: true });
    }
    return v;
  };
  const assetDurationOf = (assetId: string): number => (assetId === "source" ? digest.sourceDuration : (project.assets ?? []).find((x) => x.id === assetId)?.duration ?? 0);
  const inspect = async (start: number, end: number, question: string, assetId = "source"): Promise<string> => {
    const v = await ensureVideo(assetId);
    const part =
      v.kind === "file"
        ? { fileData: { fileUri: v.uri, mimeType: v.mimeType } }
        : { inlineData: { data: v.buffer.toString("base64"), mimeType: v.mimeType } };
    const res = await getGemini().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { ...part, videoMetadata: { startOffset: `${start.toFixed(2)}s`, endOffset: `${end.toFixed(2)}s`, fps: 4 } } as never,
            {
              text: `You are watching seconds ${start.toFixed(2)}–${end.toFixed(2)} of a video. ${question}\nAnswer in at most two sentences. Give any time as ABSOLUTE seconds in the full video (between ${start.toFixed(2)} and ${end.toFixed(2)}).`,
            },
          ],
        },
      ],
      config: { temperature: 0.1 },
    });
    return (res.text ?? "").trim() || "No clear answer.";
  };

  // ── Visual click detection ────────────────────────────────────────────────
  // The last resort of "add zooms on clicks" when the recording has no click
  // events and frame analysis found none: a model WATCHES the video and reports
  // where a pointer clicks. Cached on the project (`clickMarks`) so a repeat
  // request never pays for it twice.
  if (action === "detect-clicks") {
    const dur = digest.sourceDuration;
    const WINDOW = 60;
    const clicks: { t: number; x: number; y: number; source: "model" }[] = [];
    try {
      const v = await ensureVideo();
      const part =
        v.kind === "file"
          ? { fileData: { fileUri: v.uri, mimeType: v.mimeType } }
          : { inlineData: { data: v.buffer.toString("base64"), mimeType: v.mimeType } };
      for (let start = 0; start < dur; start += WINDOW) {
        const end = Math.min(dur, start + WINDOW);
        const res = await getGemini().models.generateContent({
          model: ASSISTANT_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                { ...part, videoMetadata: { startOffset: `${start.toFixed(2)}s`, endOffset: `${end.toFixed(2)}s`, fps: 4 } } as never,
                {
                  text: `This is seconds ${start.toFixed(2)}–${end.toFixed(2)} of a screen recording. List every moment a mouse pointer CLICKS something (a button press, a tab or link activated, a ripple or highlight at the pointer, or the UI changing right where the pointer is). Ignore plain pointer movement. For each click give the ABSOLUTE time in seconds in the full video and the click position as fractions of the frame (x from the left, y from the top, 0..1). Return an empty list if there are no clicks.`,
                },
              ],
            },
          ],
          config: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                clicks: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: { t: { type: Type.NUMBER }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
                    required: ["t", "x", "y"],
                  },
                },
              },
              required: ["clicks"],
            } as never,
          },
        });
        const parsed = JSON.parse(res.text ?? "{}") as { clicks?: { t?: unknown; x?: unknown; y?: unknown }[] };
        for (const c of parsed.clicks ?? []) {
          const t = Number(c.t);
          const x = Number(c.x);
          const y = Number(c.y);
          if (![t, x, y].every(Number.isFinite)) continue;
          if (t < start - 0.5 || t > end + 0.5 || x < 0 || x > 1 || y < 0 || y > 1) continue;
          clicks.push({ t: Math.round(t * 100) / 100, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, source: "model" });
        }
      }
    } catch (err) {
      console.error("[assistant] detect-clicks failed:", err instanceof Error ? err.message : "unknown");
      return NextResponse.json({ ok: false, reason: "Watching the video for clicks failed." });
    }
    clicks.sort((a, b) => a.t - b.t);
    // Merge near-duplicates the model reports twice across a window edge.
    const unique = clicks.filter((c, i) => i === 0 || c.t - clicks[i - 1].t > 0.4);
    await ref.set({ clickMarks: unique }, { merge: true });
    return NextResponse.json({ ok: true, clicks: unique });
  }

  // Where things are in the frame — the model grounds focal points and label
  // positions in the footage instead of guessing. One short look at the frame
  // around `at`, boxes as fractions of the frame.
  const locate = async (at: number, elements: string[], assetId = "source") => {
    const v = await ensureVideo(assetId);
    const part =
      v.kind === "file"
        ? { fileData: { fileUri: v.uri, mimeType: v.mimeType } }
        : { inlineData: { data: v.buffer.toString("base64"), mimeType: v.mimeType } };
    const s0 = Math.max(0, at - 0.25);
    const s1 = Math.min(assetDurationOf(assetId) || digest.sourceDuration, at + 0.25);
    const res = await getGemini().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { ...part, videoMetadata: { startOffset: `${s0.toFixed(2)}s`, endOffset: `${s1.toFixed(2)}s`, fps: 4 } } as never,
            {
              text: `You are looking at the frame at ${at.toFixed(2)}s of a video (${project.width ?? 1920}×${project.height ?? 1080}). For each requested element, give its bounding box as FRACTIONS of the frame: x,y = top-left, w,h = size, all 0..1, and text = the exact text written on/in it if it is text (a price like "Rs 380", a dish name), else "". "The price" means the price of THIS dish (the Rs amount beside its name or its add-to-cart button) — never a delivery fee, deal price or another item's price. If an element is not visible, set found=false and a zero box. Elements: ${elements.map((e) => JSON.stringify(e)).join(", ")}.`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            elements: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: { label: { type: Type.STRING }, found: { type: Type.BOOLEAN }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, w: { type: Type.NUMBER }, h: { type: Type.NUMBER }, text: { type: Type.STRING } },
                required: ["label", "found", "x", "y", "w", "h", "text"],
              },
            },
          },
          required: ["elements"],
        } as never,
      },
    });
    const parsed = JSON.parse(res.text ?? "{}") as { elements?: { label?: unknown; found?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; text?: unknown }[] };
    const c01 = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));
    return elements.map((label, i) => {
      const e = (parsed.elements ?? []).find((x) => typeof x.label === "string" && x.label.toLowerCase() === label.toLowerCase()) ?? parsed.elements?.[i];
      if (!e || e.found === false) return { label, found: false, x: 0, y: 0, w: 0, h: 0, text: "" };
      const x = c01(e.x), y = c01(e.y);
      return { label, found: true, x, y, w: Math.min(1 - x, c01(e.w)), h: Math.min(1 - y, c01(e.h)), text: typeof e.text === "string" ? e.text.slice(0, 80) : "" };
    });
  };

  // One watch of the whole clip → a shot list, cached on the project.
  const survey = async (assetId = "source") => {
    const cached = assetId === "source" ? project.footageSurvey?.shots : undefined;
    if (cached && cached.length) return cached;
    const v = await ensureVideo(assetId);
    const part =
      v.kind === "file"
        ? { fileData: { fileUri: v.uri, mimeType: v.mimeType } }
        : { inlineData: { data: v.buffer.toString("base64"), mimeType: v.mimeType } };
    const dur = assetDurationOf(assetId) || digest.sourceDuration;
    const WINDOW = 45;
    const shots: { start: number; end: number; description: string; subjects: string[] }[] = [];
    for (let s0 = 0; s0 < dur; s0 += WINDOW) {
      const s1 = Math.min(dur, s0 + WINDOW);
      const res = await getGemini().models.generateContent({
        model: ASSISTANT_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { ...part, videoMetadata: { startOffset: `${s0.toFixed(2)}s`, endOffset: `${s1.toFixed(2)}s`, fps: 2 } } as never,
              {
                text: `You are an editor logging footage. This is seconds ${s0.toFixed(1)}–${s1.toFixed(1)} of a video. Break it into shots/beats: a new shot only when the SUBJECT changes (a different dish, a different section) — scrolling, pop-ups or small UI changes while the same subject stays on screen do NOT start a new shot. Aim for 2–8 second beats. For each give ABSOLUTE start and end in SECONDS of the full video (e.g. start 12.5, end 16.0 — never fractions of the clip), one sentence describing what is on screen and what happens, and 2–5 short subject nouns a person might name (e.g. "chicken tikka dish photo", "price Rs 380", "menu grid", "hand", "logo").`,
              },
            ],
          },
        ],
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              shots: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: { start: { type: Type.NUMBER }, end: { type: Type.NUMBER }, description: { type: Type.STRING }, subjects: { type: Type.ARRAY, items: { type: Type.STRING } } },
                  required: ["start", "end", "description", "subjects"],
                },
              },
            },
            required: ["shots"],
          } as never,
        },
      });
      const parsed = JSON.parse(res.text ?? "{}") as { shots?: { start?: unknown; end?: unknown; description?: unknown; subjects?: unknown }[] };
      for (const sh of parsed.shots ?? []) {
        const a = Number(sh.start), b = Number(sh.end);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
        shots.push({
          start: Math.round(Math.max(0, a) * 100) / 100,
          end: Math.round(Math.min(dur, b) * 100) / 100,
          description: typeof sh.description === "string" ? sh.description.slice(0, 300) : "",
          subjects: Array.isArray(sh.subjects) ? sh.subjects.filter((x): x is string => typeof x === "string").slice(0, 6) : [],
        });
      }
    }
    shots.sort((x, y) => x.start - y.start);
    // The model occasionally answers in fractions of the clip instead of
    // seconds (every end ≤ 1 on a 33s video). Rescale rather than let the
    // assistant believe the footage is a fraction of a second long.
    const maxEnd = shots.reduce((m, sh) => Math.max(m, sh.end), 0);
    if (dur > 3 && maxEnd > 0 && maxEnd <= 1.05) {
      for (const sh of shots) {
        sh.start = Math.round(sh.start * dur * 100) / 100;
        sh.end = Math.round(Math.min(dur, sh.end * dur) * 100) / 100;
      }
    }
    const merged = mergeSurveyShots(shots);
    if (assetId === "source") await ref.set({ footageSurvey: { shots: merged, createdAt: Date.now() } }, { merge: true });
    return merged;
  };

  // Events in the footage ("the ball crosses the goal line"), with where the
  // key object is at that instant. Watched in windows so long videos fit.
  const events = async (query: string, assetId = "source"): Promise<FoundEvent[]> => {
    const v = await ensureVideo(assetId);
    const part =
      v.kind === "file"
        ? { fileData: { fileUri: v.uri, mimeType: v.mimeType } }
        : { inlineData: { data: v.buffer.toString("base64"), mimeType: v.mimeType } };
    const dur = assetDurationOf(assetId) || digest.sourceDuration;
    const WINDOW = 45;
    const found: FoundEvent[] = [];
    for (let s0 = 0; s0 < dur; s0 += WINDOW) {
      const s1 = Math.min(dur, s0 + WINDOW);
      const res = await getGemini().models.generateContent({
        model: ASSISTANT_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { ...part, videoMetadata: { startOffset: `${s0.toFixed(2)}s`, endOffset: `${s1.toFixed(2)}s`, fps: 4 } } as never,
              {
                text: `This is seconds ${s0.toFixed(1)}–${s1.toFixed(1)} of a video. Find every occurrence of: ${JSON.stringify(query)}. For each, give the ABSOLUTE time in seconds of the full video at the exact instant it happens (e.g. the frame the ball crosses the line), where the key object (e.g. the ball) is at that instant as fractions of the frame (x from the left, y from the top, 0..1), one sentence describing it (say "replay" if it is a replay of an earlier moment), and your confidence 0..1. Return an empty list if it does not happen in this range.`,
              },
            ],
          },
        ],
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              events: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: { time: { type: Type.NUMBER }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, description: { type: Type.STRING }, confidence: { type: Type.NUMBER } },
                  required: ["time", "x", "y", "description", "confidence"],
                },
              },
            },
            required: ["events"],
          } as never,
        },
      });
      const parsed = JSON.parse(res.text ?? "{}") as { events?: Record<string, unknown>[] };
      for (const e of parsed.events ?? []) {
        const time = Number(e.time), x = Number(e.x), y = Number(e.y);
        if (![time, x, y].every(Number.isFinite) || time < s0 - 1 || time > s1 + 1) continue;
        found.push({ time: Math.max(0, Math.min(dur, time)), x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), description: String(e.description ?? "").slice(0, 200), confidence: Math.min(1, Math.max(0, Number(e.confidence) || 0)) });
      }
    }
    found.sort((a, b) => a.time - b.time);
    return found.filter((e, i) => i === 0 || e.time - found[i - 1].time > 1);
  };

  // Where one element is, ~4×/s across a short window (an effect that follows the ball).
  const track = async (element: string, start: number, duration: number, assetId = "source") => {
    const v = await ensureVideo(assetId);
    const part =
      v.kind === "file"
        ? { fileData: { fileUri: v.uri, mimeType: v.mimeType } }
        : { inlineData: { data: v.buffer.toString("base64"), mimeType: v.mimeType } };
    const s0 = Math.max(0, start);
    const s1 = Math.min(assetDurationOf(assetId) || digest.sourceDuration, start + duration);
    const times: number[] = [];
    for (let t = s0; t <= s1 + 1e-6; t += 0.25) times.push(Math.round(t * 100) / 100);
    const res = await getGemini().models.generateContent({
      model: ASSISTANT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { ...part, videoMetadata: { startOffset: `${s0.toFixed(2)}s`, endOffset: `${s1.toFixed(2)}s`, fps: 8 } } as never,
            { text: `Track ${JSON.stringify(element)} in seconds ${s0.toFixed(2)}–${s1.toFixed(2)} of this video. For each of these ABSOLUTE times give its centre as fractions of the frame (x from the left, y from the top, 0..1); skip times where it is not visible: ${times.join(", ")}.` },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: { samples: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { t: { type: Type.NUMBER }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ["t", "x", "y"] } } },
          required: ["samples"],
        } as never,
      },
    });
    const parsed = JSON.parse(res.text ?? "{}") as { samples?: { t?: unknown; x?: unknown; y?: unknown }[] };
    return (parsed.samples ?? [])
      .map((x) => ({ t: Number(x.t), x: Number(x.x), y: Number(x.y) }))
      .filter((x) => [x.t, x.x, x.y].every(Number.isFinite) && x.x >= 0 && x.x <= 1 && x.y >= 0 && x.y <= 1 && x.t >= s0 - 0.3 && x.t <= s1 + 0.3);
  };

  // The user's effect library (users/{uid}/effects) and this project's memory.
  const libraryCol = db.collection(`users/${uid}/effects`);
  const library = (await libraryCol.get()).docs.map((d) => d.data() as EffectLibraryEntry);
  let memory: AssistantMemoryItem[] = project.assistantMemory ?? [];
  // A standing "keep the commentary" is recorded at once — it constrains THIS
  // request's edits too, whatever the model does.
  const lock = message ? audioLockFromMessage(message) : null;
  if (lock && !memory.some((m) => m.lock === "audio")) {
    memory = mergeMemory(memory, [lock]);
    await ref.set({ assistantMemory: memory }, { merge: true });
  }

  const started = Date.now();
  try {
    const prepared = Array.isArray(body.prepared) ? body.prepared.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
    const debug = body.debug === true && process.env.NODE_ENV !== "production";
    const full = await runGeminiAssistant({ message, requestId, digest, project, inspect, locate, survey, prepared, debug, library, events, track, memory });
    const { sideEffects, ...result } = full;
    // Persist what the turn produced. Ids/versions derive from the request id,
    // so a retried request rewrites the same records (no duplicates).
    if (sideEffects?.library.length) {
      const batch = db.batch();
      for (const entry of sideEffects.library) batch.set(libraryCol.doc(entry.id), entry);
      await batch.commit();
    }
    if (sideEffects?.memory.length) {
      await ref.set({ assistantMemory: mergeMemory(memory, sideEffects.memory) }, { merge: true });
    }
    const libraryChanges = (sideEffects?.library ?? []).map((e) => ({ id: e.id, name: e.name, version: e.latestVersion, origin: e.origin }));
    void recordEvent(EVENTS.ASSISTANT_REQUEST, {
      userId: uid,
      projectId,
      metadata: {
        stage: "model",
        outcome: result.kind,
        ops: result.kind === "commands" ? [...new Set(result.commands.map((c) => c.op))].join(",") : "none",
        latencyMs: Date.now() - started,
        model: result.model,
      },
    });
    return NextResponse.json({ ...result, ...(libraryChanges.length ? { libraryChanges } : {}) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[assistant] model turn failed:", detail);
    void recordEvent(EVENTS.ASSISTANT_REQUEST, {
      userId: uid,
      projectId,
      metadata: { stage: "model", outcome: "failed", latencyMs: Date.now() - started },
    });
    return NextResponse.json({
      kind: "unavailable",
      reason: "The AI model didn't respond. Try again, or use a direct command like “trim the first two seconds”.",
      // Dev only: the raw error, so the cause is visible without server logs.
      ...(process.env.NODE_ENV !== "production" ? { detail: detail.slice(0, 600) } : {}),
    });
  }
}
