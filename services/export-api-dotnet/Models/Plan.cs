namespace ExportApi.Models;

/// <summary>
/// Plan tiers + cloud-minute math. 1:1 port of src/lib/usage/plan.ts and
/// src/lib/usage/cloud-minutes.ts so the C# enqueue gate matches the app.
/// </summary>
public static class Plan
{
    public const string Free = "free";
    public const string Pro = "pro";
    public const string Creator = "creator";

    /// <summary>Monthly cloud-export minute quota per tier (matches
    /// src/lib/usage/cloud-minutes.ts: Free 0, Pro 150, Creator 500).</summary>
    public static readonly IReadOnlyDictionary<string, int> CloudExportMinutes =
        new Dictionary<string, int> { [Free] = 0, [Pro] = 150, [Creator] = 500 };

    /// <summary>Coerce an unknown user.plan value to a known tier (default free).</summary>
    public static string Normalize(string? raw) =>
        raw is Pro or Creator ? raw : Free;

    private static int Rank(string p) => p == Creator ? 2 : p == Pro ? 1 : 0;

    public static bool MeetsMinimum(string actual, string minimum) => Rank(actual) >= Rank(minimum);

    public static bool AllowsCloudExport(string plan) => Limit(plan) > 0;

    public static int Limit(string plan) => CloudExportMinutes.TryGetValue(plan, out var v) ? v : 0;

    /// <summary>Whole minutes, rounded up, floor of 1.</summary>
    public static int EstimateMinutes(double outputDurationSeconds)
    {
        if (double.IsNaN(outputDurationSeconds) || double.IsInfinity(outputDurationSeconds) || outputDurationSeconds <= 0)
            return 1;
        return Math.Max(1, (int)Math.Ceiling(outputDurationSeconds / 60.0));
    }

    private static int Used(long reserved, long consumed) =>
        (int)Math.Max(0, reserved) + (int)Math.Max(0, consumed);

    public static int Remaining(string plan, long reserved, long consumed) =>
        Math.Max(0, Limit(plan) - Used(reserved, consumed));

    public static bool CanCloudExport(string plan, long reserved, long consumed, int estimate) =>
        AllowsCloudExport(plan) && Remaining(plan, reserved, consumed) >= estimate;
}
