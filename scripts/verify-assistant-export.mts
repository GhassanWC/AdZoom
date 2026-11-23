/**
 * Editing assistant → REAL exported MP4, through the worker render CLI (the same
 * renderer the desktop export spawns and the Cloud Run worker runs).
 *
 *   npm run verify:assistant-export        (builds the CLI first)
 *
 * Scenario A — motion graphics:
 *   "Add an animated lower third when the speaker introduces herself"
 *   → "Move it to the top left and delay it half a second"
 *   Both versions are exported; pixel checks prove the plate is bottom-left in
 *   the draft, top-left in the revision, and not yet on screen at the old start.
 *
 * Scenario B — interview:
 *   "Remove the repeated answer and add captions"
 *   The export must be shorter by exactly the removed take, keep a full-length
 *   audio track (the worker's audio-verify), and show the kept take's caption.
 *
 * The fixture's audio is a tone, so the transcripts are SYNTHETIC word timings;
 * real projects get them from Google Speech-to-Text. Everything downstream —
 * parser, executor, stored project data, renderer — is the production code.
 * Frames are written next to the MP4s for a human look.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseEditRequest } from "../src/lib/edit-commands/parse";
import { applyEditCommands } from "../src/lib/edit-commands/apply";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed";
import { DEFAULT_EFFECTS_SETTINGS, type DetectedMoment, type Transcript } from "../src/lib/firebase/schema";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(REPO, "services", "export-worker");
const CLI = join(WORKER, "dist", "cli.js");
const FFMPEG = process.env.FRAMEVO_FFMPEG_PATH || join(WORKER, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const FFPROBE = process.env.FRAMEVO_FFPROBE_PATH || (createRequire(join(WORKER, "package.json"))("ffprobe-static") as { path: string }).path;
if (!existsSync(CLI)) throw new Error("services/export-worker/dist/cli.js missing — run `npm run worker:build` first.");

const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "framevo-assistant-export-"));
mkdirSync(OUT, { recursive: true });
const W = 1280, H = 720;
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures += 1;
};

function source(name: string, seconds: number): string {
  const p = join(OUT, name);
  if (!existsSync(p)) {
    execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p]);
  }
  return p;
}

function transcriptOf(lines: { start: number; end: number; text: string }[]): Transcript {
  const words = lines.flatMap((l) => {
    const ws = l.text.split(" ");
    const per = (l.end - l.start) / ws.length;
    return ws.map((w, i) => ({ word: w, startTime: l.start + i * per, endTime: l.start + i * per + per * 0.85 }));
  });
  return {
    status: "complete",
    language: "en",
    text: lines.map((l) => l.text).join(" "),
    segments: lines.map((l, i) => ({ id: `s${i}`, startTime: l.start, endTime: l.end, text: l.text })),
    words,
  } as Transcript;
}

function render(name: string, src: string, dur: number, moments: DetectedMoment[]): { path: string; events: string[] } {
  const out = join(OUT, `${name}.mp4`);
  const spec = {
    sourcePath: src, outputPath: out, crf: 20, preset: "ultrafast", normalizeEnabled: false,
    serializedRecipe: { sourceWidth: W, sourceHeight: H, fps: 30, resolution: "720p", format: "Source", sourceDuration: dur, moments, effects: DEFAULT_EFFECTS_SETTINGS, sourceCrop: null, applyWatermark: false },
  };
  const specPath = join(OUT, `${name}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec));
  const res = spawnSync(process.execPath, [CLI, specPath], { encoding: "utf8", env: { ...process.env, FRAMEVO_FFMPEG_PATH: FFMPEG } });
  const events = res.stdout.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).type as string; } catch { return "?"; } });
  check(res.status === 0 && events.includes("done"), `${name}: worker CLI rendered an MP4 (exit ${res.status})`);
  if (res.status !== 0) console.error(res.stderr.slice(-800));
  return { path: out, events };
}

function frame(mp4: string, t: number, png: string) {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", mp4, "-frames:v", "1", png]);
}

/** Mean luma (0–255) of a pixel box at output time t. */
function luma(mp4: string, t: number, box: { x: number; y: number; w: number; h: number }): number {
  const buf = execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", mp4, "-frames:v", "1",
    "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y},scale=1:1:flags=area`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  return buf[0];
}

function probe(mp4: string): { video: number; audio: number } {
  const j = JSON.parse(execFileSync(FFPROBE, ["-v", "quiet", "-print_format", "json", "-show_streams", mp4], { encoding: "utf8" }));
  const d = (type: string) => Number(j.streams.find((s: { codec_type: string }) => s.codec_type === type)?.duration ?? 0);
  return { video: d("video"), audio: d("audio") };
}

const ctx = (project: object, dur: number, over: object = {}) => ({
  project, moments: [] as DetectedMoment[], layers: {}, sourceDuration: dur, playhead: 0, selection: {}, recentElementIds: [] as string[], ...over,
});
const stateFor = (moments: DetectedMoment[], dur: number, transcript: Transcript) =>
  ({ moments, sourceDuration: dur, canvasWidth: W, canvasHeight: H, transcript });

