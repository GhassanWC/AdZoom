/**
 * Build the desktop app icon from the brand artwork.
 *
 *   public/icon.png (512×512)  →  desktop/assets/icon.ico   (Windows)
 *                              →  desktop/assets/icon.png   (Linux, dev window)
 *
 * WHY THIS EXISTS RATHER THAN JUST REUSING public/favicon.ico
 * -----------------------------------------------------------
 * That file tops out at 48×48 — fine for a browser tab, and the reason the
 * Windows taskbar, Alt-Tab and the installer all want 256×256 and would have to
 * upscale a 48px bitmap. A blurry app icon is the first thing a user sees.
 *
 * WHY A SCRIPT AND A COMMITTED OUTPUT
 * -----------------------------------
 * The .ico is committed (packaging must not depend on a generation step that
 * could silently be skipped), but it is DERIVED, and a derived binary with no
 * recorded recipe is one nobody dares regenerate. Run `npm run make:icon` after
 * changing the artwork.
 *
 * FORMAT NOTE — why the entries are not all PNG
 * ---------------------------------------------
 * An .ico may store each size as either a BMP (DIB) or a PNG. Windows has
 * understood PNG entries since Vista, but the tools around packaging are older
 * and less consistent than Windows itself (rcedit stamps these into the exe's
 * resource table). The convention every icon generator settled on is the safe
 * one, so it is what this follows: BMP below 64px, PNG at 64px and above, where
 * PNG's compression is what keeps the file from reaching a megabyte.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const source = resolve(desktopRoot, "../public/icon.png");
const assetsDir = resolve(desktopRoot, "assets");

/**
 * The sizes Windows actually asks for: 16 (title bar), 24/32 (taskbar, Alt-Tab),
 * 48 (Explorer medium), 64/128 (Explorer large), 256 (jumbo + the installer).
 */
const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** At and above this, store PNG rather than a raw bitmap. */
const PNG_FROM = 64;

/** Draw the source at `size`, with smoothing, on a transparent canvas. */
function render(image, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, size, size);
  return canvas;
}

/**
 * A 32-bit BGRA DIB, as an .ico entry expects it.
 *
 * Two details are easy to get wrong and both make Windows render garbage:
 * the header's HEIGHT is DOUBLED (it describes the colour rows plus the legacy
 * AND mask), and the rows are stored BOTTOM-UP. The AND mask itself is written
 * as all-zero — alpha in the BGRA data is what actually cuts the shape out —
 * but it must still be present and its rows padded to a 4-byte boundary.
 */
function toDib(canvas, size) {
  const { data } = canvas.getContext("2d").getImageData(0, 0, size, size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight — colour rows + mask rows
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x += 1) {
      const from = (sourceRow * size + x) * 4;
      const to = (y * size + x) * 4;
      pixels[to] = data[from + 2]; // B
      pixels[to + 1] = data[from + 1]; // G
      pixels[to + 2] = data[from]; // R
      pixels[to + 3] = data[from + 3]; // A
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size); // zeroed: "nothing masked out"
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;
  entries.forEach((entry, i) => {
    const at = i * 16;
    // 256 is stored as 0 — the field is a single byte, so 256 does not fit.
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // colours in palette (0 = truecolour)
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.data)]);
}

const image = await loadImage(source);
mkdirSync(assetsDir, { recursive: true });

const entries = SIZES.map((size) => {
  const canvas = render(image, size);
  return {
    size,
    data: size >= PNG_FROM ? canvas.toBuffer("image/png") : toDib(canvas, size),
  };
});

const ico = buildIco(entries);
writeFileSync(resolve(assetsDir, "icon.ico"), ico);
// The window icon on Linux, and a convenient source for anything else.
writeFileSync(resolve(assetsDir, "icon.png"), render(image, 512).toBuffer("image/png"));

console.log(
  `[make-icon] icon.ico  ${SIZES.join(", ")}  (${(ico.length / 1024).toFixed(1)} KB)`
);
console.log("[make-icon] icon.png  512");
