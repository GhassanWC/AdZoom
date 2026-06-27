/**
 * Unit tests for chunk-window — the integer-frame tiling that guarantees chunked
 * exports TILE the output with no gap/overlap and no off-by-one at the seams.
 * Pure module (no `@/` / server-only), imports cleanly under `node --test`.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveChunkWindow,
  deriveAllChunkWindows,
  totalOutputFrames,
  type ChunkTilingInput,
} from "../src/lib/export/chunk-window.ts";

/** Assert the core invariants: adjacency (no gap/overlap) + exact sum == total. */
function assertTiles(input: ChunkTilingInput): void {
  const total = totalOutputFrames(input.outputDurationSeconds, input.fps);
  const windows = deriveAllChunkWindows(input);

  // First chunk starts at 0, last chunk ends at total.
  assert.equal(windows[0].trimStartFrame, 0, "first chunk must start at frame 0");
  assert.equal(
    windows[windows.length - 1].trimEndFrame,
    total,
    "last chunk must end at totalFrames"
  );

  let sum = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    // Non-empty emit window.
    assert.ok(w.trimEndFrame > w.trimStartFrame, `chunk ${i} emit window must be non-empty`);
    // Render window contains the emit window.
    assert.ok(w.renderStartFrame <= w.trimStartFrame, `chunk ${i} render start <= trim start`);
    assert.ok(w.renderEndFrame >= w.trimEndFrame, `chunk ${i} render end >= trim end`);
    // Clamp to [0, total].
    assert.ok(w.renderStartFrame >= 0 && w.renderEndFrame <= total, `chunk ${i} render in [0,total]`);
    // Adjacency: this chunk's emit end == next chunk's emit start.
    if (i < windows.length - 1) {
      assert.equal(
        w.trimEndFrame,
        windows[i + 1].trimStartFrame,
        `chunk ${i}/${i + 1} seam must be adjacent (no gap/overlap)`
      );
    }
    sum += w.trimEndFrame - w.trimStartFrame;
  }
  assert.equal(sum, total, "emitted frames across chunks must sum to exactly totalFrames");
}

test("linear 6-min @30fps tiles exactly (4 chunks of 90s)", () => {
  // 360s @ 30fps = 10800 frames; chunkSeconds 90 → ceil(360/90)=4 chunks.
  assertTiles({ outputDurationSeconds: 360, fps: 30, chunkCount: 4, chunkSeconds: 90 });
});

test("non-integer chunkSeconds*fps still tiles (29.97fps)", () => {
  assertTiles({ outputDurationSeconds: 420.5, fps: 29.97, chunkCount: 4, chunkSeconds: 120 });
  assertTiles({ outputDurationSeconds: 901.3, fps: 29.97, chunkCount: 8, chunkSeconds: 120 });
});

test("last chunk absorbs the remainder and is non-empty", () => {
  // 370s @ 30fps = 11100 frames; step = 120*30 = 3600; chunkCount = ceil(370/120)=4.
  const input: ChunkTilingInput = {
    outputDurationSeconds: 370,
    fps: 30,
    chunkCount: 4,
    chunkSeconds: 120,
  };
  const windows = deriveAllChunkWindows(input);
  const total = totalOutputFrames(370, 30);
  assert.equal(windows.length, 4);
  assert.equal(windows[3].trimEndFrame, total);
  assert.equal(windows[3].trimStartFrame, 3 * 3600);
  assert.ok(windows[3].trimEndFrame > windows[3].trimStartFrame);
});

test("padding 0 → render window equals trim window", () => {
  // 480s @ 30fps, chunkSeconds 120 → ceil(480/120)=4 chunks.
  const input: ChunkTilingInput = {
    outputDurationSeconds: 480,
    fps: 30,
    chunkCount: 4,
    chunkSeconds: 120,
    paddingSeconds: 0,
  };
  for (const w of deriveAllChunkWindows(input)) {
    assert.equal(w.renderStartFrame, w.trimStartFrame, `chunk ${w.index} render start == trim start`);
    assert.equal(w.renderEndFrame, w.trimEndFrame, `chunk ${w.index} render end == trim end`);
  }
});

test("padding grows render window and clamps at [0, total]", () => {
  // 480s @ 30fps, chunkSeconds 120 → 4 uniform chunks of 3600 frames.
  const input: ChunkTilingInput = {
    outputDurationSeconds: 480,
    fps: 30,
    chunkCount: 4,
    chunkSeconds: 120,
    paddingSeconds: 2, // 60 frames each side
  };
  const total = totalOutputFrames(480, 30);
  const windows = deriveAllChunkWindows(input);
  // First chunk clamps the leading pad to 0.
  assert.equal(windows[0].renderStartFrame, 0);
  assert.equal(windows[0].renderEndFrame, windows[0].trimEndFrame + 60);
  // Last chunk clamps the trailing pad to total.
  assert.equal(windows[3].renderEndFrame, total);
  assert.equal(windows[3].renderStartFrame, windows[3].trimStartFrame - 60);
  // A middle chunk grows on both sides.
  assert.equal(windows[1].renderStartFrame, windows[1].trimStartFrame - 60);
  assert.equal(windows[1].renderEndFrame, windows[1].trimEndFrame + 60);
  // Emit windows still tile exactly regardless of padding.
  assertTiles(input);
});

test("tiling holds across a sweep of durations/fps/chunkings", () => {
  const fpsOptions = [30, 60, 29.97];
  for (const fps of fpsOptions) {
    for (let dur = 360; dur <= 3600; dur += 137) {
      for (const chunkSeconds of [60, 120, 180]) {
        const chunkCount = Math.ceil(dur / chunkSeconds);
        assertTiles({ outputDurationSeconds: dur, fps, chunkCount, chunkSeconds, paddingSeconds: 1 });
      }
    }
  }
});

test("single-chunk degenerate case tiles to the whole output", () => {
  const input: ChunkTilingInput = {
    outputDurationSeconds: 90,
    fps: 30,
    chunkCount: 1,
    chunkSeconds: 120,
  };
  const w = deriveChunkWindow(0, input);
  assert.equal(w.trimStartFrame, 0);
  assert.equal(w.trimEndFrame, totalOutputFrames(90, 30));
});

test("index is clamped to valid range", () => {
  const input: ChunkTilingInput = {
    outputDurationSeconds: 480,
    fps: 30,
    chunkCount: 4,
    chunkSeconds: 120,
  };
  // Out-of-range index clamps to the last chunk rather than producing garbage.
  assert.equal(deriveChunkWindow(99, input).index, 3);
  assert.equal(deriveChunkWindow(-5, input).index, 0);
});
