/**
 * BrowserInteractionProvider — captures real input on the AdZoom tab itself.
 *
 * Scope is strictly "tab": browsers cannot observe input on other windows or
 * the OS desktop. When the user picks an external surface in getDisplayMedia,
 * the recording engine sets `interactionScope: "external"` and the events
 * collected here are noise from our own UI — the analysis pipeline ignores
 * them by reading `interactionScope`.
 *
 * No raw key text is ever stored — only typing burst start/end and key count
 * (privacy). Mouse path is throttled to ~10 Hz to keep the JSON manifest small
 * (a 5-minute recording produces ~30 KB).
 */

import type { Interaction } from "./types";
import type {
  InteractionProvider,
  InteractionProviderCapabilities,
} from "./interaction-provider";

/** Mousemove samples emitted every N ms while the cursor is moving. */
const MOUSEMOVE_SAMPLE_MS = 100;
/** ≥ this many keystrokes in TYPING_BURST_WINDOW count as a typing burst. */
const TYPING_BURST_MIN_KEYS = 3;
const TYPING_BURST_WINDOW_MS = 1000;
/** Idle gap after the last keystroke that closes a typing burst. */
const TYPING_BURST_GAP_MS = 600;
/** Pointer must stay within this many CSS px to count as hovering. */
const HOVER_PIXEL_TOLERANCE = 16;
/** Time-on-target to emit a `hover` event. */
const HOVER_SETTLE_MS = 250;
/** Quiet gap after a scroll that emits a `scrollpause` event. */
const SCROLL_PAUSE_MS = 400;
/** Quiet window across all event types that emits an `idle` start. */
const IDLE_THRESHOLD_MS = 4000;

interface MutableState {
  startedAt: number;
  paused: boolean;
  pausedAccumMs: number;
  pauseStartedAt: number | null;
  events: Interaction[];

  // Mouse path tracking.
  lastMoveX: number | null;
  lastMoveY: number | null;
  lastMoveTs: number | null;
  lastEmittedMoveTs: number | null;

  // Hover tracking.
  hoverStartTs: number | null;
  hoverStartX: number | null;
  hoverStartY: number | null;

  // Typing burst tracking.
  burstStartTs: number | null;
  burstLastTs: number | null;
  burstCount: number;
  burstTimer: ReturnType<typeof setTimeout> | null;

  // Scroll-pause tracking.
  scrollLastTs: number | null;
  scrollTimer: ReturnType<typeof setTimeout> | null;

  // Idle tracking — any user event resets this.
  lastActivityTs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleStartTs: number | null;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `ev_${idSeq.toString(36)}`;
}

