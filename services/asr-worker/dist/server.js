import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/server-only-stub.ts
var init_server_only_stub = __esm({
  "src/server-only-stub.ts"() {
    "use strict";
  }
});

// ../../src/lib/firebase/admin.ts
import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
function resolveServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      const json2 = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
      return cert(json2);
    } catch (err) {
      console.error("[firebase-admin] Failed to parse FIREBASE_SERVICE_ACCOUNT_B64", err);
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_B64 \u2014 must be base64 JSON");
    }
  }
  return applicationDefault();
}
function getAdmin() {
  if (!app) {
    if (getApps().length) {
      app = getApps()[0];
    } else {
      const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
      const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
      app = initializeApp({
        credential: resolveServiceAccount(),
        projectId,
        storageBucket
      });
    }
  }
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  return { app, auth, db, storage };
}
var app;
var init_admin = __esm({
  "../../src/lib/firebase/admin.ts"() {
    "use strict";
    init_server_only_stub();
    app = null;
  }
});

// ../../src/lib/transcript/audio-extract.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function configuredFfmpeg() {
  return (process.env.FFMPEG_PATH ?? "").trim().replace(/^["']|["']$/g, "").trim();
}
function ffmpegPath() {
  const p = configuredFfmpeg();
  return p.length > 0 ? p : "ffmpeg";
}
async function extractAudioToFlac(input) {
  const { videoUrl, durationSec, maxDurationSec } = input;
  if (!videoUrl) throw new Error("no source url for audio extraction");
  const cap = Math.max(1, Math.min(durationSec || maxDurationSec, maxDurationSec));
  const timeoutMs = input.timeoutMs ?? 12e4;
  const dir = await mkdtemp(join(tmpdir(), "framevo-asr-"));
  const outPath = join(dir, "audio.flac");
  const cleanup = async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
    }
  };
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoUrl,
    "-vn",
    // drop video
    "-ac",
    String(EXTRACT_CHANNELS),
    "-ar",
    String(EXTRACT_SAMPLE_RATE),
    "-t",
    String(cap),
    "-c:a",
    "flac",
    outPath
  ];
  const ffmpeg = ffmpegPath();
  const configured = configuredFfmpeg();
  if (configured && /[\\/]/.test(configured) && !existsSync(configured)) {
    throw new Error(
      `FFMPEG_PATH is set to "${configured}" but no file exists there. Point it at the ffmpeg executable (e.g. \u2026\\bin\\ffmpeg.exe, not the folder) and RESTART the dev server (Next.js loads .env only at startup).`
    );
  }
  console.info("[asr:extract-audio]", {
    ffmpeg,
    configured: configured || "(unset \u2192 PATH lookup)",
    capSec: cap,
    durationSec
  });
  try {
    await new Promise((resolve, reject) => {
      let stderr = "";
      let done = false;
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        finish(new Error("audio extraction cancelled"));
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        finish(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (input.signal) {
        if (input.signal.aborted) return onAbort();
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stderr?.on("data", (d) => {
        stderr += String(d);
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on(
        "error",
        (e) => finish(
          new Error(
            e && e.code === "ENOENT" ? `ffmpeg not found at "${ffmpeg}". Set FFMPEG_PATH to the ffmpeg executable, then RESTART the dev server \u2014 Next.js loads .env only at startup, so a path added while it was running is not picked up.` : `ffmpeg failed to start: ${e.message}`
          )
        )
      );
      child.on(
        "close",
        (code) => finish(code === 0 ? void 0 : new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`))
      );
    });
    const st = await stat(outPath).catch(() => null);
    if (!st || st.size === 0) {
      await cleanup();
      throw new Error("no audio track extracted");
    }
    return { path: outPath, bytes: st.size, durationSec: cap, cleanup };
  } catch (err) {
    await cleanup();
    throw err instanceof Error ? err : new Error("audio extraction failed");
  }
}
var EXTRACT_SAMPLE_RATE, EXTRACT_CHANNELS, SYNC_AUDIO_LIMIT_SEC;
var init_audio_extract = __esm({
  "../../src/lib/transcript/audio-extract.ts"() {
    "use strict";
    EXTRACT_SAMPLE_RATE = 16e3;
    EXTRACT_CHANNELS = 1;
    SYNC_AUDIO_LIMIT_SEC = 55;
  }
});

// ../../src/lib/transcript/gcp-auth.ts
import { GoogleAuth } from "google-auth-library";
function authClient() {
  if (cached) return cached;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    const json2 = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    cached = new GoogleAuth({
      credentials: { client_email: json2.client_email, private_key: json2.private_key },
      projectId: json2.project_id,
      scopes: SCOPES
    });
  } else {
    cached = new GoogleAuth({ scopes: SCOPES });
  }
  return cached;
}
async function getCloudAccessToken() {
  const client = await authClient().getClient();
  const res = await client.getAccessToken();
  const token = typeof res === "string" ? res : res.token;
  if (!token) throw new Error("could not obtain a GCP access token (check credentials)");
  return token;
}
var SCOPES, cached;
var init_gcp_auth = __esm({
  "../../src/lib/transcript/gcp-auth.ts"() {
    "use strict";
    SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
    cached = null;
  }
});

// ../../src/lib/transcript/speech-parse.ts
function speechHttpError(op, status, body) {
  let apiMessage = "";
  let reason = "";
  try {
    const j = JSON.parse(body);
    apiMessage = j.error?.message ?? "";
    reason = j.error?.status ?? j.error?.details?.find((d) => d.reason)?.reason ?? "";
  } catch {
  }
  if (status === 403 && (/has not been used|SERVICE_DISABLED|is disabled/i.test(apiMessage) || reason === "SERVICE_DISABLED")) {
    const project = apiMessage.match(/project (\d+)/i)?.[1];
    const url = project ? `https://console.developers.google.com/apis/api/speech.googleapis.com/overview?project=${project}` : "https://console.cloud.google.com/apis/library/speech.googleapis.com";
    return new Error(
      `Cloud Speech-to-Text API is not enabled${project ? ` for project ${project}` : ""}. Enable it at ${url}, wait ~1 minute for it to propagate, then re-analyze.`
    );
  }
  const detail = apiMessage.trim() || body.replace(/\s+/g, " ").trim().slice(0, 200) || `HTTP ${status}`;
  return new Error(`Speech-to-Text ${op} failed (${status}): ${detail}`);
}
function parseDuration(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/s$/, ""));
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object") {
    const o = v;
    const s = Number(o.seconds ?? 0);
    const nanos = Number(o.nanos ?? 0);
    return (Number.isFinite(s) ? s : 0) + (Number.isFinite(nanos) ? nanos / 1e9 : 0);
  }
  return 0;
}
function parseSpeechResults(results) {
  const segments = [];
  const words = [];
  const texts = [];
  let language;
  let prevEnd = 0;
  for (let i = 0; i < (results?.length ?? 0); i++) {
    const r = results[i];
    const alt = r.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (!text) continue;
    if (!language && r.languageCode) language = r.languageCode;
    const segWords = (alt?.words ?? []).filter((w) => (w.word ?? "").trim().length > 0).map((w) => ({
      word: (w.word ?? "").trim(),
      startTime: parseDuration(w.startTime),
      endTime: parseDuration(w.endTime),
      ...typeof w.confidence === "number" ? { confidence: w.confidence } : {}
    }));
    let start;
    let end;
    if (segWords.length > 0) {
      start = segWords[0].startTime;
      end = segWords[segWords.length - 1].endTime;
    } else {
      start = prevEnd;
      end = parseDuration(r.resultEndTime) || prevEnd;
    }
    if (!(end > start)) end = start + 0.5;
    prevEnd = end;
    segments.push({
      id: `seg-${i}`,
      startTime: start,
      endTime: end,
      text,
      ...typeof alt?.confidence === "number" ? { confidence: alt.confidence } : {}
    });
    words.push(...segWords);
    texts.push(text);
  }
  return { text: texts.join(" ").trim(), language, segments, words };
}
var init_speech_parse = __esm({
  "../../src/lib/transcript/speech-parse.ts"() {
    "use strict";
  }
});

// ../../src/lib/transcript/google-speech-provider.ts
var google_speech_provider_exports = {};
__export(google_speech_provider_exports, {
  createGoogleSpeechProvider: () => createGoogleSpeechProvider
});
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
function num(env, fallback) {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function headSizeMb(url, signal) {
  try {
    const r = await fetch(url, { method: "HEAD", signal });
    const len = Number(r.headers.get("content-length") || 0);
    return len > 0 ? len / (1024 * 1024) : null;
  } catch {
    return null;
  }
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("cancelled"));
      },
      { once: true }
    );
  });
}
async function recognizeSync(token, config, contentBase64, signal) {
  const res = await fetch(`${SPEECH_API}/speech:recognize`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ config, audio: { content: contentBase64 } }),
    signal
  });
  if (!res.ok) {
    throw speechHttpError("recognize", res.status, await res.text().catch(() => ""));
  }
  return (await res.json()).results ?? [];
}
async function recognizeLong(token, config, gcsUri, timeoutMs, signal) {
  const start = await fetch(`${SPEECH_API}/speech:longrunningrecognize`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ config, audio: { uri: gcsUri } }),
    signal
  });
  if (!start.ok) {
    throw speechHttpError("longrunningrecognize", start.status, await start.text().catch(() => ""));
  }
  const opName = (await start.json()).name;
  if (!opName) throw new Error("no long-running operation name returned");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3e3, signal);
    const op = await fetch(`${SPEECH_API}/operations/${encodeURIComponent(opName)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal
    });
    if (!op.ok) throw new Error(`speech operation poll ${op.status}`);
    const json2 = await op.json();
    if (json2.done) {
      if (json2.error) throw new Error(`speech LRO failed: ${json2.error.message ?? "unknown"}`);
      return json2.response?.results ?? [];
    }
  }
  throw new Error("speech transcription timed out");
}
function createGoogleSpeechProvider() {
  const model = process.env.TRANSCRIPT_MODEL || "latest_long";
  return {
    name: "google_speech",
    model,
    async transcribeVideo(input) {
      const maxDurationSec = input.maxDurationSeconds ?? num(process.env.TRANSCRIPT_MAX_DURATION_SECONDS, 900);
      const maxFileMb = num(process.env.TRANSCRIPT_MAX_FILE_MB, 260);
      const timeoutMs = num(process.env.TRANSCRIPT_TIMEOUT_MS, 12e4);
      if (input.durationSeconds && input.durationSeconds > maxDurationSec) {
        return { status: "unavailable", error: `media exceeds ${maxDurationSec}s ASR limit` };
      }
      const sizeMb = await headSizeMb(input.videoUrl, input.signal);
      if (sizeMb != null && sizeMb > maxFileMb) {
        return { status: "unavailable", error: `media ${Math.round(sizeMb)}MB exceeds ${maxFileMb}MB ASR limit` };
      }
      const createdAt = Date.now();
      const extracted = await extractAudioToFlac({
        videoUrl: input.videoUrl,
        durationSec: input.durationSeconds ?? maxDurationSec,
        maxDurationSec,
        signal: input.signal
      });
      let gcsObject = null;
      try {
        const token = await getCloudAccessToken();
        const languageCode = input.languageCode?.trim() || process.env.TRANSCRIPT_LANGUAGE || "en-US";
        const alternativeLanguageCodes = (input.alternativeLanguageCodes ?? []).filter((c) => c && c.toLowerCase() !== languageCode.toLowerCase()).slice(0, 3);
        const config = {
          encoding: "FLAC",
          sampleRateHertz: EXTRACT_SAMPLE_RATE,
          audioChannelCount: EXTRACT_CHANNELS,
          languageCode,
          ...alternativeLanguageCodes.length ? { alternativeLanguageCodes } : {},
          enableAutomaticPunctuation: true,
          enableWordTimeOffsets: true,
          model
        };
        const useLong = extracted.durationSec > SYNC_AUDIO_LIMIT_SEC || extracted.bytes > INLINE_BYTES_LIMIT;
        console.info("[asr:google-speech:start]", {
          model,
          languageCode: config.languageCode,
          alternativeLanguageCodes: config.alternativeLanguageCodes ?? [],
          audioSec: extracted.durationSec,
          audioBytes: extracted.bytes,
          mode: useLong ? "longrunning" : "sync"
        });
        let results;
        if (!useLong) {
          const content = (await readFile(extracted.path)).toString("base64");
          results = await recognizeSync(token, config, content, input.signal);
        } else {
          const { storage } = getAdmin();
          const bucket = storage.bucket();
          gcsObject = `transcripts/tmp/asr-${createdAt}-${randomUUID()}.flac`;
          const buf = await readFile(extracted.path);
          await bucket.file(gcsObject).save(buf, { contentType: "audio/flac", resumable: false });
          results = await recognizeLong(token, config, `gs://${bucket.name}/${gcsObject}`, timeoutMs, input.signal);
        }
        const parsed = parseSpeechResults(results);
        const detectedLanguage = parsed.language || languageCode;
        console.info("[asr:google-speech:result]", {
          status: "complete",
          requestedLanguage: languageCode,
          detectedLanguage,
          segments: parsed.segments.length,
          words: parsed.words.length,
          durationAnalyzed: extracted.durationSec
        });
        return {
          status: "complete",
          text: parsed.text,
          language: detectedLanguage,
          segments: parsed.segments,
          words: parsed.words,
          provider: {
            provider: "google_speech",
            model,
            createdAt,
            durationAnalyzed: extracted.durationSec,
            languageCode
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "speech transcription failed";
        console.warn("[asr:google-speech:error]", { message });
        return { status: "failed", error: message };
      } finally {
        await extracted.cleanup();
        if (gcsObject) {
          try {
            await getAdmin().storage.bucket().file(gcsObject).delete({ ignoreNotFound: true });
          } catch {
          }
        }
      }
    }
  };
}
var SPEECH_API, INLINE_BYTES_LIMIT;
var init_google_speech_provider = __esm({
  "../../src/lib/transcript/google-speech-provider.ts"() {
    "use strict";
    init_admin();
    init_audio_extract();
    init_gcp_auth();
    init_speech_parse();
    SPEECH_API = "https://speech.googleapis.com/v1";
    INLINE_BYTES_LIMIT = 95e5;
  }
});