// ── Scenario A: animated lower third + revision ─────────────────────────────
{
  const DUR = 8;
  const src = source("src-a.mp4", DUR);
  const transcript = transcriptOf([{ start: 1.2, end: 4.0, text: "Hi, I'm Sarah Chen, head of design at Lumen." }]);
  const project = { analysis: { transcript, detectedMoments: [] } };

  const p1 = parseEditRequest("Add an animated lower third when the speaker introduces herself", ctx(project, DUR));
  check(p1.kind === "commands", "A: draft request understood locally");
  const r1 = p1.kind === "commands" ? applyEditCommands(stateFor([], DUR, transcript), p1.commands, "verify-a1") : null;
  const lt = r1?.ok ? r1.moments[0] : null;
  check(!!lt && lt.textOverlay?.text === "Sarah Chen · Head of Design at Lumen", `A: lower third text from the introduction ("${lt?.textOverlay?.text}")`);
  check(!!lt && lt.startTime >= 1.2 && lt.startTime < 2, `A: placed at the introduction (${lt?.startTime}s)`);

  const p2 = parseEditRequest("Move it to the top left and delay it half a second", ctx(project, DUR, { moments: r1?.ok ? r1.moments : [], recentElementIds: lt ? [lt.id] : [] }));
  const r2 = p2.kind === "commands" && r1?.ok ? applyEditCommands(stateFor(r1.moments, DUR, transcript), p2.commands, "verify-a2") : null;
  const lt2 = r2?.ok ? r2.moments[0] : null;
  check(!!lt && !!lt2 && Math.abs(lt2.startTime - (lt.startTime + 0.5)) < 1e-6, "A: revision delayed the graphic by exactly 0.5s");

  if (lt && lt2 && r1?.ok && r2?.ok) {
    const draft = render("A-draft", src, DUR, r1.moments);
    const revised = render("A-revised", src, DUR, r2.moments);
    // Thin strips inside each plate's top padding — above the white text, so
    // the sample sees only the plate (or, when absent, the raw test pattern).
    const bottomLeft = { x: 110, y: 617, w: 480, h: 4 };
    const topLeft = { x: 110, y: 60, w: 480, h: 4 };
    const t = 3.0; // after the 0.9s slide-in has settled
    const plain = luma(src, t, topLeft);
    // The 72%-black plate darkens whatever is under it.
    check(luma(draft.path, t, bottomLeft) < luma(src, t, bottomLeft) - 40, "A: draft export — plate drawn bottom-left");
    check(luma(revised.path, t, topLeft) < plain - 40, "A: revised export — plate drawn top-left");
    check(Math.abs(luma(revised.path, t, bottomLeft) - luma(src, t, bottomLeft)) < 8, "A: revised export — bottom-left is clear again");
    const between = (lt.startTime + lt2.startTime) / 2 + 0.05;
    check(Math.abs(luma(revised.path, between, topLeft) - luma(src, between, topLeft)) < 8, `A: revised export — not on screen yet at ${between.toFixed(2)}s (delayed)`);
    for (const [name, p] of [["A-draft", draft.path], ["A-revised", revised.path]] as const) frame(p, t, join(OUT, `${name}-t${t}.png`));
  }
}

// ── Scenario B: interview — remove the repeated answer, add captions ────────
{
  const DUR = 30;
  const src = source("src-b.mp4", DUR);
  const transcript = transcriptOf([
    { start: 2, end: 5.2, text: "Hi, I'm Sarah Chen, head of design at Lumen." },
    { start: 10, end: 15.6, text: "We rebuilt the onboarding flow because new users kept getting lost on the second screen." },
    { start: 18, end: 23.6, text: "We rebuilt the onboarding flow because new users kept getting lost on that second screen." },
    { start: 25, end: 28, text: "The result was a forty percent lift in activation." },
  ]);
  const project = { analysis: { transcript, detectedMoments: [] } };
  const p = parseEditRequest("Remove the repeated answer and add captions", ctx(project, DUR));
  check(p.kind === "commands", "B: request understood locally");
  const r = p.kind === "commands" ? applyEditCommands(stateFor([], DUR, transcript), p.commands, "verify-b") : null;
  if (r?.ok) {
    const cut = r.moments.find((m) => m.effectType === "cut")!;
    check(cut.startTime <= 10 && cut.startTime > 5.2 && cut.endTime < 18 && cut.endTime >= 17.5, `B: cut removes the first take between words (${cut.startTime}–${cut.endTime})`);
    const map = buildTimelineMap(r.moments, DUR);
    const out = render("B-interview", src, DUR, r.moments);
    const pr = probe(out.path);
    check(Math.abs(pr.video - map.outputDuration) < 0.15, `B: export is ${pr.video.toFixed(2)}s = 30s − ${map.totalRemoved.toFixed(2)}s removed`);
    check(pr.audio > 0 && Math.abs(pr.audio - pr.video) < 0.15, `B: audio track runs the full length (${pr.audio.toFixed(2)}s)`);
    check(out.events.includes("audio-verify"), "B: worker verified the audio after render");
    // The kept take starts right after the cut in OUTPUT time; its caption must be on screen there.
    const keptAtOutput = cut.startTime + 1.0;
    const captionBand = { x: 300, y: 550, w: 680, h: 4 };
    frame(out.path, keptAtOutput, join(OUT, "B-kept-take-caption.png"));
    const withCaption = luma(out.path, keptAtOutput, captionBand);
    // Same SOURCE instant in the untouched upload (output 10.85s plays source ~18.75s).
    const noCaptionSrc = luma(src, keptAtOutput + map.totalRemoved, captionBand);
    check(withCaption < noCaptionSrc - 40, "B: the kept take is captioned at its new position (caption band differs from the source)");
  }
}

console.log(`\nOutputs + frames: ${OUT}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All assistant export checks passed.");
