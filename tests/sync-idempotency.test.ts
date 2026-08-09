/**
 * Revisions, duplicate-operation prevention and retry scheduling.
 *
 * Between them these decide the two properties that matter most when a sync
 * queue meets an unreliable network: an operation is applied AT MOST ONCE, and
 * a write composed against stale data never lands on top of newer data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alreadyApplied,
  isStale,
  newDeviceId,
  newOpId,
  nextRevision,
  revisionOf,
  stampRevision,
  verdictFor,
} from "@/lib/sync/revision";
import { createOpLog, shouldApplyRemote } from "@/lib/sync/op-log";
import {
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  backoffDelayMs,
  decideRetry,
  isPermanent,
  rearm,
} from "@/lib/sync/backoff";

// ── revisions ──────────────────────────────────────────────────────────────

test("a document written before sync existed counts as revision 0", () => {
  assert.equal(revisionOf(undefined), 0);
  assert.equal(revisionOf(null), 0);
  assert.equal(revisionOf({}), 0);
  assert.equal(nextRevision({}), 1, "its first synced write becomes rev 1 — no migration needed");
});

test("garbage in the rev field is treated as 0 rather than trusted", () => {
  assert.equal(revisionOf({ rev: Number.NaN }), 0);
  assert.equal(revisionOf({ rev: -3 }), 0);
  assert.equal(revisionOf({ rev: 7.9 }), 7);
});

test("a remote that moved past our base is stale", () => {
  assert.equal(isStale(4, { rev: 4 }), false, "exactly where we left it");
  assert.equal(isStale(4, { rev: 5 }), true, "someone else wrote");
  assert.equal(isStale(4, { rev: 3 }), true, "impossible, but still not safe to overwrite");
});

// ── the push verdict ───────────────────────────────────────────────────────

test("an untouched remote is written directly", () => {
  assert.equal(verdictFor({ opId: "op_1", baseRev: 2, remote: { rev: 2 } }), "apply");
});

test("a remote that moved routes into the merge instead of overwriting", () => {
  assert.equal(verdictFor({ opId: "op_1", baseRev: 2, remote: { rev: 3 } }), "merge");
});

test("an operation already stamped on the remote is skipped, not re-applied", () => {
  // The commit succeeded but the ack was lost; the retry must be a no-op.
  const remote = { rev: 3, lastOpId: "op_1" };
  assert.equal(alreadyApplied("op_1", remote), true);
  assert.equal(
    verdictFor({ opId: "op_1", baseRev: 2, remote }),
    "skip",
    "and specifically NOT 'merge' — our own successful write is not a conflict"
  );
});

test("the skip check wins over the staleness check", () => {
  // This ordering is the whole subtlety: a successfully applied op ALWAYS looks
  // stale afterwards, because its own write moved the revision.
  const remote = { rev: 99, lastOpId: "op_mine" };
  assert.equal(isStale(2, remote), true);
  assert.equal(verdictFor({ opId: "op_mine", baseRev: 2, remote }), "skip");
});

test("stamping an accepted write records the revision, device and operation", () => {
  const stamp = stampRevision({ remote: { rev: 6 }, deviceId: "dev_x", opId: "op_y" });
  assert.deepEqual(stamp, { rev: 7, lastWriterDeviceId: "dev_x", lastOpId: "op_y" });
});

test("ids are unique and namespaced", () => {
  let seed = 0;
  const random = () => {
    seed += 0.017;
    return seed % 1;
  };
  const a = newOpId(random);
  const b = newOpId(random);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("op_"));
  assert.ok(newDeviceId(random).startsWith("dev_"));
});

// ── echo suppression ───────────────────────────────────────────────────────

test("a document whose last write was ours is not applied back to us", () => {
  const log = createOpLog();
  log.remember("op_mine");
  assert.equal(shouldApplyRemote({ remoteLastOpId: "op_mine", log }), false);
  assert.equal(shouldApplyRemote({ remoteLastOpId: "op_theirs", log }), true);
  assert.equal(shouldApplyRemote({ remoteLastOpId: undefined, log }), true);
});

test("the op log is bounded and evicts oldest-first", () => {
  const log = createOpLog(3);
  log.remember("a");
  log.remember("b");
  log.remember("c");
  log.remember("d");
  assert.equal(log.size(), 3);
  assert.equal(log.isOwn("a"), false, "oldest evicted");
  assert.equal(log.isOwn("d"), true);
});

test("re-remembering an id refreshes its recency", () => {
  const log = createOpLog(3);
  log.remember("a");
  log.remember("b");
  log.remember("a"); // a is now the newest
  log.remember("c");
  log.remember("d");
  assert.equal(log.isOwn("a"), true, "refreshed, so it outlived b");
  assert.equal(log.isOwn("b"), false);
});

test("signing out clears the log so nothing carries into the next session", () => {
  const log = createOpLog();
  log.remember("op_1");
  log.clear();
  assert.equal(log.isOwn("op_1"), false);
});

// ── retry policy ───────────────────────────────────────────────────────────

test("backoff grows exponentially and is capped", () => {
  const full = () => 1; // full jitter at its maximum
  assert.equal(backoffDelayMs(1, full), 1_000);
  assert.equal(backoffDelayMs(2, full), 2_000);
  assert.equal(backoffDelayMs(3, full), 4_000);
  assert.equal(backoffDelayMs(30, full), MAX_DELAY_MS, "capped, never unbounded");
});

test("jitter spreads retries instead of synchronising them", () => {
  // Two clients that lost the same network must not come back in lockstep.
  assert.equal(backoffDelayMs(5, () => 0), 0);
  assert.equal(backoffDelayMs(5, () => 0.5), 8_000);
  assert.equal(backoffDelayMs(5, () => 1), 16_000);
});

test("a transient failure is rescheduled, keeping the reason", () => {
  const decision = decideRetry({
    attempts: 0,
    now: 1_000,
    message: "network unreachable",
    code: "unavailable",
    random: () => 1,
  });
  assert.equal(decision.state, "queued");
  assert.equal(decision.attempts, 1);
  assert.equal(decision.nextAttemptAt, 2_000);
  assert.equal(decision.lastError, "network unreachable");
});

test("a permanent failure is parked immediately rather than retried forever", () => {
  assert.equal(isPermanent("permission-denied"), true);
  assert.equal(isPermanent("unavailable"), false);

  const decision = decideRetry({
    attempts: 0,
    now: 1_000,
    message: "Missing or insufficient permissions",
    code: "permission-denied",
  });
  assert.equal(decision.state, "failed");
  assert.equal(
    decision.lastError,
    "Missing or insufficient permissions",
    "the reason is retained — 'sync failed' with no detail is not actionable"
  );
});

test("exhausting the attempt ladder parks the operation without discarding it", () => {
  const decision = decideRetry({
    attempts: MAX_ATTEMPTS - 1,
    now: 1_000,
    message: "still failing",
    code: "unavailable",
  });
  assert.equal(decision.state, "failed");
  assert.equal(decision.attempts, MAX_ATTEMPTS);
});

test("retry re-arms a parked operation with a fresh ladder", () => {
  const armed = rearm(5_000);
  assert.equal(armed.state, "queued");
  assert.equal(armed.attempts, 0, "a full ladder again, not one last try");
  assert.equal(armed.nextAttemptAt, 5_000, "and it runs now");
});