// src/server.ts
import { createServer } from "node:http";

// ../../src/lib/transcript/run-transcription.ts
init_admin();
import { FieldValue as FieldValue2 } from "firebase-admin/firestore";

// ../../src/lib/firebase/sanitize.ts
function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === void 0) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

// ../../src/lib/transcript/provider.ts
async function getTranscriptProvider() {
  const kind = process.env.TRANSCRIPT_PROVIDER?.trim().toLowerCase();
  if (!kind || kind === "none" || kind === "off") return null;
  if (kind === "google_speech" || kind === "google-speech" || kind === "google") {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (!projectId) {
      console.warn("[transcript:analysis] google_speech selected but no project id \u2014 unavailable");
      return null;
    }
    const { createGoogleSpeechProvider: createGoogleSpeechProvider2 } = await Promise.resolve().then(() => (init_google_speech_provider(), google_speech_provider_exports));
    return createGoogleSpeechProvider2();
  }
  return null;
}

// ../../src/lib/transcript/transcribe.ts
async function transcribeVideo(input) {
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
      words: t.words?.length ?? 0
    });
    return t;
  } catch (err) {
    console.warn("[transcript:analysis] failed", err);
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "transcription failed"
    };
  }
}

// ../../src/lib/render/text-shaping.ts
var RTL_SCRIPTS = /* @__PURE__ */ new Set(["arabic", "hebrew"]);
function scriptOfCodePoint(cp) {
  if (cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122) return "latin";
  if (cp >= 192 && cp <= 591 || cp >= 7680 && cp <= 7935) return "latin";
  if (cp >= 880 && cp <= 1023 || cp >= 7936 && cp <= 8191) return "greek";
  if (cp >= 1024 && cp <= 1327 || cp >= 7296 && cp <= 7311 || cp >= 11744 && cp <= 11775) return "cyrillic";
  if (cp >= 1424 && cp <= 1535 || cp >= 64285 && cp <= 64335) return "hebrew";
  if (cp >= 1536 && cp <= 1791 || cp >= 1872 && cp <= 1919 || cp >= 2208 && cp <= 2303 || cp >= 64336 && cp <= 65023 || cp >= 65136 && cp <= 65279)
    return "arabic";
  if (cp >= 2304 && cp <= 2431 || cp >= 43232 && cp <= 43263) return "devanagari";
  if (cp >= 3584 && cp <= 3711) return "thai";
  if (cp >= 12352 && cp <= 12543 || // hiragana + katakana
  cp >= 12592 && cp <= 12687 || // Hangul compatibility jamo
  cp >= 12784 && cp <= 12799 || // katakana phonetic extensions
  cp >= 13312 && cp <= 19903 || // CJK ext A
  cp >= 19968 && cp <= 40959 || // CJK unified
  cp >= 44032 && cp <= 55215 || // Hangul syllables
  cp >= 63744 && cp <= 64255 || // CJK compat
  cp >= 65381 && cp <= 65439 || // halfwidth katakana
  cp >= 131072 && cp <= 191471)
    return "cjk";
  return null;
}
function analyzeText(text) {
  let rtlCount = 0;
  let ltrCount = 0;
  let firstStrong = null;
  const counts = {
    latin: 0,
    cyrillic: 0,
    greek: 0,
    arabic: 0,
    hebrew: 0,
    devanagari: 0,
    cjk: 0,
    thai: 0,
    unknown: 0
  };
  for (const ch of Array.from(text ?? "")) {
    const cp = ch.codePointAt(0);
    if (cp === void 0) continue;
    const s = scriptOfCodePoint(cp);
    if (!s) continue;
    counts[s]++;
    const rtl = RTL_SCRIPTS.has(s);
    if (rtl) rtlCount++;
    else ltrCount++;
    if (firstStrong === null) firstStrong = rtl ? "rtl" : "ltr";
  }
  let script = "unknown";
  let best = 0;
  for (const s of Object.keys(counts)) {
    if (s === "unknown") continue;
    if (counts[s] > best) {
      best = counts[s];
      script = s;
    }
  }
  const direction = firstStrong ?? "ltr";
  return { script, direction, rtlCount, ltrCount };
}
function textDirection(text) {
  return analyzeText(text).direction;
}
var EMOJI_FALLBACK = `"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"`;
var LATIN_BASE = `"Noto Sans", -apple-system, "Segoe UI", system-ui, "Liberation Sans", Arial`;
var FONT_FAMILY_BY_SCRIPT = {
  latin: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  cyrillic: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  greek: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  unknown: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  arabic: `"Noto Sans Arabic", "Noto Naskh Arabic", "Geeza Pro", "Segoe UI", Tahoma, ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  hebrew: `"Noto Sans Hebrew", "Segoe UI", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  devanagari: `"Noto Sans Devanagari", "Nirmala UI", "Segoe UI", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  cjk: `"Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  thai: `"Noto Sans Thai", "Leelawadee UI", "Segoe UI", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`
};

