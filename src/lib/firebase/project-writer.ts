"use client";

/**
 * Per-project serialized write queue.
 *
 * Progressive chunked analysis issues many writes from several places at once —
 * per-chunk moment appends (a `runTransaction` on the project doc), chunk/job
 * status writes, the merged-VA + terminal writes, user edits, and the repair
 * effect. Running these concurrently makes the Firestore SDK throw
 * "Another write batch or compaction is already active" (overlapping commits /
 * transaction contention).
 *
 * Every write for a given project is funneled through ONE promise chain keyed
 * by project id, so at most one write runs at a time. Writes are never dropped
 * (they queue); transient failures retry; and a failure is swallowed + logged
 * so a persistence race can never bubble up and 500 / crash the editor.
 *
 * Logs (per requirement): queued · started · completed · skipped (stale).
 */

const chains = new Map<string, Promise<unknown>>();
/** Latest enqueued seq per coalesce tag — earlier not-yet-started ones are stale. */
const latestCoalesceSeq = new Map<string, number>();
/** Projects with an active chunked-analysis run (compaction/repair must not race). */
const activeAnalysis = new Set<string>();

let seq = 0;
const WRITE_RETRIES = 2;

function log(line: string, ...rest: unknown[]) {
  // eslint-disable-next-line no-console
  console.info(`[write-queue] ${line}`, ...rest);
}

export interface EnqueueOpts {
  /**
   * Coalesce tag. While a task with this tag sits un-started in the queue, a
   * newer one supersedes it and the older is skipped ("stale"). Only use for
   * idempotent latest-wins writes (e.g. a single progress field) — NEVER for
   * partial merges whose fields differ, or you'd drop a field.
   */
  coalesceTag?: string;
}

async function withRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (attempt < WRITE_RETRIES) {
        // Serialized already, so a brief backoff lets any in-flight
        // batch/compaction settle before the retry.
        await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
        log(`retry ${attempt + 1}: ${label}`, err);
      }
    }
  }
  throw lastErr;
}

/**
 * Enqueue a project-scoped write. Resolves with the task result, or `undefined`
 * if the write was skipped (stale) or failed after retries (swallowed).
 */
export function enqueueProjectWrite<T>(
  projectId: string,
  label: string,
  task: () => Promise<T>,
  opts: EnqueueOpts = {}
): Promise<T | undefined> {
  const id = ++seq;
  const tagKey = opts.coalesceTag ? `${projectId}::${opts.coalesceTag}` : null;
  if (tagKey) latestCoalesceSeq.set(tagKey, id);
  log(`queued #${id} ${label} (${projectId})`);

  const prev = chains.get(projectId) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined) // a prior failure must not break the chain
    .then(async () => {
      if (tagKey && latestCoalesceSeq.get(tagKey) !== id) {
        log(`skipped #${id} ${label} (stale)`);
        return undefined;
      }
      log(`started #${id} ${label}`);
      try {
        const result = await withRetry(label, task);
        log(`completed #${id} ${label}`);
        return result;
      } catch (err) {
        // Swallow — a persistence race must never crash the page (req #6).
        // eslint-disable-next-line no-console
        console.warn(`[write-queue] failed #${id} ${label} (swallowed)`, err);
        return undefined;
      }
    });

  chains.set(projectId, run);
  return run;
}

/** Wait until all currently-queued writes for a project have drained. */
export async function flushProjectWrites(projectId: string): Promise<void> {
  const chain = chains.get(projectId);
  if (chain) await chain.catch(() => undefined);
}

/** Mark a project's chunked analysis active (so compaction/repair can defer). */
export function setAnalysisActive(projectId: string, active: boolean): void {
  if (active) activeAnalysis.add(projectId);
  else activeAnalysis.delete(projectId);
}

export function isAnalysisActive(projectId: string): boolean {
  return activeAnalysis.has(projectId);
}
