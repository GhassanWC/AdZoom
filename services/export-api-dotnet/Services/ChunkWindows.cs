namespace ExportApi.Services;

/// <summary>
/// One chunk's render/emit windows, in integer OUTPUT frames + output seconds.
/// </summary>
public readonly record struct ChunkWindow(
    int Index,
    int TrimStartFrame,
    int TrimEndFrame,
    int RenderStartFrame,
    int RenderEndFrame,
    double TrimStartSec,
    double TrimEndSec,
    double RenderStartSec,
    double RenderEndSec);

/// <summary>
/// Integer-frame chunk-window tiling — the C# MIRROR of
/// src/lib/export/chunk-window.ts (and the worker's render loop). Tiling by FRAMES
/// (not seconds) guarantees adjacent chunks share their boundary EXACTLY (no
/// dropped/duplicated frame at the concat seam) and that the per-chunk emit windows
/// sum to totalFrames. MUST stay in sync with the TS helper — both are covered by
/// tiling-invariant unit tests. JS `Math.round` is round-half-away-from-zero for
/// the non-negative values used here, so we use MidpointRounding.AwayFromZero to
/// match it exactly.
/// </summary>
public static class ChunkWindows
{
    public static int TotalOutputFrames(double outputDurationSeconds, double fps) =>
        Math.Max(1, (int)Math.Round(outputDurationSeconds * fps, MidpointRounding.AwayFromZero));

    public static ChunkWindow Derive(
        int index,
        int chunkCount,
        double chunkSeconds,
        double fps,
        double outputDurationSeconds,
        double paddingSeconds)
    {
        var total = TotalOutputFrames(outputDurationSeconds, fps);
        var count = Math.Max(1, chunkCount);
        var step = Math.Max(1, (int)Math.Round(chunkSeconds * fps, MidpointRounding.AwayFromZero));
        var padFrames = Math.Max(
            0,
            (int)Math.Round(Math.Max(0, paddingSeconds) * fps, MidpointRounding.AwayFromZero));

        var i = Math.Max(0, Math.Min(count - 1, index));
        var trimStart = Math.Min(total, i * step);
        var trimEnd = i == count - 1 ? total : Math.Min(total, (i + 1) * step);
        var renderStart = Math.Max(0, trimStart - padFrames);
        var renderEnd = Math.Min(total, trimEnd + padFrames);

        return new ChunkWindow(
            i,
            trimStart,
            trimEnd,
            renderStart,
            renderEnd,
            trimStart / fps,
            trimEnd / fps,
            renderStart / fps,
            renderEnd / fps);
    }
}
