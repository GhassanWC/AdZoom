/**
 * Render parity gate (placeholder) — the test that must be GREEN before
 * `CLOUD_EXPORT_ENABLED` is flipped on. It renders a handful of frames with the
 * worker's canvas pipeline and diffs them against browser-captured goldens:
 *
 *   - a clip with a mid cut + a speed section   → A/V + timeline alignment
 *   - a saturated clip                          → BT.709 color parity
 *   - a vertical Fit clip with a blur background → @napi-rs/canvas blur parity
 *
 * Tolerance: mean abs < 2/255, max < 8/255 per channel.
 *
 * Skipped here because it needs the worker's native deps (`@napi-rs/canvas`,
 * `ffmpeg-static`) installed under `services/export-worker` AND the stored
 * golden PNGs. See `services/export-worker/README.md`. Implement by importing
 * the worker's `renderToMp4` against fixture clips and decoding sample frames.
 */
import { test } from "node:test";

test(
  "worker frames match browser goldens within tolerance",
  { skip: "requires services/export-worker native deps + golden frames — see README" },
  () => {
    // Intentionally empty — see the file header for the implementation plan.
  }
);
