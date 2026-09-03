/**
 * Screenshot the Framevo AI panel states from the dev preview page.
 *
 *   1. next dev must be running (any port; pass BASE_URL, default :3999)
 *   2. node scripts/shoot-framevo-ai.mjs <outDir>
 *
 * Writes one PNG per [data-shot] frame.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3999";
const outDir = process.argv[2] ?? "framevo-ai-shots";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 3000, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await page.goto(`${BASE_URL}/dev/framevo-ai-preview`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500); // fonts + enter animations settle

/** Scroll the frame's inner container so expanded sections are what we shoot. */
const SCROLL_PX = {
  "setup-change": 620,
  "setup-advanced": 620,
};

const frames = await page.locator("[data-shot]").all();
for (const frame of frames) {
  const name = await frame.getAttribute("data-shot");
  const px = SCROLL_PX[name];
  if (px) {
    await frame
      .locator("div.overflow-y-auto")
      .first()
      .evaluate((el, top) => {
        el.scrollTop = top;
      }, px);
    await page.waitForTimeout(300);
  }
  const file = path.join(outDir, `${name}.png`);
  await frame.screenshot({ path: file });
  console.log(`shot: ${file}`);
}
await browser.close();
