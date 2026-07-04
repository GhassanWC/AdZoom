/**
 * Server-side caption-usage ledger — the durable, atomic enforcement layer for
 * the auto-caption minutes quota (`caption-quota.ts` holds the pure config +
 * reducers; this file owns the Firestore transactions).
 *
 * Doc: `users/{uid}/captionUsage/{periodId}` — one doc per billing period
 * (paid periods anchor to the subscription anniversary; Free uses the UTC
 * calendar month). A new period simply starts a new doc, so the "monthly
 * reset" needs no cron. Clients may READ their own ledger (display); every
 * write happens here, inside `db.runTransaction`, so concurrent requests
 * serialize and can never overspend. Client-sent usage values are never
 * trusted — the plan, the subscription period, and the ledger are all
 * re-read inside the transaction.
 *
 * Structured logs (`[caption-quota:*]`) record ids + numbers only — NEVER
 * transcript contents.
 */
import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { normalizePlan } from "./plan";
import {
  type CaptionPeriod,
  type CaptionUsageDoc,
  CaptionQuotaExhaustedError,
  applyCaptionCommit,
  applyCaptionRelease,
  applyCaptionReserve,
  applyPlanChange,
  initialCaptionUsageDoc,
  resolveCaptionPeriod,
  sweepStaleReservation,
} from "./caption-quota";
import type { Transcript } from "@/lib/firebase/schema";

type QuotaLogEvent = "check" | "reserved" | "committed" | "released" | "blocked" | "reconciled";

/** Structured quota log — ids and numbers only, never transcript text. */
export function logCaptionQuota(
  event: QuotaLogEvent,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  console.info(`[caption-quota:${event}]`, fields);
}

function ledgerRef(db: Firestore, uid: string, periodId: string) {
  return db.collection("users").doc(uid).collection("captionUsage").doc(periodId);
}

function projectRef(db: Firestore, uid: string, projectId: string) {
  return db.collection("users").doc(uid).collection("projects").doc(projectId);
}

/**
 * Resolve the LIVE plan + current billing period inside a transaction (or
 * with plain reads when no transaction is given). The plan comes from
 * `users/{uid}.plan` (server truth, mirrored by the billing webhook); the
 * period anchor comes from `subscriptions/{uid}.renewsAt`.
 */
async function resolvePlanAndPeriod(
  db: Firestore,
  uid: string,
  nowMs: number,
  tx?: Transaction
): Promise<{ plan: ReturnType<typeof normalizePlan>; period: CaptionPeriod }> {
  const userRef = db.collection("users").doc(uid);
  const subRef = db.collection("subscriptions").doc(uid);
  const [userSnap, subSnap] = tx
    ? await Promise.all([tx.get(userRef), tx.get(subRef)])
    : await Promise.all([userRef.get(), subRef.get()]);
  const plan = normalizePlan(userSnap.data()?.plan);
  const renews = subSnap.data()?.renewsAt;
  const renewsAtMs = typeof renews === "number" && Number.isFinite(renews) ? renews : null;
  return { plan, period: resolveCaptionPeriod({ plan, renewsAtMs, nowMs }) };
}

function readLedger(
  snap: FirebaseFirestore.DocumentSnapshot,
  plan: ReturnType<typeof normalizePlan>,
  period: CaptionPeriod,
  nowMs: number
): CaptionUsageDoc {
  if (!snap.exists) {
    // Old users (or first caption of the period) initialize safely from zero.
    return initialCaptionUsageDoc({ plan, period, nowMs });
  }
  const raw = snap.data() as Partial<CaptionUsageDoc>;
  const base = initialCaptionUsageDoc({ plan, period, nowMs });
  return {
    ...base,
    ...raw,
    allowanceSeconds: raw.allowanceSeconds ?? base.allowanceSeconds,
    usedSeconds: Math.max(0, raw.usedSeconds ?? 0),
    reservedSeconds: Math.max(0, raw.reservedSeconds ?? 0),
    reservations: raw.reservations ?? {},
    finalizedKeys: raw.finalizedKeys ?? {},
  } as CaptionUsageDoc;
}