function viewportNorm(x: number, y: number): { x: number; y: number } {
  const w = Math.max(1, window.innerWidth || 1);
  const h = Math.max(1, window.innerHeight || 1);
  return { x: clamp01(x / w), y: clamp01(y / h) };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

const CAPABILITIES: InteractionProviderCapabilities = {
  mousePath: true,
  keyEvents: true,
  focusEvents: true,
  crossWindow: false,
};

export function createBrowserInteractionProvider(): InteractionProvider {
  const state: MutableState = {
    startedAt: 0,
    paused: false,
    pausedAccumMs: 0,
    pauseStartedAt: null,
    events: [],
    lastMoveX: null,
    lastMoveY: null,
    lastMoveTs: null,
    lastEmittedMoveTs: null,
    hoverStartTs: null,
    hoverStartX: null,
    hoverStartY: null,
    burstStartTs: null,
    burstLastTs: null,
    burstCount: 0,
    burstTimer: null,
    scrollLastTs: null,
    scrollTimer: null,
    lastActivityTs: 0,
    idleTimer: null,
    idleStartTs: null,
  };

  function tNow(): number {
    if (state.paused && state.pauseStartedAt !== null) {
      return Math.max(0, (state.pauseStartedAt - state.startedAt - state.pausedAccumMs) / 1000);
    }
    return Math.max(0, (performance.now() - state.startedAt - state.pausedAccumMs) / 1000);
  }

  function bumpActivity() {
    const now = performance.now();
    state.lastActivityTs = now;
    if (state.idleStartTs !== null) {
      // Close the idle window.
      const idleStart = state.idleStartTs;
      state.idleStartTs = null;
      state.events.push({
        type: "idle",
        id: nextId(),
        t: Math.max(0, (idleStart - state.startedAt - state.pausedAccumMs) / 1000),
        tEnd: tNow(),
      });
    }
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleStartTs = performance.now();
    }, IDLE_THRESHOLD_MS);
  }

  // ── Mouse path ──
  function onPointerMove(e: PointerEvent) {
    if (state.paused) return;
    const now = performance.now();
    bumpActivity();

    state.lastMoveX = e.clientX;
    state.lastMoveY = e.clientY;
    state.lastMoveTs = now;

    // Hover detection: if pointer stays inside the tolerance for HOVER_SETTLE_MS, emit hover.
    if (
      state.hoverStartTs !== null &&
      state.hoverStartX !== null &&
      state.hoverStartY !== null
    ) {
      const dx = e.clientX - state.hoverStartX;
      const dy = e.clientY - state.hoverStartY;
      if (Math.hypot(dx, dy) > HOVER_PIXEL_TOLERANCE) {
        state.hoverStartTs = now;
        state.hoverStartX = e.clientX;
        state.hoverStartY = e.clientY;
      }
    } else {
      state.hoverStartTs = now;
      state.hoverStartX = e.clientX;
      state.hoverStartY = e.clientY;
    }

    // Throttled mousemove emission.
    if (
      state.lastEmittedMoveTs === null ||
      now - state.lastEmittedMoveTs >= MOUSEMOVE_SAMPLE_MS
    ) {
      const prevX = state.lastEmittedMoveTs !== null ? state.lastMoveX : e.clientX;
      const prevY = state.lastEmittedMoveTs !== null ? state.lastMoveY : e.clientY;
      const dt = state.lastEmittedMoveTs !== null ? (now - state.lastEmittedMoveTs) / 1000 : 0;
      const diag = Math.hypot(window.innerWidth || 1, window.innerHeight || 1);
      const velocity =
        dt > 0
          ? Math.hypot(e.clientX - (prevX ?? e.clientX), e.clientY - (prevY ?? e.clientY)) / dt / diag
          : 0;
      const n = viewportNorm(e.clientX, e.clientY);
      state.events.push({
        type: "mousemove",
        id: nextId(),
        t: tNow(),
        x: n.x,
        y: n.y,
        velocity,
      });
      state.lastEmittedMoveTs = now;
    }
  }

  // ── Clicks ──
  function onPointerDown(e: PointerEvent) {
    if (state.paused) return;
    if (e.button === 2) return; // handled by contextmenu
    bumpActivity();
    // Emit hover-settle if the cursor sat on this target for a while.
    if (state.hoverStartTs !== null) {
      const heldMs = performance.now() - state.hoverStartTs;
      if (heldMs >= HOVER_SETTLE_MS) {
        const n = viewportNorm(state.hoverStartX ?? e.clientX, state.hoverStartY ?? e.clientY);
        state.events.push({
          type: "hover",
          id: nextId(),
          t: tNow(),
          x: n.x,
          y: n.y,
          durationSeconds: heldMs / 1000,
        });
      }
      state.hoverStartTs = null;
    }
    const n = viewportNorm(e.clientX, e.clientY);
    state.events.push({
      type: "click",
      id: nextId(),
      t: tNow(),
      x: n.x,
      y: n.y,
      button: e.button === 1 ? "middle" : "left",
    });
  }

  function onDblClick(e: MouseEvent) {
    if (state.paused) return;
    bumpActivity();
    const n = viewportNorm(e.clientX, e.clientY);
    state.events.push({ type: "dblclick", id: nextId(), t: tNow(), x: n.x, y: n.y });
  }

  function onContextMenu(e: MouseEvent) {
    if (state.paused) return;
    bumpActivity();
    const n = viewportNorm(e.clientX, e.clientY);
    state.events.push({ type: "rightclick", id: nextId(), t: tNow(), x: n.x, y: n.y });
  }

  // ── Scroll / wheel ──
  function onWheel(e: WheelEvent) {
    if (state.paused) return;
    const now = performance.now();
    bumpActivity();
    const dt =
      state.scrollLastTs !== null ? Math.max(1, now - state.scrollLastTs) : 100;
    const speed = (Math.abs(e.deltaY) * 1000) / dt;
    state.events.push({
      type: "scroll",
      id: nextId(),
      t: tNow(),
      deltaY: e.deltaY,
      speed,
    });
    state.scrollLastTs = now;
    if (state.scrollTimer) clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => {
      const pause = performance.now() - now;
      state.events.push({
        type: "scrollpause",
        id: nextId(),
        t: tNow(),
        pauseSeconds: pause / 1000,
      });
    }, SCROLL_PAUSE_MS);
  }

  // ── Keyboard (typing bursts only — never the keys themselves) ──
  function flushBurst() {
    if (state.burstStartTs !== null && state.burstCount >= TYPING_BURST_MIN_KEYS) {
      const startT = Math.max(0, (state.burstStartTs - state.startedAt - state.pausedAccumMs) / 1000);
      const endT = Math.max(
        startT,
        ((state.burstLastTs ?? state.burstStartTs) - state.startedAt - state.pausedAccumMs) / 1000
      );
      if (endT - startT >= TYPING_BURST_WINDOW_MS / 1000 || state.burstCount >= TYPING_BURST_MIN_KEYS * 2) {
        state.events.push({
          type: "typing",
          id: nextId(),
          t: startT,
          tEnd: endT,
          keyCount: state.burstCount,
        });
      } else if (state.burstCount >= TYPING_BURST_MIN_KEYS) {
        // Shorter but still qualifying burst — emit minimum-duration window.
        state.events.push({
          type: "typing",
          id: nextId(),
          t: startT,
          tEnd: Math.max(endT, startT + 0.6),
          keyCount: state.burstCount,
        });
      }
    }
    state.burstStartTs = null;
    state.burstLastTs = null;
    state.burstCount = 0;
    if (state.burstTimer) {
      clearTimeout(state.burstTimer);
      state.burstTimer = null;
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (state.paused) return;
    // Skip modifier-only / navigation keys — focus on text input bursts.
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    const now = performance.now();
    bumpActivity();
    if (state.burstStartTs === null) state.burstStartTs = now;
    state.burstLastTs = now;
    state.burstCount += 1;
    if (state.burstTimer) clearTimeout(state.burstTimer);
    state.burstTimer = setTimeout(flushBurst, TYPING_BURST_GAP_MS);
  }

  // ── Focus / blur ──
  function onFocusIn() {
    if (state.paused) return;
    bumpActivity();
    state.events.push({ type: "focus", id: nextId(), t: tNow(), direction: "in" });
  }
  function onFocusOut() {
    if (state.paused) return;
    bumpActivity();
    state.events.push({ type: "focus", id: nextId(), t: tNow(), direction: "out" });
  }

  // ── Resize ──
  function onResize() {
    if (state.paused) return;
    bumpActivity();
    state.events.push({
      type: "resize",
      id: nextId(),
      t: tNow(),
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }

  // ── Lifecycle ──
  let attached = false;
  function attach() {
    if (attached) return;
    attached = true;
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("dblclick", onDblClick, { passive: true });
    window.addEventListener("contextmenu", onContextMenu, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", onResize);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("dblclick", onDblClick);
    window.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("focusin", onFocusIn);
    window.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("resize", onResize);
  }

  return {
    scope: "tab",
    capabilities: CAPABILITIES,
    start(startedAt: number) {
      state.startedAt = startedAt;
      state.paused = false;
      state.pausedAccumMs = 0;
      state.pauseStartedAt = null;
      state.events = [];
      state.lastActivityTs = startedAt;
      attach();
    },
    pause() {
      if (state.paused) return;
      state.paused = true;
      state.pauseStartedAt = performance.now();
      flushBurst();
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
    },
    resume() {
      if (!state.paused) return;
      const elapsed = performance.now() - (state.pauseStartedAt ?? performance.now());
      state.pausedAccumMs += elapsed;
      state.paused = false;
      state.pauseStartedAt = null;
      state.lastActivityTs = performance.now();
    },
    events() {
      return state.events.slice();
    },
    async stop() {
      flushBurst();
      if (state.idleTimer) clearTimeout(state.idleTimer);
      if (state.scrollTimer) clearTimeout(state.scrollTimer);
      detach();
      return state.events.slice();
    },
  };
}
