/**
 * Render a saved project document to an MP4 with the worker render CLI — the
 * same renderer the desktop export spawns and the Cloud Run worker runs.
 *
 *   node --import ./tests/register-resolver.mjs scripts/render-project-json.mts <doc.json> <source.mp4> <out.mp4>
 *
 * Reads `analysis.detectedMoments`, `effectsSettings`, `sourceCrop` and the
 * source dimensions off the document, exactly as the export job builder does.
 * Used by the verification harness when an in-browser export can't be
 * captured; the output is what a cloud export of that project would produce.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema";

const [, , docPath, sourcePath, outPath] = process.argv;
if (!docPath || !sourcePath || !outPath) throw new Error("usage: render-project-json <doc.json> <source.mp4> <out.mp4>");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(REPO, "services", "export-worker");
const CLI = join(WORKER, "dist", "cli.js");
if (!existsSync(CLI)) throw new Error("services/export-worker/dist/cli.js missing — run `npm run worker:build` first.");
const FFMPEG = process.env.FRAMEVO_FFMPEG_PATH || (createRequire(join(WORKER, "package.json"))("ffmpeg-static") as string);

const doc = JSON.parse(readFileSync(docPath, "utf8"));
// `ffmpeg -i <file>` with no output exits 1 by design; the stream info is on stderr.
let probe = "";
try {
  execFileSync(FFMPEG, ["-hide_banner", "-i", sourcePath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
  probe = String((err as { stderr?: string }).stderr ?? "");
}
const dims = /(\d{3,5})x(\d{3,5})/.exec(probe);
const sourceWidth = doc.width || Number(dims?.[1]) || 1920;
const sourceHeight = doc.height || Number(dims?.[2]) || 1080;
const assets = (doc.assets ?? []) as { id: string; url: string; path?: string }[];
const spec = {
  sourcePath,
  // Harness convention: an asset's `path` (or a file-path `url`) is a local file.
  assets: assets.map((a) => ({ id: a.id, path: a.path ?? a.url })),
  outputPath: outPath,
  crf: 20,
  preset: "veryfast",
  normalizeEnabled: false,
  serializedRecipe: {
    sourceWidth,
    sourceHeight,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: doc.duration,
    moments: doc.analysis?.detectedMoments ?? [],
    effects: { ...DEFAULT_EFFECTS_SETTINGS, ...(doc.effectsSettings ?? {}) },
    sourceCrop: doc.sourceCrop ?? null,
    applyWatermark: false,
    sequence: doc.sequence ?? null,
    assets,
    speech: doc.speech ?? [],
  },
};
const specPath = outPath.replace(/\.mp4$/i, "") + ".spec.json";
writeFileSync(specPath, JSON.stringify(spec));
const res = spawnSync(process.execPath, [CLI, specPath], { encoding: "utf8", env: { ...process.env, FRAMEVO_FFMPEG_PATH: FFMPEG } });
const events = res.stdout.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).type as string; } catch { return "?"; } });
console.log(`render exit ${res.status}: ${[...new Set(events)].join(",")}`);
if (res.status !== 0) {
  console.error(res.stderr.slice(-1200));
  process.exit(1);
}