function writeLedger(tx: Transaction, ref: FirebaseFirestore.DocumentReference, doc: CaptionUsageDoc) {
  tx.set(ref, { ...doc, updatedAt: FieldValue.serverTimestamp() });
}

/**
 * Atomically reserve `seconds` for one ASR run under an idempotency `key`.
 * Re-reads plan + subscription + ledger inside the transaction (concurrent
 * requests serialize → cannot overspend), sweeps stale reservations first,
 * applies live plan upgrades, and throws {@link CaptionQuotaExhaustedError}
 * when the monthly allowance can't cover the request. Returns the period the
 * reservation was written to (recorded on the transcript for finalization).
 */
export async function reserveCaptionSeconds(
  db: Firestore,
  input: { uid: string; projectId: string; key: string; seconds: number }
): Promise<{ periodId: string; remainingSeconds: number }> {
  const { uid, projectId, key, seconds } = input;
  const nowMs = Date.now();
  const result = await db.runTransaction(async (tx) => {
    const { plan, period } = await resolvePlanAndPeriod(db, uid, nowMs, tx);
    const ref = ledgerRef(db, uid, period.periodId);
    let doc = readLedger(await tx.get(ref), plan, period, nowMs);
    doc = applyPlanChange(doc, plan, nowMs);

    // Lazy reconcile: resolve stale reservations (dead jobs) before checking
    // the balance, reading each project's recorded transcript state.
    const staleKeys = Object.keys(doc.reservations);
    for (const k of staleKeys) {
      const res = doc.reservations[k];
      if (nowMs - res.createdAtMs < 0) continue;
      const provisional = sweepStaleReservation({
        reservation: res,
        nowMs,
        transcriptUsageKey: undefined,
        transcriptStatus: undefined,
        key: k,
      });
      if (provisional === "keep") continue; // fresh — skip the project read
      const projSnap = await tx.get(projectRef(db, uid, res.projectId));
      const t = (projSnap.data()?.analysis as { transcript?: Transcript } | undefined)?.transcript;
      const action = sweepStaleReservation({
        reservation: res,
        nowMs,
        transcriptUsageKey: t?.usageKey ?? null,
        transcriptStatus: t?.status ?? null,
        key: k,
      });
      if (action === "commit") doc = applyCaptionCommit(doc, { key: k, nowMs });
      else if (action === "release") doc = applyCaptionRelease(doc, { key: k, nowMs });
      if (action !== "keep") {
        logCaptionQuota("reconciled", {
          uid,
          projectId: res.projectId,
          jobId: k,
          action,
          requestedSeconds: res.seconds,
        });
      }
    }

    logCaptionQuota("check", {
      uid,
      projectId,
      plan: doc.plan,
      requestedSeconds: seconds,
      usedSeconds: doc.usedSeconds,
      reservedSeconds: doc.reservedSeconds,
      remainingSeconds: doc.remainingSeconds,
      jobId: key,
    });

    const out = applyCaptionReserve(doc, { key, seconds, projectId, nowMs });
    if (!out.ok) {
      return { blocked: true as const, plan: doc.plan, remaining: out.remainingSeconds };
    }
    if (!out.alreadyReserved) writeLedger(tx, ref, out.doc);
    return {
      blocked: false as const,
      plan: out.doc.plan,
      periodId: period.periodId,
      remaining: out.doc.remainingSeconds,
      used: out.doc.usedSeconds,
      reserved: out.doc.reservedSeconds,
    };
  });

  if (result.blocked) {
    logCaptionQuota("blocked", {
      uid,
      projectId,
      plan: result.plan,
      requestedSeconds: seconds,
      remainingSeconds: result.remaining,
      jobId: key,
      reason: "monthly_allowance_exhausted",
    });
    throw new CaptionQuotaExhaustedError(result.plan, result.remaining, seconds);
  }
  logCaptionQuota("reserved", {
    uid,
    projectId,
    plan: result.plan,
    requestedSeconds: seconds,
    usedSeconds: result.used,
    reservedSeconds: result.reserved,
    remainingSeconds: result.remaining,
    jobId: key,
  });
  return { periodId: result.periodId!, remainingSeconds: result.remaining };
}

