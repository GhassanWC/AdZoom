namespace ExportApi.Models;

/// <summary>Plan doesn't allow cloud export (Free). → 402 cloud_export_requires_paid.</summary>
public sealed class PlanNotAllowedException(string actual) : Exception
{
    public string Actual { get; } = actual;
}

/// <summary>4K/60fps requested on a sub-Pro plan. → 402 tier_requires_pro.</summary>
public sealed class TierRequiresProException(string actual) : Exception
{
    public string Actual { get; } = actual;
}

/// <summary>Not enough cloud minutes left this month. → 429 cloud_minutes_exhausted.</summary>
public sealed class MinutesExhaustedException(int remaining, int requested, string plan) : Exception
{
    public int Remaining { get; } = remaining;
    public int Requested { get; } = requested;
    public string Plan { get; } = plan;
}
