/**
 * Auto-caption (ASR transcription) minutes — the metered quota for
 * Speech-to-Text usage, per plan.
 *
 * This module is PURE (no `getAdmin`, no `server-only`) so it can be imported
 * by the client UI (caption meter in the Analyze dialog), the analyze API
 * route, AND the transcription worker — ONE source of truth for the limits,
 * the period math, and the ledger reducers.
 *
 * Quota model (per the product spec):
 *   • Free    — 10 caption minutes / month, max 5-minute source video.
 *   • Pro     — 150 caption minutes / month, max 15-minute source video.
 *   • Creator — 300 caption minutes / month, max 30-minute source video.
 *
 * IMPORTANT: caption minutes are a SEPARATE allowance from cloud-export
 * minutes (`cloud-minutes.ts`). Transcription never deducts export minutes and
 * rendering/exporting never deducts caption minutes. The ledger lives on its
 * own subcollection (`users/{uid}/captionUsage/{periodId}`), not the export
 * usage doc.
 *
 * Accounting is double-entry, in SECONDS (no rounding drift; the UI rounds to
 * minutes for display):
 *   - `reservedSeconds` — held by in-flight ASR jobs (reserved before dispatch).
 *   - `usedSeconds`     — finalized by completed ASR (including a successful
 *                         run that returned an EMPTY transcript — the provider
 *                         still processed/billed the audio).
 *   - remaining = max(0, allowance − used − reserved).
 * A job RESERVES the source duration atomically before ASR is dispatched (so
 * two concurrent requests can't both pass the check), then a terminal state
 * either COMMITS the reservation into `usedSeconds` (provider processed audio)
 * or RELEASES it (failure before processing). Idempotency: every reservation
 * has a key; commit/release are no-ops for already-committed keys, so retries
 * and duplicate worker deliveries can never charge twice.
 *
 * Transcript REUSE (same source fingerprint + language + provider/model —
 * see src/lib/transcript/transcription-job.ts) never reaches the reserve step,
 * so cache hits, re-analyzes, caption restyling/editing, enable/disable, and
 * exports are all free by construction.
 */
import { type PlanTier, planRank } from "./plan";

/** Bare tier names for limit copy ("…limit for Free." — not "Free plan"). */
const PLAN_DISPLAY_NAME: Record<PlanTier, string> = {
  free: "Free",
  pro: "Pro",
  creator: "Creator",
};

/* ── Plan configuration (single source of truth) ─────────────────────────── */

export interface CaptionPlanLimits {
  /** Included auto-caption minutes per billing period. */
  captionMinutesPerMonth: number;
  /** Max SOURCE video length (seconds) a single auto-caption run may transcribe. */
  maxCaptionVideoSeconds: number;
}

export const CAPTION_PLAN_LIMITS: Record<PlanTier, CaptionPlanLimits> = {
  free: { captionMinutesPerMonth: 10, maxCaptionVideoSeconds: 5 * 60 },
  pro: { captionMinutesPerMonth: 150, maxCaptionVideoSeconds: 15 * 60 },
  creator: { captionMinutesPerMonth: 300, maxCaptionVideoSeconds: 30 * 60 },
};

/** The plan's monthly caption allowance, in seconds (internal unit). */
export function captionAllowanceSeconds(plan: PlanTier): number {
  return CAPTION_PLAN_LIMITS[plan].captionMinutesPerMonth * 60;
}

/** True when the source video is longer than the plan's per-video caption cap. */
export function exceedsCaptionVideoLimit(
  plan: PlanTier,
  durationSeconds: number | null | undefined
): boolean {
  return (
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > CAPTION_PLAN_LIMITS[plan].maxCaptionVideoSeconds
  );
}

/**
 * Seconds an ASR run of this source will consume — the FULL source audio
 * duration, rounded up (Google bills processed audio; we extract the whole
 * track). Floor of 1 so a sub-second clip still counts.
 */
export function requiredCaptionSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1;
  return Math.max(1, Math.ceil(durationSeconds));
}

/* ── Billing period resolution ───────────────────────────────────────────── */

export interface CaptionPeriod {
  /** Ledger doc id — stable for the whole period. */
  periodId: string;
  startMs: number;
  endMs: number;
  anchor: "calendar" | "subscription";
}

/**
 * Add calendar months in UTC with day-of-month clamping (Jan 31 + 1 month →
 * Feb 28/29), so subscription anniversaries land on real dates.
 */