// ../../src/lib/analysis/caption-generator.ts
function captionStyleForVideoType(v) {
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
var MAX_WORDS_PER_LINE = 7;
var MAX_LINE_SEC = 3.2;
var MIN_LINE_SEC = 0.6;
var MAX_CAPTIONS = 600;
function wordsInSegment(seg, all) {
  if (!all || all.length === 0) return [];
  const eps = 0.05;
  return all.filter((w) => w.startTime >= seg.startTime - eps && w.endTime <= seg.endTime + eps);
}
function splitSegment(seg, all) {
  const text = seg.text.trim();
  if (!text) return [];
  const segWords = wordsInSegment(seg, all);
  if (segWords.length > 0) {
    const lines = [];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      lines.push({
        text: cur.map((w) => w.word).join(" ").trim(),
        start: cur[0].startTime,
        end: cur[cur.length - 1].endTime,
        words: cur
      });
      cur = [];
    };
    for (const w of segWords) {
      const wouldSpan = cur.length ? w.endTime - cur[0].startTime : 0;
      if (cur.length >= MAX_WORDS_PER_LINE || cur.length && wouldSpan > MAX_LINE_SEC) flush();
      cur.push(w);
    }
    flush();
    return lines;
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  const dur = Math.max(0, seg.endTime - seg.startTime);
  const chunks = [];
  for (let i = 0; i < tokens.length; i += MAX_WORDS_PER_LINE) {
    chunks.push(tokens.slice(i, i + MAX_WORDS_PER_LINE));
  }
  if (chunks.length === 0) return [];
  const per = dur / chunks.length;
  return chunks.map((c, i) => ({
    text: c.join(" "),
    start: seg.startTime + i * per,
    end: seg.startTime + (i + 1) * per
  }));
}
function generateCaptionMoments(transcript, videoType) {
  if (!transcript || transcript.status !== "complete" || !transcript.segments?.length) {
    return { moments: [], truncated: false };
  }
  const stylePreset = captionStyleForVideoType(videoType);
  const lang = transcript.language ?? void 0;
  const moments = [];
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
          reason: "Transcript-derived captions."
        },
        captions: {
          text: line.text,
          stylePreset,
          position: "bottom",
          direction: textDirection(line.text),
          ...lang ? { lang } : {},
          ...line.words && line.words.length ? {
            words: line.words.map((w) => ({
              text: w.word,
              start: w.startTime,
              end: w.endTime
            }))
          } : {}
        }
      });
    }
  }
  return { moments, truncated };
}

