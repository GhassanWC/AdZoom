#!/usr/bin/env node
/**
 * Generate Framevo favicon / app-icon assets into /public from the brand mark.
 *
 *   node scripts/gen-icons.mjs   (or: npm run gen:icons)
 *
 * Renders a SOLID violet-background version of the Framevo mark (the "F" with
 * camera-viewfinder brackets + red record dot) — a transparent glyph makes a
 * poor favicon (invisible on dark search-result rows), so we bake in the brand
 * gradient background and use a white mark for contrast at 16px.
 *
 * Outputs:
 *   public/favicon.ico        (16 + 32 + 48, PNG-in-ICO)
 *   public/icon.svg           (scalable, solid bg)
 *   public/icon.png           (512x512 — generic + Organization JSON-LD logo)
 *   public/apple-icon.png     (180x180 — iOS home screen)
 *   public/icon-192.png       (192x192 — PWA manifest)
 *   public/icon-512.png       (512x512 — PWA manifest)
 *
 * Uses `sharp` (already a transitive dependency of Next.js).
 */

import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
mkdirSync(publicDir, { recursive: true });

// Master mark — viewBox only so it scales. Violet gradient bg + white mark.
const MARK = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8B5CF6"/>
      <stop offset="100%" stop-color="#6D28D9"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="20" fill="url(#bg)"/>
  <g stroke="#FFFFFF" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M 28 11 H 12 V 27"/>
    <path d="M 72 11 H 88 V 27"/>
    <path d="M 12 73 V 89 H 28"/>
    <path d="M 88 73 V 89 H 72"/>
  </g>
  <path d="M 26 18 H 79 V 30 H 42 V 44 H 66 V 56 H 42 V 84 H 26 Z" fill="#FFFFFF"/>
  <circle cx="76" cy="26" r="5" fill="#EF4444"/>`;

const svgScalable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Framevo">${MARK}</svg>`;
const svgRender = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100">${MARK}</svg>`;

function buildIco(entries) {
  // entries: [{ size, data: Buffer }]
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0); // width (0 == 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

async function main() {
  // Render once at 1024 for crisp downscaling.
  const base = await sharp(Buffer.from(svgRender)).png().toBuffer();
  const png = (size) => sharp(base).resize(size, size, { fit: "cover" }).png().toBuffer();

  const pngTargets = {
    "icon.png": 512,
    "apple-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
  };
  for (const [name, size] of Object.entries(pngTargets)) {
    writeFileSync(path.join(publicDir, name), await png(size));
    console.log("· wrote public/" + name + " (" + size + "px)");
  }

  writeFileSync(path.join(publicDir, "icon.svg"), svgScalable + "\n");
  console.log("· wrote public/icon.svg");

  const icoSizes = [16, 32, 48];
  const icoEntries = await Promise.all(
    icoSizes.map(async (size) => ({ size, data: await png(size) }))
  );
  writeFileSync(path.join(publicDir, "favicon.ico"), buildIco(icoEntries));
  console.log("· wrote public/favicon.ico (" + icoSizes.join("/") + ")");

  console.log("\n✓ Framevo icons generated.");
}

main().catch((err) => {
  console.error("✗ icon generation failed:", err);
  process.exit(1);
});
