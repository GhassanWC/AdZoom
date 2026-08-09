/**
 * Writes that nothing is waiting for.
 *
 * ── The trap this exists for ────────────────────────────────────────────────
 * Drizzle's query builder is LAZY. It is a thenable whose `then()` is what calls
 * `execute()`, so a statement that is never awaited is never RUN:
 *
 *     void db.update(exports).set({ status: "ready" }).where(eq(id, outputId));
 *
 * That line type-checks, reads exactly like a deliberate fire-and-forget write,
 * and does nothing at all. It is how every finished local export stayed
 * `pending` in the database — the app showed a spinner beside a file that had
 * been sitting on disk for days, because the row still said it was rendering.
 *
 * `Promise.resolve()` on the builder is what starts it. The catch is not
 * decoration either: an unawaited rejection here would take the whole main
 * process down under Node's default unhandled-rejection policy, for what is only
 * bookkeeping.
 */
export function fireAndForget(
  query: PromiseLike<unknown>,
  what: string,
  onError: (message: string, meta: Record<string, unknown>) => void
): void {
  void Promise.resolve(query).catch((err: unknown) => {
    onError("database write failed", {
      what,
      message: err instanceof Error ? err.message : String(err),
    });
  });
}