// ../../src/lib/transcript/transcription-job.ts
var PROCESSING_STALE_MS = 10 * 60 * 1e3;
function sourceFingerprint(source) {
  const key = source.storagePath || source.originalVideoUrl || "";
  const size = source.fileSize ?? "";
  const dur = source.duration != null ? Math.round(source.duration) : "";
  return `${key}|${size}|${dur}`;
}
function transcriptionFingerprint(input) {
  const langKey = input.languageMode === "selected" ? (input.languageCode ?? "").toLowerCase() : "auto";
  return [
    sourceFingerprint(input.source),
    input.languageMode,
    langKey,
    input.model ?? "",
    input.provider ?? ""
  ].join("|");
}

// ../../src/lib/usage/plan.ts
var GB = 1024 * 1024 * 1024;
var PLAN_DEFS = {
  free: {
    tier: "free",
    name: "Free plan",
    storageBytes: 5 * GB,
    ctaLabel: "Upgrade"
  },
  // Pro is the mid paid tier ($25); Creator is the top team tier ($49).
  pro: {
    tier: "pro",
    name: "Pro plan",
    storageBytes: 50 * GB,
    ctaLabel: "Manage"
  },
  creator: {
    tier: "creator",
    name: "Creator plan",
    storageBytes: 500 * GB,
    ctaLabel: "Manage"
  }
};
function normalizePlan(raw) {
  if (raw === "pro" || raw === "creator") return raw;
  return "free";
}