export function addMonthsUtcClamped(ms: number, months: number): number {
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

/**
 * The billing period a moment belongs to:
 *   • Paid plans anchor to the SUBSCRIPTION cycle: monthly windows aligned to
 *     the Lemon Squeezy `renewsAt` anniversary (walked to contain `now`).
 *   • Free (or paid with no readable subscription): consistent UTC calendar
 *     month.
 * Usage buckets are per-period docs, so a new period starts from zero — the
 * monthly reset needs no cron.
 */
export function resolveCaptionPeriod(input: {
  plan: PlanTier;
  renewsAtMs: number | null | undefined;
  nowMs: number;
}): CaptionPeriod {
  const { plan, renewsAtMs, nowMs } = input;
  if (plan !== "free" && typeof renewsAtMs === "number" && Number.isFinite(renewsAtMs)) {
    // Walk the anniversary to the window containing `now`. `renewsAt` is
    // usually the NEXT renewal (future) — step back; a stale value steps
    // forward. Bounded walks guard against pathological timestamps.
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
    // Walk failed to bracket `now` (corrupt timestamp) → calendar fallback.
  }
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    periodId: `cal-${y}-${String(m + 1).padStart(2, "0")}`,
    startMs: Date.UTC(y, m, 1),
    endMs: Date.UTC(y, m + 1, 1),
    anchor: "calendar",
  };
}

/* ── Ledger document + pure reducers ─────────────────────────────────────── */
/* The Firestore transaction bodies delegate to these reducers, so the exact
   reserve/commit/release/idempotency semantics are unit-testable without a
   database. Atomicity across concurrent requests comes from running them
   inside `db.runTransaction` (serialized re-execution on contention). */

export interface CaptionReservationEntry {
  seconds: number;
  projectId: string;
  createdAtMs: number;
}

export interface CaptionUsageDoc {
  plan: PlanTier;
  periodId: string;
  billingPeriodStartMs: number;
  billingPeriodEndMs: number;
  allowanceSeconds: number;
  usedSeconds: number;
  reservedSeconds: number;
  /** Denormalized max(0, allowance − used − reserved); recomputed on every write. */
  remainingSeconds: number;
  /** Active reservations by idempotency key. */
  reservations: Record<string, CaptionReservationEntry>;
  /** Keys already finalized (committed OR released) → finalizedAtMs. Retries no-op. */
  finalizedKeys: Record<string, number>;
  updatedAtMs: number;
}

export function initialCaptionUsageDoc(input: {
  plan: PlanTier;
  period: CaptionPeriod;
  nowMs: number;
}): CaptionUsageDoc {
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
    updatedAtMs: input.nowMs,
  };
}

export function captionRemainingSeconds(
  s: Pick<CaptionUsageDoc, "allowanceSeconds" | "usedSeconds" | "reservedSeconds">
): number {
  return Math.max(
    0,
    (s.allowanceSeconds ?? 0) - Math.max(0, s.usedSeconds ?? 0) - Math.max(0, s.reservedSeconds ?? 0)
  );
}

function recompute(doc: CaptionUsageDoc, nowMs: number): CaptionUsageDoc {
  return { ...doc, remainingSeconds: captionRemainingSeconds(doc), updatedAtMs: nowMs };
}

/**
 * Reconcile the ledger's plan with the LIVE plan:
 *   • upgrade mid-cycle → allowance rises immediately (never below what was
 *     already granted this period);
 *   • downgrade → the CURRENT period keeps its granted allowance (entitlement
 *     runs out with the billing period; the next period starts on the new
 *     plan's allowance);
 *   • `usedSeconds` is never reduced.
 */
export function applyPlanChange(doc: CaptionUsageDoc, livePlan: PlanTier, nowMs: number): CaptionUsageDoc {
  const liveAllowance = captionAllowanceSeconds(livePlan);
  if (planRank(livePlan) > planRank(doc.plan) || liveAllowance > doc.allowanceSeconds) {
    return recompute(
      { ...doc, plan: livePlan, allowanceSeconds: Math.max(doc.allowanceSeconds, liveAllowance) },
      nowMs
    );
  }
  return doc;
}

export type CaptionReserveResult =
  | { ok: true; doc: CaptionUsageDoc; alreadyReserved: boolean }
  | { ok: false; reason: "exhausted"; remainingSeconds: number };

/** Reserve `seconds` under `key`. Idempotent: an existing/finalized key no-ops. */
export function applyCaptionReserve(
  doc: CaptionUsageDoc,
  input: { key: string; seconds: number; projectId: string; nowMs: number }
): CaptionReserveResult {
  const { key, seconds, projectId, nowMs } = input;
  if (doc.reservations[key] || doc.finalizedKeys[key]) {
    return { ok: true, doc, alreadyReserved: true };
  }
  const remaining = captionRemainingSeconds(doc);
  if (seconds <= 0 || remaining < seconds) {
    return { ok: false, reason: "exhausted", remainingSeconds: remaining };
  }
  const next: CaptionUsageDoc = recompute(
    {
      ...doc,
      reservedSeconds: doc.reservedSeconds + seconds,
      reservations: { ...doc.reservations, [key]: { seconds, projectId, createdAtMs: nowMs } },
    },
    nowMs
  );
  return { ok: true, doc: next, alreadyReserved: false };
}

/**
 * Finalize `key` as CONSUMED (the provider processed audio — including a
 * successful run that produced an empty transcript). Converts the reservation
 * into `usedSeconds`; when the reservation was already swept/released but the
 * success arrives late, `fallbackSeconds` is charged directly. Idempotent.
 */
