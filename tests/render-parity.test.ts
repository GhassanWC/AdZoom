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
 *
 * NOTE: the single-vs-chunked TIMELINE-AWARE parity gate IS implemented and
 * runnable (it needs the worker's native deps, so it lives worker-side, not under
 * node --test which can't resolve the worker's runtime `@/` imports):
 *
 *   cd services/export-worker && npm run test:chunk-parity
 *
 * It renders linear / cuts / speed / cuts+speed (and a padded chunk) whole vs
 * chunked, then asserts identical frame count + high PSNR (seam/seek correctness)
 * + final duration/audio parity (the global audio pass).
 */
import { test } from "node:test";

test(
  "worker frames match browser goldens within tolerance",
  { skip: "requires services/export-worker native deps + golden frames — see README" },
  () => {
    // Intentionally empty — see the file header for the implementation plan.
  }
);
