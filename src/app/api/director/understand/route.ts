/**
 * AI Director — "what did they mean?"
 *
 * The escalation path for a chat message the local parser couldn't place.
 *
 * The follow-up chat is deliberately local and free (see `lib/director/chat.ts`)
 * — a revision is a patch to a plan that already exists, so it runs in the
 * browser in a millisecond. That is worth keeping. What it cost, until this
 * route existed, was that the ONLY thing standing between a user and their edit
 * was a regex: a typo, an unusual word for a zoom, or a sentence shaped slightly
 * differently produced "I didn't catch a change I can make in that" even though
 * `understandRevision` had been sitting in the codebase, unimported, the whole
 * time.
 *
 * So: parser first, model second, and the model only ever gets consulted for the
 * messages the parser genuinely couldn't read. Fast and free stays the common
 * case; understood-anyway becomes the fallback instead of a dead end.
 *
 * This route CLASSIFIES ONLY. It returns intents — it does not touch the project,
 * the plan or the timeline. The client applies them through exactly the same
 * `applyRevision` → `validate` → `execute` path a locally-parsed command takes,
 * so a model-understood message cannot reach any state a typed one couldn't.
 *
 * Request:  POST { command: string }        (Bearer ID token)
 * Response: { intents: DirectorRevisionIntent[], understood: boolean }
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { understandRevision } from "@/lib/director/gemini-planner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough for any real instruction; short enough that it can't be abused. */
const MAX_COMMAND_CHARS = 600;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  try {
    await getAdmin().auth.verifyIdToken(idToken);
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let command: string;
  try {
    const body = (await req.json()) as { command?: unknown };
    command = typeof body.command === "string" ? body.command.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!command) {
    return NextResponse.json({ error: "Body must include `command`." }, { status: 400 });
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return NextResponse.json(
      { error: `Message too long (max ${MAX_COMMAND_CHARS} characters).` },
      { status: 400 }
    );
  }

  try {
    const result = await understandRevision(command);
    return NextResponse.json(result);
  } catch (err) {
    // A failed classification is not a failed edit. Report "I couldn't read it"
    // and let the panel offer its fallback, rather than surfacing a 500 for what
    // is, to the user, a sentence that didn't land.
    console.warn("[director/understand] classification failed", {
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return NextResponse.json({ intents: [], understood: false });
  }
}