/**
 * Finalize a reservation as CONSUMED — the provider processed audio (any
 * `complete` transcript, including an empty one). Idempotent: duplicate
 * deliveries and retries can never charge twice. A late success whose
 * reservation was already swept charges `fallbackSeconds` directly.
 */
export async function commitCaptionUsage(
  db: Firestore,
  input: { uid: string; projectId: string; key: string; periodId: string; fallbackSeconds?: number }
): Promise<void> {
  const { uid, projectId, key, periodId, fallbackSeconds } = input;
  const nowMs = Date.now();
  const summary = await db.runTransaction(async (tx) => {
    const ref = ledgerRef(db, uid, periodId);
    const snap = await tx.get(ref);
    const { plan, period } = await resolvePlanAndPeriod(db, uid, nowMs, tx);
    // Commit against the reservation's OWN period doc (it may not be the
    // current period when a job crosses the boundary).
    const doc = readLedger(
      snap,
      plan,
      snap.exists ? ({ ...period, periodId } as CaptionPeriod) : period,
      nowMs
    );
    const next = applyCaptionCommit(doc, { key, nowMs, fallbackSeconds });
    if (next === doc) return null; // already finalized — no-op
    writeLedger(tx, ref, next);
    return { usedSeconds: next.usedSeconds, reservedSeconds: next.reservedSeconds, remainingSeconds: next.remainingSeconds, plan: next.plan };
  });
  if (summary) {
    logCaptionQuota("committed", { uid, projectId, jobId: key, ...summary });
  }
}

/**
 * Finalize a reservation as RELEASED — the run failed before the provider
 * processed audio. Never reduces `usedSeconds`; idempotent; a key that was
 * already committed stays committed.
 */
export async function releaseCaptionReservation(
  db: Firestore,
  input: { uid: string; projectId: string; key: string; periodId: string }
): Promise<void> {
  const { uid, projectId, key, periodId } = input;
  const nowMs = Date.now();
  const summary = await db.runTransaction(async (tx) => {
    const ref = ledgerRef(db, uid, periodId);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const raw = snap.data() as CaptionUsageDoc;
    const doc: CaptionUsageDoc = {
      ...raw,
      reservations: raw.reservations ?? {},
      finalizedKeys: raw.finalizedKeys ?? {},
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

export type CaptionReservationVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_reservation_key"
        | "reservation_not_found"
        | "already_finalized"
        | "project_mismatch"
        | "per_video_limit_exceeded";
    };

/**
 * Worker-side authorization: verify the reservation BEFORE calling the ASR
 * provider. Rejects missing/unknown keys, keys already finalized (duplicate
 * delivery), and reservations recorded for a different project. (Fingerprint
 * and transcript-state checks happen in the worker itself, which holds the
 * live project doc.)
 */
export async function verifyCaptionReservation(
  db: Firestore,
  input: { uid: string; projectId: string; key: string | undefined; periodId: string | undefined }
): Promise<CaptionReservationVerdict> {
  const { uid, projectId, key, periodId } = input;
  if (!key || !periodId) return { ok: false, reason: "missing_reservation_key" };
  const snap = await ledgerRef(db, uid, periodId).get();
  const data = snap.exists ? (snap.data() as CaptionUsageDoc) : null;
  if (data?.finalizedKeys?.[key]) return { ok: false, reason: "already_finalized" };
  const res = data?.reservations?.[key];
  if (!res) return { ok: false, reason: "reservation_not_found" };
  if (res.projectId !== projectId) return { ok: false, reason: "project_mismatch" };
  return { ok: true };
}
