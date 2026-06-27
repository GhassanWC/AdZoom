using ExportApi.Services;
using Xunit;

namespace ExportApi.Tests;

/// <summary>
/// Tiling invariants for <see cref="ChunkWindows"/> — the C# MIRROR of
/// src/lib/export/chunk-window.ts. These MUST match the TS unit tests
/// (tests/chunk-window.test.ts): adjacent chunks share their boundary exactly and
/// the per-chunk emit windows sum to totalFrames, so the concat seam never drops
/// or duplicates a frame and the worker (which re-derives the same math) agrees.
/// </summary>
public class ChunkWindowsTests
{
    private static void AssertTiles(
        int chunkCount, double chunkSeconds, double fps, double outputDuration, double padding)
    {
        var total = ChunkWindows.TotalOutputFrames(outputDuration, fps);
        var windows = new ChunkWindow[chunkCount];
        for (var i = 0; i < chunkCount; i++)
            windows[i] = ChunkWindows.Derive(i, chunkCount, chunkSeconds, fps, outputDuration, padding);

        Assert.Equal(0, windows[0].TrimStartFrame);
        Assert.Equal(total, windows[^1].TrimEndFrame);

        var sum = 0;
        for (var i = 0; i < chunkCount; i++)
        {
            var w = windows[i];
            Assert.True(w.TrimEndFrame > w.TrimStartFrame, $"chunk {i} emit window must be non-empty");
            Assert.True(w.RenderStartFrame <= w.TrimStartFrame, $"chunk {i} render start <= trim start");
            Assert.True(w.RenderEndFrame >= w.TrimEndFrame, $"chunk {i} render end >= trim end");
            Assert.True(w.RenderStartFrame >= 0 && w.RenderEndFrame <= total, $"chunk {i} render in [0,total]");
            if (i < chunkCount - 1)
                Assert.Equal(windows[i + 1].TrimStartFrame, w.TrimEndFrame); // adjacency (no gap/overlap)
            sum += w.TrimEndFrame - w.TrimStartFrame;
        }
        Assert.Equal(total, sum); // exact: no dropped/duplicated frame
    }

    [Fact]
    public void Linear6MinTilesExactly()
    {
        // 360s @ 30fps, chunkSeconds 90 → ceil(360/90)=4 chunks.
        AssertTiles(chunkCount: 4, chunkSeconds: 90, fps: 30, outputDuration: 360, padding: 0);
    }

    [Fact]
    public void NonIntegerFpsStillTiles()
    {
        AssertTiles(4, 120, 29.97, 420.5, 0);
        AssertTiles(8, 120, 29.97, 901.3, 0);
    }

    [Fact]
    public void LastChunkAbsorbsRemainder()
    {
        // 370s @ 30fps, step = 3600; chunkCount = ceil(370/120)=4.
        var total = ChunkWindows.TotalOutputFrames(370, 30);
        var last = ChunkWindows.Derive(3, 4, 120, 30, 370, 0);
        Assert.Equal(total, last.TrimEndFrame);
        Assert.Equal(3 * 3600, last.TrimStartFrame);
        Assert.True(last.TrimEndFrame > last.TrimStartFrame);
    }

    [Fact]
    public void PaddingZeroRenderEqualsTrim()
    {
        for (var i = 0; i < 4; i++)
        {
            var w = ChunkWindows.Derive(i, 4, 120, 30, 480, 0);
            Assert.Equal(w.TrimStartFrame, w.RenderStartFrame);
            Assert.Equal(w.TrimEndFrame, w.RenderEndFrame);
        }
    }

    [Fact]
    public void PaddingGrowsAndClamps()
    {
        var total = ChunkWindows.TotalOutputFrames(480, 30); // 14400
        var first = ChunkWindows.Derive(0, 4, 120, 30, 480, 2); // 60-frame pad
        var mid = ChunkWindows.Derive(1, 4, 120, 30, 480, 2);
        var lastW = ChunkWindows.Derive(3, 4, 120, 30, 480, 2);
        Assert.Equal(0, first.RenderStartFrame); // leading pad clamped to 0
        Assert.Equal(first.TrimEndFrame + 60, first.RenderEndFrame);
        Assert.Equal(mid.TrimStartFrame - 60, mid.RenderStartFrame);
        Assert.Equal(mid.TrimEndFrame + 60, mid.RenderEndFrame);
        Assert.Equal(total, lastW.RenderEndFrame); // trailing pad clamped to total
        AssertTiles(4, 120, 30, 480, 2); // emit windows still tile with padding
    }

    [Fact]
    public void TilingHoldsAcrossSweep()
    {
        double[] fpsOptions = { 30, 60, 29.97 };
        foreach (var fps in fpsOptions)
            for (var dur = 360; dur <= 3600; dur += 137)
                foreach (var chunkSeconds in new[] { 60, 120, 180 })
                {
                    var chunkCount = (int)Math.Ceiling(dur / (double)chunkSeconds);
                    AssertTiles(chunkCount, chunkSeconds, fps, dur, 1);
                }
    }

    [Fact]
    public void IndexClampedToRange()
    {
        Assert.Equal(3, ChunkWindows.Derive(99, 4, 120, 30, 480, 0).Index);
        Assert.Equal(0, ChunkWindows.Derive(-5, 4, 120, 30, 480, 0).Index);
    }
}
