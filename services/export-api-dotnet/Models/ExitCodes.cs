namespace ExportApi.Models;

/// <summary>
/// Process exit codes the one-shot Batch container returns. Google Cloud Batch reads
/// the container's exit code to decide retry/fail; we use a DISTINCT code for a
/// deterministic worker failure so the job spec's lifecycle policy can FAIL_TASK it
/// without a retry (a fresh VM would just fail the same way).
/// </summary>
public static class ExitCodes
{
    /// <summary>Clean success.</summary>
    public const int Success = 0;

    /// <summary>Transient/unknown failure — Batch may retry up to maxRetryCount
    /// (crash, preemption, render_failed, upload_failed, …).</summary>
    public const int TransientFailure = 1;

    /// <summary>User-initiated cancel — not a system failure (mirrors the Node CLI's
    /// exit 2).</summary>
    public const int Canceled = 2;

    /// <summary>
    /// DETERMINISTIC failure (bad input / unsupported codec / un-chunkable timeline /
    /// missing source). Batch's lifecyclePolicies map THIS code to FAIL_TASK so it is
    /// never retried. MUST stay in sync with FATAL_EXIT_CODE in
    /// src/lib/export/batch-backend.ts.
    /// </summary>
    public const int Fatal = 42;
}
