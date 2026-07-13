/**
 * Unit tests for menu-placement — the rules that keep an editor dropdown
 * REACHABLE. The bug these exist to prevent: the editor shell is overflow-hidden,
 * so a menu that overhangs the timeline pane gets clipped and its lower options
 * become unclickable. A menu must therefore never be placed off-screen, never be
 * taller than the room it has (it scrolls instead), and only flip above the
 * trigger when flipping actually buys space.
 *
 * Pure module, imports cleanly under `node --test`.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  placeMenu,
  MENU_GAP,
  MENU_MARGIN,
  MENU_MIN_HEIGHT,
  type MenuPlacementInput,
} from "../src/lib/ui/menu-placement.ts";

/** A 1280×800 window with the trigger where the timeline control bar sits. */
function input(over: Partial<MenuPlacementInput> = {}): MenuPlacementInput {
  return {
    trigger: { left: 200, right: 260, top: 500, bottom: 536 },
    viewport: { width: 1280, height: 800 },
    width: 208,
    naturalHeight: 420,
    align: "left",
    ...over,
  };
}

/** The panel's occupied band, whichever way it was placed. */
function band(p: ReturnType<typeof placeMenu>, viewportHeight: number) {
  const top = p.top ?? viewportHeight - (p.bottom ?? 0) - p.maxHeight;
  return { top, bottom: top + p.maxHeight };
}

test("a menu that fits below hangs below the trigger", () => {
  const p = placeMenu(input({ naturalHeight: 180 }));
  assert.equal(p.top, 536 + MENU_GAP);
  assert.equal(p.bottom, undefined);
  assert.equal(p.scrolls, false, "it fits — no scrolling");
});

test("a menu too tall for the space below flips above when there is more room", () => {
  // 264px below the trigger, 500px above it → above wins.
  const p = placeMenu(input({ naturalHeight: 420 }));
  assert.equal(p.top, undefined);
  assert.equal(p.bottom, 800 - 500 + MENU_GAP, "sits on the trigger's top edge");
  assert.ok(p.maxHeight >= 420, "the whole menu fits above, so it doesn't scroll");
  assert.equal(p.scrolls, false);
});

test("a menu that fits below is NEVER flipped, even with more room above", () => {
  // Same cramped-below geometry, but a short menu — flipping would be motion for
  // nothing, and a dropdown belongs below its trigger.
  const p = placeMenu(input({ naturalHeight: 120 }));
  assert.equal(p.top, 536 + MENU_GAP);
  assert.equal(p.bottom, undefined);
});

test("with room nowhere, it stays below and SCROLLS rather than being cut off", () => {
  // Trigger near the top: little below, almost nothing above. Flipping would be
  // worse. The panel must clamp + scroll, which is what keeps every option
  // reachable — the actual bug.
  const p = placeMenu(
    input({
      trigger: { left: 200, right: 260, top: 60, bottom: 96 },
      viewport: { width: 1280, height: 420 },
      naturalHeight: 900,
    })
  );
  assert.equal(p.top, 96 + MENU_GAP);
  assert.equal(p.maxHeight, 420 - 96 - MENU_GAP - MENU_MARGIN);
  assert.equal(p.scrolls, true, "taller than its room ⇒ it scrolls internally");
});

test("the panel never spills past the bottom of the window", () => {
  for (const height of [320, 480, 640, 800, 1080]) {
    for (const top of [40, 200, 400, 600, 900]) {
      if (top + 36 > height) continue;
      const p = placeMenu(
        input({
          trigger: { left: 200, right: 260, top, bottom: top + 36 },
          viewport: { width: 1280, height },
          naturalHeight: 900,
        })
      );
      const { top: t, bottom: b } = band(p, height);
      assert.ok(t >= 0, `panel starts above the window top (h=${height}, top=${top})`);
      // MIN_HEIGHT may overhang a truly tiny window — a scrollable menu that
      // overhangs is still operable; a clipped one is not. Everywhere there is
      // real room, it must stay inside.
      if (p.maxHeight > MENU_MIN_HEIGHT) {
        assert.ok(
          b <= height,
          `panel spills past the window bottom (h=${height}, top=${top}, b=${b})`
        );
      }
    }
  }
});

test("a right-aligned menu lines up with the trigger's right edge", () => {
  const p = placeMenu(
    input({
      trigger: { left: 1000, right: 1060, top: 500, bottom: 536 },
      align: "right",
      width: 256,
    })
  );
  assert.equal(p.left, 1060 - 256);
});

test("a menu near the right edge is pulled back on-screen", () => {
  const p = placeMenu(
    input({
      trigger: { left: 1240, right: 1274, top: 500, bottom: 536 },
      align: "right",
      width: 256,
    })
  );
  assert.equal(p.left, 1280 - 256 - MENU_MARGIN, "clamped to the margin, not off-screen");
  assert.ok(p.left + p.width <= 1280 - MENU_MARGIN);
});

test("a menu near the left edge is pushed back on-screen", () => {
  const p = placeMenu(
    input({ trigger: { left: 2, right: 40, top: 500, bottom: 536 }, align: "left" })
  );
  assert.equal(p.left, MENU_MARGIN);
});

test("a menu wider than the window still starts on-screen", () => {
  const p = placeMenu(input({ viewport: { width: 240, height: 800 }, width: 400 }));
  assert.equal(p.left, MENU_MARGIN, "degrades to the left margin rather than negative");
});

test("first pass (height not measured yet) places below and never flips", () => {
  // naturalHeight 0 = the panel isn't in the DOM yet. It must not flip on a
  // guess; the measured second pass is what decides.
  const p = placeMenu(input({ naturalHeight: 0 }));
  assert.equal(p.top, 536 + MENU_GAP);
  assert.equal(p.bottom, undefined);
});
