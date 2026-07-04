/**
 * Framevo ASR worker — a dedicated Cloud Run service for transcription.
 *
 * Serves the SAME endpoint contract the app's `dispatchTranscription`
 * (src/lib/transcript/run-transcription.ts) already posts to:
 *
 *   POST /api/internal/transcribe   { uid, projectId, forceRetranscribe? }
 *   header: x-internal-secret = TRANSCRIPT_WORKER_SECRET
 *
 * and runs the SHARED `processTranscriptionJob` — the one pipeline that
 * verifies the caption-quota reservation BEFORE calling Google
 * Speech-to-Text, extracts audio with ffmpeg, transcribes, generates caption
 * moments, finalizes the quota (commit/release), and writes
 * `analysis.transcript` + captions to Firestore. Nothing is reimplemented
 * here — the worker is a thin HTTP shell around the exact code the Next app
 * runs in `inline` mode.
 *
 * Lifecycle: the request is HELD OPEN until the job (ASR + Firestore writes)
 * finishes — deploy with a generous `--timeout` (e.g. 900s). The app's
 * dispatcher aborts its fetch after ~10s by design; the job keeps running
 * after that disconnect, so deploy with `--no-cpu-throttling` so the instance
 * keeps CPU until the work completes. SIGTERM waits briefly for in-flight
 * jobs before exiting.
 *
 * Auth: TRANSCRIPT_WORKER_SECRET is REQUIRED here (unlike the in-app internal
 * route, this service is reachable on its own URL) — unset ⇒ every job
 * request is refused with 503, never processed unauthenticated.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { processTranscriptionJob } from "@/lib/transcript/run-transcription";

const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY_BYTES = 64 * 1024;

let inflight = 0;
let shuttingDown = false;

function json(res: ServerResponse, status: number, body: unknown): void {
  // The dispatcher may have aborted its fetch long ago — never throw on a
  // closed response.
  if (res.writableEnded) return;
  try {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch {
    /* client gone — the job result is already in Firestore */
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
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

async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = process.env.TRANSCRIPT_WORKER_SECRET;
  if (!secret) {
    // Fail closed: a dedicated public service must never run unauthenticated.
    json(res, 503, { error: "TRANSCRIPT_WORKER_SECRET is not configured on this service" });
    return;
  }
  if (req.headers["x-internal-secret"] !== secret) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  interface TranscribeBody {
    uid?: string;
    projectId?: string;
    forceRetranscribe?: boolean;
  }
  let body: TranscribeBody | null = null;
  try {
    body = JSON.parse(await readBody(req)) as TranscribeBody;
  } catch {
    body = null;
  }
  if (!body || typeof body.uid !== "string" || !body.uid || typeof body.projectId !== "string" || !body.projectId) {
    json(res, 400, { error: "uid + projectId required" });
    return;
  }
  if (shuttingDown) {
    // Ask the dispatcher's stale-processing recovery to retry on a live instance.
    json(res, 503, { error: "shutting down" });
    return;
  }

  const { uid, projectId } = body;
  console.info("[asr:worker] job accepted", { uid, projectId });
  inflight++;
  const startedAt = Date.now();
  try {
    // Awaited — the request stays alive until ASR + quota finalization +
    // Firestore writes finish. All failure modes are CONTAINED inside the job
    // (transcript → failed/unavailable; reservation released); a throw here is
    // infra-level only.
    const result = await processTranscriptionJob(uid, projectId, {
      forceRetranscribe: body.forceRetranscribe === true,
    });
    console.info("[asr:worker] job finished", {
      projectId,
      status: result.status,
      captions: result.captions,
      ms: Date.now() - startedAt,
    });
    json(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error("[asr:worker] job failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, { ok: false, error: "transcription job failed" });
  } finally {
    inflight--;
  }
}

const server = createServer((req, res) => {
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

// Long ASR jobs: never let Node kill the socket under the job (Cloud Run's
// --timeout is the real bound).
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, () => {
  console.info(`[asr:worker] listening on :${PORT}`);
});

// Graceful shutdown — Cloud Run sends SIGTERM before stopping the instance.
// Stop accepting work, give in-flight jobs a short window to finish their
// Firestore writes; anything still running recovers via the app's
// stale-`processing` retry on the next analysis.
process.on("SIGTERM", () => {
  shuttingDown = true;
  console.info("[asr:worker] SIGTERM — draining", { inflight });
  server.close();
  const deadline = Date.now() + 8_000;
  const tick = setInterval(() => {
    if (inflight <= 0 || Date.now() > deadline) {
      clearInterval(tick);
      process.exit(0);
    }
  }, 250);
});
