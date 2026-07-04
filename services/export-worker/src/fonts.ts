/**
 * Multilingual font registration + startup diagnostic for the render runtime.
 *
 * The shared overlay renderer (src/lib/render/overlay-draw.ts) resolves a
 * script-appropriate font family per text (Noto Sans + Arabic/Hebrew/Devanagari/
 * CJK/Thai variants). @napi-rs/canvas (Skia) can only USE those if the OS has them
 * — so the Dockerfile installs fonts-noto-*, and this loads them into Skia and
 * reports, at boot, which officially-supported scripts have a font (warning loudly
 * when one is missing, so a fontless image fails visibly instead of shipping boxed
 * glyphs). Idempotent; safe to call from both the server and the CLI entrypoints.
 */
import { GlobalFonts } from "@napi-rs/canvas";
import { checkFontAvailability } from "@/lib/render/text-shaping";

let done = false;

export function registerAndDiagnoseFonts(): void {
  if (done) return;
  done = true;

  // @napi-rs/canvas auto-registers system (fontconfig) fonts on Linux; some
  // versions also expose an explicit loader — call it when present (typed
  // optionally so this compiles across versions), else rely on auto-registration.
  let systemFontsLoaded = 0;
  try {
    const g = GlobalFonts as unknown as { loadSystemFonts?: () => number };
    if (typeof g.loadSystemFonts === "function") systemFontsLoaded = g.loadSystemFonts();
  } catch (err) {
    console.warn("[worker:fonts] loadSystemFonts failed", err instanceof Error ? err.message : err);
  }

  const diag = checkFontAvailability((family) => {
    try {
      return GlobalFonts.has(family);
    } catch {
      return false;
    }
  });

  if (diag.ok) {
    console.info("[worker:fonts] all required script fonts present", {
      systemFontsLoaded,
      available: diag.available,
      emojiAvailable: diag.emojiAvailable,
    });
  } else {
    console.warn(
      "[worker:fonts] MISSING script fonts — these scripts will render as missing-glyph boxes in export",
      {
        systemFontsLoaded,
        missing: diag.missing,
        emojiAvailable: diag.emojiAvailable,
        hint: "install fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji (see Dockerfile)",
      }
    );
  }
  // Emoji is optional (doesn't fail the run) but still worth a soft warning.
  if (!diag.emojiAvailable) {
    console.warn("[worker:fonts] no color-emoji font — emoji in overlays will box (install fonts-noto-color-emoji)");
  }
}
