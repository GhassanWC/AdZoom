/**
 * Internal transcription worker endpoint. Runs the heavy ASR (ffmpeg + Speech)
 * via `processTranscriptionJob`, so it MUST be deployed to an ffmpeg-equipped
 * runtime (a dedicated Cloud Run service / the export worker) — NOT the public
 * app. The analysis route dispatches here in `worker` mode; export never calls it.
 *
 * Auth: a shared `TRANSCRIPT_WORKER_SECRET` header (server→server only). The job
 * is acknowledged fast (202) and processed in the background, so the caller isn't
 * blocked on ffmpeg. A failure is contained inside the job (transcript → failed).
 */
import { NextResponse } from "next/server";
import { processTranscriptionJob } from "@/lib/transcript/run-transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.TRANSCRIPT_WORKER_SECRET;
  if (secret && req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    uid?: string;
    projectId?: string;
    forceRetranscribe?: boolean;
  } | null;
  if (!body?.uid || !body?.projectId) {
    return NextResponse.json({ error: "uid + projectId required" }, { status: 400 });
  }

  console.info("[asr:worker] job accepted", { uid: body.uid, projectId: body.projectId });
  // Process in the background so the dispatcher isn't blocked on ffmpeg. The
  // runtime must keep the process alive after responding (CPU-always-on / a
  // background poller) for long jobs to finish; short jobs complete inline.
  void processTranscriptionJob(body.uid, body.projectId, {
    forceRetranscribe: body.forceRetranscribe === true,
  }).catch((err) => {
    console.error("[asr:worker] job failed", {
      projectId: body.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({ accepted: true }, { status: 202 });
}
