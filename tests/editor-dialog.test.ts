/**
 * Editor dialog closing behaviour — the "don't accidentally close" rule.
 * The rest of the dialog behaviour (focus trap/restore, Esc, scroll lock,
 * backdrop DOM wiring) is DOM-integration verified manually + by tsc/build; this
 * locks the pure decision that prevents a slider/dropdown/drag interaction from
 * dismissing the dialog when the pointer releases over the backdrop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldCloseOnBackdrop,
  shouldCloseOnOutsidePress,
} from "@/components/dashboard/real-editor/editor-dialog-behavior";

test("backdrop click closes ONLY when the press started AND ended on the backdrop", () => {
  // Clean click on the backdrop → close.
  assert.equal(
    shouldCloseOnBackdrop({ pressStartedOnBackdrop: true, releaseTargetIsBackdrop: true }),
    true
  );
  // Press started INSIDE the dialog (slider/dropdown/drag), released on backdrop → DON'T close.
  assert.equal(
    shouldCloseOnBackdrop({ pressStartedOnBackdrop: false, releaseTargetIsBackdrop: true }),
    false
  );
  // Press started on backdrop but released inside the dialog → DON'T close.
  assert.equal(
    shouldCloseOnBackdrop({ pressStartedOnBackdrop: true, releaseTargetIsBackdrop: false }),
    false
  );
  // Wholly inside the dialog → never closes.
  assert.equal(
    shouldCloseOnBackdrop({ pressStartedOnBackdrop: false, releaseTargetIsBackdrop: false }),
    false
  );
});

test("floating dialog closes only on presses fully outside card AND hold regions", () => {
  const base = {
    pressInsideCard: false,
    releaseInsideCard: false,
    pressInsideHold: false,
    releaseInsideHold: false,
  };
  // Clean click on dead space → close.
  assert.equal(shouldCloseOnOutsidePress(base), true);
  // Slider drag that started inside the dialog and released outside → stay open.
  assert.equal(shouldCloseOnOutsidePress({ ...base, pressInsideCard: true }), false);
  assert.equal(shouldCloseOnOutsidePress({ ...base, releaseInsideCard: true }), false);
  // Dragging the crop box on the video (a hold region) → stay open.
  assert.equal(shouldCloseOnOutsidePress({ ...base, pressInsideHold: true }), false);
  // Drag that ends over the timeline (hold region) → stay open.
  assert.equal(shouldCloseOnOutsidePress({ ...base, releaseInsideHold: true }), false);
});