export function applyCaptionCommit(
  doc: CaptionUsageDoc,
  input: { key: string; nowMs: number; fallbackSeconds?: number }
): CaptionUsageDoc {
  const { key, nowMs, fallbackSeconds } = input;
  if (doc.finalizedKeys[key]) return doc; // duplicate delivery — never charge twice
  const res = doc.reservations[key];
  if (res) {
    const { [key]: _gone, ...rest } = doc.reservations;
    return recompute(
      {
        ...doc,
        reservations: rest,
        reservedSeconds: Math.max(0, doc.reservedSeconds - res.seconds),
        usedSeconds: doc.usedSeconds + res.seconds,
        finalizedKeys: { ...doc.finalizedKeys, [key]: nowMs },
      },
      nowMs
    );
  }
  const late = Math.max(0, Math.ceil(fallbackSeconds ?? 0));
  return recompute(
    {
      ...doc,
      usedSeconds: doc.usedSeconds + late,
      finalizedKeys: { ...doc.finalizedKeys, [key]: nowMs },
    },
    nowMs
  );
}

/**
 * Finalize `key` as RELEASED (failure before the provider processed audio).
 * Frees the reservation without touching `usedSeconds`. Idempotent — and a
 * key that was already COMMITTED stays committed (release after commit no-ops).
 */
export function applyCaptionRelease(
  doc: CaptionUsageDoc,
  input: { key: string; nowMs: number }
): CaptionUsageDoc {
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
      finalizedKeys: { ...doc.finalizedKeys, [key]: nowMs },
    },
    nowMs
  );
}

/**
 * Whether a finished ASR run CONSUMES its reservation. Any `complete`
 * transcript counts — including one with zero segments — because the provider
 * processed (and may bill) the audio either way. `failed`/`unavailable` runs
 * never processed audio and release instead. One policy for the analyze
 * route, the worker, and the tests.
 */
export function shouldCommitCaptionUsage(status: string | null | undefined): boolean {
  return status === "complete";
}

/* ── Stale-reservation reconciliation ────────────────────────────────────── */

/** A reservation older than this with no live job behind it is reconciled. */
export const CAPTION_RESERVATION_TTL_MS = 45 * 60 * 1000;

export type CaptionSweepAction = "keep" | "commit" | "release";

/**
 * Decide what to do with a stale reservation based on the RECORDED transcript
 * state of its project:
 *   • transcript completed under this key → COMMIT (provider processed audio;
 *     the success-path commit must have been lost).
 *   • anything else (failed, replaced by a different request, gone, or still
 *     "processing" long past any plausible runtime) → RELEASE.
 */
export function sweepStaleReservation(input: {
  reservation: CaptionReservationEntry;
  nowMs: number;
  transcriptUsageKey: string | null | undefined;
  transcriptStatus: string | null | undefined;
  key: string;
}): CaptionSweepAction {
  const { reservation, nowMs, transcriptUsageKey, transcriptStatus, key } = input;
  if (nowMs - reservation.createdAtMs < CAPTION_RESERVATION_TTL_MS) return "keep";
  if (transcriptUsageKey === key && transcriptStatus === "complete") return "commit";
  return "release";
}

/* ── UI strings + estimates (shared so copies can't drift) ───────────────── */

/** "150 auto-caption minutes/month" — the allowance line. */
export function captionAllowanceLabel(plan: PlanTier): string {
  return `${CAPTION_PLAN_LIMITS[plan].captionMinutesPerMonth} auto-caption minutes/month`;
}

/** Approximate minutes an ASR run of this duration consumes, one decimal. */
export function estimateCaptionMinutes(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0.1;
  return Math.max(0.1, Math.round((durationSeconds / 60) * 10) / 10);
}

/** "This video exceeds the 5-minute auto-caption limit for Free." */
export function perVideoCaptionLimitMessage(plan: PlanTier): string {
  const limits = CAPTION_PLAN_LIMITS[plan];
  return `This video exceeds the ${Math.round(limits.maxCaptionVideoSeconds / 60)}-minute auto-caption limit for ${PLAN_DISPLAY_NAME[plan]}.`;
}

export const CAPTION_ALLOWANCE_EXHAUSTED_MESSAGE =
  "You've used all your auto-caption minutes for this billing period. Manual captions are still available.";

/* ── Errors ──────────────────────────────────────────────────────────────── */

/** Thrown when the monthly caption allowance can't cover the request. */
export class CaptionQuotaExhaustedError extends Error {
  readonly plan: PlanTier;
  readonly remainingSeconds: number;
  readonly requestedSeconds: number;
  constructor(plan: PlanTier, remainingSeconds: number, requestedSeconds: number) {
    super(
      `Not enough auto-caption minutes: need ${requestedSeconds}s, have ${remainingSeconds}s on ${plan}.`
    );
    this.name = "CaptionQuotaExhaustedError";
    this.plan = plan;
    this.remainingSeconds = remainingSeconds;
    this.requestedSeconds = requestedSeconds;
  }
}