// ../../src/lib/usage/caption-quota.ts
var PLAN_DISPLAY_NAME = {
  free: "Free",
  pro: "Pro",
  creator: "Creator"
};
var CAPTION_PLAN_LIMITS = {
  free: { captionMinutesPerMonth: 10, maxCaptionVideoSeconds: 5 * 60 },
  pro: { captionMinutesPerMonth: 150, maxCaptionVideoSeconds: 15 * 60 },
  creator: { captionMinutesPerMonth: 300, maxCaptionVideoSeconds: 30 * 60 }
};
function captionAllowanceSeconds(plan) {
  return CAPTION_PLAN_LIMITS[plan].captionMinutesPerMonth * 60;
}
function exceedsCaptionVideoLimit(plan, durationSeconds) {
  return typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > CAPTION_PLAN_LIMITS[plan].maxCaptionVideoSeconds;
}
function addMonthsUtcClamped(ms, months) {
  const d = new Date(ms);
  const targetMonth = d.getUTCMonth() + months;
  const daysInTarget = new Date(
    Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)
  ).getUTCDate();
  return Date.UTC(
    d.getUTCFullYear(),
    targetMonth,
    Math.min(d.getUTCDate(), daysInTarget),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds()
  );
}
function resolveCaptionPeriod(input) {
  const { plan, renewsAtMs, nowMs } = input;
  if (plan !== "free" && typeof renewsAtMs === "number" && Number.isFinite(renewsAtMs)) {
    let start = renewsAtMs;
    let guard = 0;
    while (start > nowMs && guard++ < 1200) start = addMonthsUtcClamped(start, -1);
    guard = 0;
    while (addMonthsUtcClamped(start, 1) <= nowMs && guard++ < 1200) {
      start = addMonthsUtcClamped(start, 1);
    }
    const end = addMonthsUtcClamped(start, 1);
    if (start <= nowMs && nowMs < end) {
      const d = new Date(start);
      const id = `sub-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
      return { periodId: id, startMs: start, endMs: end, anchor: "subscription" };
    }
  }
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    periodId: `cal-${y}-${String(m + 1).padStart(2, "0")}`,
    startMs: Date.UTC(y, m, 1),
    endMs: Date.UTC(y, m + 1, 1),
    anchor: "calendar"
  };
}
function initialCaptionUsageDoc(input) {
  const allowance = captionAllowanceSeconds(input.plan);
  return {
    plan: input.plan,
    periodId: input.period.periodId,
    billingPeriodStartMs: input.period.startMs,
    billingPeriodEndMs: input.period.endMs,
    allowanceSeconds: allowance,
    usedSeconds: 0,
    reservedSeconds: 0,
    remainingSeconds: allowance,
    reservations: {},
    finalizedKeys: {},
    updatedAtMs: input.nowMs
  };
}
function captionRemainingSeconds(s) {
  return Math.max(
    0,
    (s.allowanceSeconds ?? 0) - Math.max(0, s.usedSeconds ?? 0) - Math.max(0, s.reservedSeconds ?? 0)
  );
}
function recompute(doc, nowMs) {
  return { ...doc, remainingSeconds: captionRemainingSeconds(doc), updatedAtMs: nowMs };
}
function applyCaptionCommit(doc, input) {
  const { key, nowMs, fallbackSeconds } = input;
  if (doc.finalizedKeys[key]) return doc;
  const res = doc.reservations[key];
  if (res) {
    const { [key]: _gone, ...rest } = doc.reservations;
    return recompute(
      {
        ...doc,
        reservations: rest,
        reservedSeconds: Math.max(0, doc.reservedSeconds - res.seconds),
        usedSeconds: doc.usedSeconds + res.seconds,
        finalizedKeys: { ...doc.finalizedKeys, [key]: nowMs }
      },
      nowMs
    );
  }
  const late = Math.max(0, Math.ceil(fallbackSeconds ?? 0));
  return recompute(
    {
      ...doc,
      usedSeconds: doc.usedSeconds + late,
      finalizedKeys: { ...doc.finalizedKeys, [key]: nowMs }
    },
    nowMs
  );
}
function applyCaptionRelease(doc, input) {
  const { key, nowMs } = input;
  if (doc.finalizedKeys[key]) return doc;
  const res = doc.reservations[key];
  if (!res) return doc;
  const { [key]: _gone, ...rest } = doc.reservations;
  return recompute(
    {
      ...doc,
      reservations: rest,
      reservedSeconds: Math.max(0, doc.reservedSeconds - res.seconds),
      finalizedKeys: { ...doc.finalizedKeys, [key]: nowMs }
    },
    nowMs
  );
}
function shouldCommitCaptionUsage(status) {
  return status === "complete";
}
var CAPTION_RESERVATION_TTL_MS = 45 * 60 * 1e3;
function perVideoCaptionLimitMessage(plan) {
  const limits = CAPTION_PLAN_LIMITS[plan];
  return `This video exceeds the ${Math.round(limits.maxCaptionVideoSeconds / 60)}-minute auto-caption limit for ${PLAN_DISPLAY_NAME[plan]}.`;
}

// ../../src/lib/usage/caption-ledger.ts
import { FieldValue } from "firebase-admin/firestore";
function logCaptionQuota(event, fields) {
  console.info(`[caption-quota:${event}]`, fields);
}
function ledgerRef(db, uid, periodId) {
  return db.collection("users").doc(uid).collection("captionUsage").doc(periodId);
}
async function resolvePlanAndPeriod(db, uid, nowMs, tx) {
  const userRef = db.collection("users").doc(uid);
  const subRef = db.collection("subscriptions").doc(uid);
  const [userSnap, subSnap] = tx ? await Promise.all([tx.get(userRef), tx.get(subRef)]) : await Promise.all([userRef.get(), subRef.get()]);
  const plan = normalizePlan(userSnap.data()?.plan);
  const renews = subSnap.data()?.renewsAt;
  const renewsAtMs = typeof renews === "number" && Number.isFinite(renews) ? renews : null;
  return { plan, period: resolveCaptionPeriod({ plan, renewsAtMs, nowMs }) };
}
function readLedger(snap, plan, period, nowMs) {
  if (!snap.exists) {
    return initialCaptionUsageDoc({ plan, period, nowMs });
  }
  const raw = snap.data();
  const base = initialCaptionUsageDoc({ plan, period, nowMs });
  return {
    ...base,
    ...raw,
    allowanceSeconds: raw.allowanceSeconds ?? base.allowanceSeconds,
    usedSeconds: Math.max(0, raw.usedSeconds ?? 0),
    reservedSeconds: Math.max(0, raw.reservedSeconds ?? 0),
    reservations: raw.reservations ?? {},
    finalizedKeys: raw.finalizedKeys ?? {}
  };
}
function writeLedger(tx, ref, doc) {
  tx.set(ref, { ...doc, updatedAt: FieldValue.serverTimestamp() });
}
async function commitCaptionUsage(db, input) {
  const { uid, projectId, key, periodId, fallbackSeconds } = input;
  const nowMs = Date.now();
  const summary = await db.runTransaction(async (tx) => {
    const ref = ledgerRef(db, uid, periodId);
    const snap = await tx.get(ref);
    const { plan, period } = await resolvePlanAndPeriod(db, uid, nowMs, tx);
    const doc = readLedger(
      snap,
      plan,
      snap.exists ? { ...period, periodId } : period,
      nowMs
    );
    const next = applyCaptionCommit(doc, { key, nowMs, fallbackSeconds });
    if (next === doc) return null;
    writeLedger(tx, ref, next);
    return { usedSeconds: next.usedSeconds, reservedSeconds: next.reservedSeconds, remainingSeconds: next.remainingSeconds, plan: next.plan };
  });
  if (summary) {
    logCaptionQuota("committed", { uid, projectId, jobId: key, ...summary });
  }
}
async function releaseCaptionReservation(db, input) {
  const { uid, projectId, key, periodId } = input;
  const nowMs = Date.now();
  const summary = await db.runTransaction(async (tx) => {
    const ref = ledgerRef(db, uid, periodId);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const raw = snap.data();
    const doc = {
      ...raw,
      reservations: raw.reservations ?? {},
      finalizedKeys: raw.finalizedKeys ?? {}
    };
    const next = applyCaptionRelease(doc, { key, nowMs });
    if (next === doc) return null;
    writeLedger(tx, ref, next);
    return { reservedSeconds: next.reservedSeconds, remainingSeconds: next.remainingSeconds };
  });
  if (summary) {
    logCaptionQuota("released", { uid, projectId, jobId: key, ...summary });
  }
}
async function verifyCaptionReservation(db, input) {
  const { uid, projectId, key, periodId } = input;
  if (!key || !periodId) return { ok: false, reason: "missing_reservation_key" };
  const snap = await ledgerRef(db, uid, periodId).get();
  const data = snap.exists ? snap.data() : null;
  if (data?.finalizedKeys?.[key]) return { ok: false, reason: "already_finalized" };
  const res = data?.reservations?.[key];
  if (!res) return { ok: false, reason: "reservation_not_found" };
  if (res.projectId !== projectId) return { ok: false, reason: "project_mismatch" };
  return { ok: true };
}

// ../../src/lib/transcript/run-transcription.ts
function wantsCaptions(project) {
  if (project.analysis?.lastRunOptions?.generateCaptions === false) return false;
  const ops = project.analysis?.editRecipe?.operations;
  if (!ops) return true;
  return ops.some((o) => o.category === "captions");
}
function captionVideoType(project) {
  return project.analysis?.editRecipe?.effectiveVideoType ?? project.selectedVideoType ?? "auto";
}
async function processTranscriptionJob(uid, projectId, opts) {
  const { db } = getAdmin();
  const ref = db.collection("users").doc(uid).collection("projects").doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) return { status: "failed", captions: 0 };
  const project = snap.data();
  const existing = project.analysis?.transcript;
  const requestedAt = existing?.requestedAt ?? Date.now();
  const languageMode = existing?.languageMode ?? "auto";
  const requestedLanguageCode = existing?.requestedLanguageCode ?? existing?.language ?? void 0;
  const requestedAlternativeLanguageCodes = existing?.requestedAlternativeLanguageCodes ?? [];
  const langStamp = {
    languageMode,
    ...requestedLanguageCode ? { requestedLanguageCode } : {},
    ...requestedAlternativeLanguageCodes.length ? { requestedAlternativeLanguageCodes } : {}
  };
  const fingerprint = transcriptionFingerprint({
    source: project,
    languageMode,
    languageCode: requestedLanguageCode,
    model: process.env.TRANSCRIPT_MODEL || "latest_long",
    provider: process.env.TRANSCRIPT_PROVIDER?.trim().toLowerCase() || ""
  });
  if (!opts?.forceRetranscribe && existing?.status === "complete" && existing.sourceFingerprint === fingerprint && (existing.segments?.length ?? 0) > 0) {
    return { status: "complete", captions: 0 };
  }
  const usageKey = existing?.usageKey;
  const usagePeriodId = existing?.usagePeriodId;
  const usageSeconds = existing?.usageSeconds;
  const rejectQuota = async (reason, userMessage, skipReason = "reservation_invalid") => {
    logCaptionQuota("blocked", { uid, projectId, jobId: usageKey ?? null, reason });
    if (existing?.status === "processing") {
      await ref.set(
        {
          analysis: {
            transcript: stripUndefined({
              status: "unavailable",
              error: userMessage,
              skipReason,
              ...langStamp,
              sourceFingerprint: fingerprint,
              requestedAt
            })
          },
          updatedAt: FieldValue2.serverTimestamp()
        },
        { merge: true }
      ).catch(() => {
      });
    }
    return { status: "unavailable", captions: 0 };
  };
  if (existing?.status !== "processing") {
    logCaptionQuota("blocked", {
      uid,
      projectId,
      jobId: usageKey ?? null,
      reason: "duplicate_or_stale_delivery"
    });
    return { status: existing?.status ?? "failed", captions: 0 };
  }
  if (existing.sourceFingerprint && existing.sourceFingerprint !== fingerprint) {
    if (usageKey && usagePeriodId) {
      await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId }).catch(() => {
      });
    }
    return rejectQuota(
      "fingerprint_mismatch",
      "The video changed while captions were queued. Re-run the analysis to caption the current video."
    );
  }
  const verdict = await verifyCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId });
  if (!verdict.ok) {
    return rejectQuota(
      verdict.reason,
      "This caption run had no valid usage reservation. Re-run the analysis to caption this video."
    );
  }
  const userSnap = await db.collection("users").doc(uid).get();
  const plan = normalizePlan(userSnap.data()?.plan);
  if (exceedsCaptionVideoLimit(plan, project.duration)) {
    if (usageKey && usagePeriodId) {
      await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId }).catch(() => {
      });
    }
    return rejectQuota("per_video_limit_exceeded", perVideoCaptionLimitMessage(plan), "per_video_limit");
  }
  const usageStamp = {
    ...usageKey ? { usageKey } : {},
    ...usagePeriodId ? { usagePeriodId } : {},
    ...typeof usageSeconds === "number" ? { usageSeconds } : {}
  };
  try {
    const raw = await transcribeVideo({
      videoUrl: project.originalVideoUrl ?? "",
      mimeType: project.mimeType,
      durationSeconds: project.duration,
      languageCode: requestedLanguageCode,
      alternativeLanguageCodes: requestedAlternativeLanguageCodes,
      maxDurationSeconds: CAPTION_PLAN_LIMITS[plan].maxCaptionVideoSeconds
    });
    const transcript = {
      ...raw,
      ...langStamp,
      ...usageStamp,
      sourceFingerprint: fingerprint,
      requestedAt
    };
    let captionMoments = [];
    if (transcript.status === "complete" && wantsCaptions(project)) {
      const current = project.analysis?.detectedMoments ?? [];
      const hasCaptions = current.some((m) => m.effectType === "captions" && m.source !== "user");
      if (!hasCaptions) {
        captionMoments = generateCaptionMoments(transcript, captionVideoType(project)).moments;
      }
    }
    const analysisPatch = { transcript: stripUndefined(transcript) };
    if (captionMoments.length > 0) {
      const merged = [...project.analysis?.detectedMoments ?? [], ...captionMoments].sort(
        (a, b) => a.startTime - b.startTime
      );
      analysisPatch.detectedMoments = stripUndefined(merged);
    }
    await ref.set({ analysis: analysisPatch, updatedAt: FieldValue2.serverTimestamp() }, { merge: true });
    if (usageKey && usagePeriodId) {
      try {
        if (shouldCommitCaptionUsage(transcript.status)) {
          await commitCaptionUsage(db, {
            uid,
            projectId,
            key: usageKey,
            periodId: usagePeriodId,
            fallbackSeconds: usageSeconds
          });
        } else {
          await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId });
        }
      } catch (settleErr) {
        console.warn("[caption-quota] worker settle failed (sweep will reconcile)", settleErr);
      }
    }
    console.info("[captions:generation]", {
      projectId,
      source: "worker",
      transcriptStatus: transcript.status,
      language: transcript.language,
      segments: transcript.segments?.length ?? 0,
      words: transcript.words?.length ?? 0,
      captions: captionMoments.length
    });
    return { status: transcript.status, captions: captionMoments.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "transcription failed";
    console.warn("[asr:google-speech:error]", { projectId, message });
    await ref.set(
      {
        analysis: {
          transcript: stripUndefined({
            status: "failed",
            error: message,
            ...langStamp,
            ...usageStamp,
            sourceFingerprint: fingerprint,
            requestedAt
          })
        },
        updatedAt: FieldValue2.serverTimestamp()
      },
      { merge: true }
    ).catch(() => {
    });
    if (usageKey && usagePeriodId) {
      await releaseCaptionReservation(db, { uid, projectId, key: usageKey, periodId: usagePeriodId }).catch(
        () => {
        }
      );
    }
    return { status: "failed", captions: 0 };
  }
}

// src/server.ts
var PORT = Number(process.env.PORT) || 8080;
var MAX_BODY_BYTES = 64 * 1024;
var inflight = 0;
var shuttingDown = false;
function json(res, status, body) {
  if (res.writableEnded) return;
  try {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch {
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function handleTranscribe(req, res) {
  const secret = process.env.TRANSCRIPT_WORKER_SECRET;
  if (!secret) {
    json(res, 503, { error: "TRANSCRIPT_WORKER_SECRET is not configured on this service" });
    return;
  }
  if (req.headers["x-internal-secret"] !== secret) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  let body = null;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    body = null;
  }
  if (!body || typeof body.uid !== "string" || !body.uid || typeof body.projectId !== "string" || !body.projectId) {
    json(res, 400, { error: "uid + projectId required" });
    return;
  }
  if (shuttingDown) {
    json(res, 503, { error: "shutting down" });
    return;
  }
  const { uid, projectId } = body;
  console.info("[asr:worker] job accepted", { uid, projectId });
  inflight++;
  const startedAt = Date.now();
  try {
    const result = await processTranscriptionJob(uid, projectId, {
      forceRetranscribe: body.forceRetranscribe === true
    });
    console.info("[asr:worker] job finished", {
      projectId,
      status: result.status,
      captions: result.captions,
      ms: Date.now() - startedAt
    });
    json(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error("[asr:worker] job failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err)
    });
    json(res, 500, { ok: false, error: "transcription job failed" });
  } finally {
    inflight--;
  }
}
var server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if ((req.method === "GET" || req.method === "HEAD") && (url === "/healthz" || url === "/")) {
    json(res, 200, { ok: true, service: "framevo-asr-worker", inflight });
    return;
  }
  if (req.method === "POST" && url === "/api/internal/transcribe") {
    void handleTranscribe(req, res);
    return;
  }
  json(res, 404, { error: "not found" });
});
server.requestTimeout = 0;
server.headersTimeout = 6e4;
server.listen(PORT, () => {
  console.info(`[asr:worker] listening on :${PORT}`);
});
process.on("SIGTERM", () => {
  shuttingDown = true;
  console.info("[asr:worker] SIGTERM \u2014 draining", { inflight });
  server.close();
  const deadline = Date.now() + 8e3;
  const tick = setInterval(() => {
    if (inflight <= 0 || Date.now() > deadline) {
      clearInterval(tick);
      process.exit(0);
    }
  }, 250);
});
