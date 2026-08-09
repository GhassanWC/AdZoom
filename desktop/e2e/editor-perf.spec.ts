/**
 * Editor render-cost + frame-time measurement, driven against the REAL desktop
 * app in BOTH build modes.
 *
 * WHAT THIS ANSWERS
 * -----------------
 * "Does a scroll / wheel / pointermove / window resize / slider drag / playback
 * tick push React state, and does that re-render the timeline, the inspector or
 * the preview more than once per frame?" — asked with numbers rather than by
 * feel, and asked of BOTH `next dev` and the packaged static build.
 *
 * A development build does roughly the same React work as production, just
 * slower per unit of work. So a scenario that re-renders the whole editor 60
 * times during one drag reports ~60 renders in both modes; only the wall-clock
 * differs. That is exactly why the render COUNT — not the frame time — is the
 * assertion: "production is faster" can never launder an interaction that
 * re-renders the world, but a render count can't be argued with.
 *
 * Run it:
 *   node desktop/scripts/perf-measure.mjs prod     (packaged-shape static build)
 *   node desktop/scripts/perf-measure.mjs dev      (next dev renderer)
 *
 * The instrument is src/lib/perf/render-probe.ts, enabled by the localStorage
 * flag set below — off, it costs a single boolean test per component, which is
 * why it can ship and be measured in the production bundle at all.
 */
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  cleanupDir,
  firebaseApiKey,
  launchApp,
  makeFixtureVideo,
  seedSignedInSession,
  stubDialogs,
  openRoute,
  type LaunchedApp,
} from "./fixtures";

/** Which build we are measuring — set by scripts/perf-measure.mjs. */
const MODE = process.env.FRAMEVO_PERF_MODE === "dev" ? "dev" : "prod";
/** How many edits the measured timeline carries. */
const EDIT_COUNT = Number(process.env.FRAMEVO_PERF_EDITS ?? 40);
const FIXTURE_SECONDS = 30;
/**
 * Ceiling for SETUP steps only (never for a measured window). A dev renderer may
 * still be compiling a route the first time it is navigated to, which is minutes
 * of webpack, not slowness in the thing under test.
 */
const SETUP_TIMEOUT = MODE === "dev" ? 240_000 : 60_000;

declare global {
  interface Window {
    __framevoPerf?: {
      enabled: boolean;
      start(label?: string): void;
      stop(): unknown;
      reset(): void;
      counts(): Record<string, number>;
    };
  }
}

interface FrameStats {
  frames: number;
  durationMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  jankFrames: number;
  longFrames: number;
}
interface PerfReport {
  label: string;
  durationMs: number;
  renders: Record<string, number>;
  totalRenders: number;
  commits: Record<string, { commits: number; totalMs: number; maxMs: number }>;
  frames: FrameStats;
  longTasks: { count: number; totalMs: number; maxMs: number };
  events: Record<string, number>;
}

let workDir: string;
let profileDir: string;
let fixture: string;
let launched: LaunchedApp;
const reports: Array<PerfReport & { interactions: number }> = [];

test.skip(
  !firebaseApiKey(),
  "the renderer was built without NEXT_PUBLIC_FIREBASE_* — sign-in is impossible"
);
// Serial, and long enough that a cold dev compile inside setup can finish. The
// default 180s is sized for the packaged app, where nothing compiles at all.
test.describe.configure({ mode: "serial", timeout: MODE === "dev" ? 900_000 : 300_000 });

// ── measurement helpers ────────────────────────────────────────────────────

/**
 * Run one scenario with the probe recording, and file the report.
 *
 * `interactions` is how many raw input events the scenario generated, so a
 * result can be read as "renders per event" rather than as an absolute that
 * depends on how long the loop happened to run.
 */
async function measure(
  window: Page,
  label: string,
  interactions: number,
  body: () => Promise<void>
): Promise<PerfReport & { interactions: number }> {
  await window.evaluate((l) => window.__framevoPerf!.start(l), label);
  await body();
  // One extra frame so the last interaction's render is inside the window.
  await window.waitForTimeout(120);
  const report = (await window.evaluate(() =>
    window.__framevoPerf!.stop()
  )) as PerfReport;
  const withCount = { ...report, interactions };
  reports.push(withCount);
  const top = Object.entries(report.renders)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `[perf:${MODE}] ${label.padEnd(22)} events=${String(interactions).padStart(3)} ` +
      `renders=${String(report.totalRenders).padStart(5)} ` +
      `p95frame=${report.frames.p95Ms.toFixed(1)}ms max=${report.frames.maxMs.toFixed(1)}ms ` +
      `long=${report.frames.longFrames} | ${top}`
  );
  return withCount;
}

/** Renders of one instrumented component during the last scenario. */
function renders(r: PerfReport, id: string): number {
  return r.renders[id] ?? 0;
}

/** A synthetic timeline — enough edits that a wasted render is measurable. */
function seedMoments(count: number, duration: number) {
  const types = [
    "zoom",
    "cursor-focus",
    "click-highlight",
    "cut",
    "speed-up",
    "caption",
    "hook-text",
  ];
  const span = duration / count;
  return Array.from({ length: count }, (_, i) => ({
    id: `perf-${i}`,
    startTime: +(i * span + 0.05).toFixed(3),
    endTime: +(i * span + span * 0.7).toFixed(3),
    label: `Perf edit ${i}`,
    reason: "seeded for measurement",
    effectType: types[i % types.length],
    focusRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    source: "ai",
    confidence: 0.8,
    attentionScore: 0.5,
  }));
}

// ── setup ──────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  // A hook does NOT inherit the describe-level timeout — it takes the project
  // one (180s), which a dev renderer blows through while it compiles the client
  // chunks for the editor. Setting it here is the only thing that raises it.
  test.setTimeout(MODE === "dev" ? 900_000 : 300_000);
  workDir = mkdtempSync(join(tmpdir(), "framevo-perf-"));
  profileDir = mkdtempSync(join(tmpdir(), "framevo-perf-profile-"));
  fixture = makeFixtureVideo(workDir, "perf-fixture.mp4", {
    seconds: FIXTURE_SECONDS,
    size: "1280x720",
  });
  expect(existsSync(fixture)).toBe(true);

  launched = await launchApp({ userDataDir: profileDir });

  // The RENDERER's console, in the run log. Without this a renderer-side failure
  // during setup is invisible: the app just sits on its splash and the run dies
  // on an action timeout that names a locator, not a cause.
  launched.window.on("console", (msg) => {
    console.log(`[renderer:${msg.type()}] ${msg.text()}`);
  });
  launched.window.on("pageerror", (err) => {
    console.log(`[renderer:pageerror] ${err.message}`);
  });

  // Turn the probe on BEFORE the editor ever mounts. `seedSignedInSession`
  // reloads the window, which is what picks the flag up (it is read once, at
  // module load, so the component tree shape can't change mid-session).
  await launched.window.evaluate(() =>
    window.localStorage.setItem("framevo.perf", "1")
  );
  await seedSignedInSession(launched.window);
  await openRoute(launched.window, "/dashboard/projects");
  await stubDialogs(launched.app, { open: fixture });

  const { window } = launched;
  // Generous on purpose: in dev the renderer is `next dev`, so a route the
  // warm-up didn't reach still compiles on first navigation. Setup waiting longer
  // costs nothing — the measurement windows below are opened by hand, after the
  // editor is up and settled, so no compile time can leak into a reported number.
  await window
    .getByRole("link", { name: "Upload", exact: true })
    .first()
    .click({ timeout: SETUP_TIMEOUT });
  await window
    .getByRole("button", { name: /Choose a video/i })
    .click({ timeout: SETUP_TIMEOUT });
  await expect
    .poll(() => window.evaluate(() => window.location.pathname), { timeout: SETUP_TIMEOUT })
    .toMatch(/^\/dashboard\/projects\/.+/);
  await expect(window.getByRole("button", { name: "Export" })).toBeVisible({
    timeout: SETUP_TIMEOUT,
  });

  // A realistic timeline, written straight to the library so the measurement
  // isn't preceded by 40 UI round-trips. The editor's own subscription picks it
  // up exactly as it would after an analysis run.
  const moments = seedMoments(EDIT_COUNT, FIXTURE_SECONDS);
  await window.evaluate(async (payload) => {
    const list = await window.framevo!.projects.list();
    const projectId = list[0]!.id;
    await window.framevo!.projects.write({
      projectId,
      patch: {
        duration: payload.duration,
        analysis: {
          status: "complete",
          detectedMoments: payload.moments,
          boringSections: [],
          completedAt: Date.now(),
        },
      },
    });
  }, { moments, duration: FIXTURE_SECONDS });

  // The pills are on screen and the probe is live before anything is timed.
  await expect
    .poll(async () => window.locator("[data-moment-pill]").count(), { timeout: SETUP_TIMEOUT })
    .toBeGreaterThan(EDIT_COUNT / 4);
  expect(
    await window.evaluate(() => !!window.__framevoPerf?.enabled)
  ).toBe(true);
  await expect
    .poll(
      async () =>
        window.locator("video").first().evaluate((el: HTMLVideoElement) => el.readyState),
      { timeout: SETUP_TIMEOUT }
    )
    .toBeGreaterThanOrEqual(1);
  await window.waitForTimeout(800); // let the first paint settle
});

test.afterAll(async () => {
  if (reports.length) {
    const outDir = resolve(__dirname, "..", "perf-results");
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${MODE}.json`);
    writeFileSync(
      file,
      JSON.stringify({ mode: MODE, edits: EDIT_COUNT, reports }, null, 2)
    );
    console.log(`[perf:${MODE}] wrote ${file}`);
  }
  await launched?.close();
  cleanupDir(workDir);
  cleanupDir(profileDir);
});

// ── the measurement ────────────────────────────────────────────────────────

test("editor interactions do not re-render the editor per input event", async () => {
  const { window, app } = launched;

  // 1. IDLE — the floor. Nothing is happening, so nothing may render.
  const idle = await measure(window, "idle", 0, async () => {
    await window.waitForTimeout(1_500);
  });
  expect.soft(idle.totalRenders, "idle must not render anything").toBeLessThan(3);

  // 2. PLAYBACK — `timeupdate` fires ~4×/s; only components that DRAW the time
  //    may react to it. The timeline, the preview and the control bar must not.
  const video = window.locator("video").first();
  const playback = await measure(window, "playback-3s", 0, async () => {
    await video.evaluate(async (el: HTMLVideoElement) => {
      el.currentTime = 0;
      el.muted = true;
      await el.play().catch(() => undefined);
    });
    await window.waitForTimeout(3_000);
    await video.evaluate((el: HTMLVideoElement) => el.pause());
  });
  expect
    .soft(renders(playback, "timeline"), "playback must not re-render the timeline")
    .toBeLessThan(4);
  expect
    .soft(renders(playback, "preview"), "playback must not re-render the preview")
    .toBeLessThan(4);
  expect
    .soft(renders(playback, "control-bar"), "playback must not re-render the control bar")
    .toBeLessThan(4);

  // 3. WHEEL / SCROLL over the timeline lanes. Scrolling is a compositor job;
  //    it must reach React zero times.
  const scroller = window.locator("[data-timeline-scroll]");
  await expect(scroller).toBeVisible();
  const box = (await scroller.boundingBox())!;
  const WHEELS = 40;
  const wheel = await measure(window, "wheel-scroll", WHEELS, async () => {
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < WHEELS; i += 1) {
      await window.mouse.wheel(0, i % 2 === 0 ? 60 : -60);
    }
  });
  expect
    .soft(wheel.totalRenders, "scrolling must not reach React at all")
    .toBeLessThan(4);

  // 4. POINTER-DRAG a pill along the timeline. The dragged pill has to follow
  //    the pointer; NOTHING else may re-render per move — not the timeline
  //    shell, not the control bar, not the preview, not the other 39 pills.
  const pill = window.locator("[data-moment-pill]").nth(3);
  await expect(pill).toBeVisible();
  const pb = (await pill.boundingBox())!;
  const MOVES = 40;
  const drag = await measure(window, "pill-drag", MOVES, async () => {
    await window.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await window.mouse.down();
    for (let i = 1; i <= MOVES; i += 1) {
      await window.mouse.move(pb.x + pb.width / 2 + i * 2, pb.y + pb.height / 2);
    }
    await window.mouse.up();
  });
  expect
    .soft(renders(drag, "timeline"), "a pill drag must not re-render the timeline shell per move")
    .toBeLessThan(MOVES / 2);
  expect
    .soft(renders(drag, "control-bar"), "a pill drag must not re-render the control bar")
    .toBeLessThan(MOVES / 2);
  expect
    .soft(renders(drag, "preview"), "a pill drag must not re-render the preview")
    .toBeLessThan(4);
  // One pill follows the pointer. Anything near MOVES × pill-count means the
  // memo boundary is broken.
  expect
    .soft(renders(drag, "pill"), "only the dragged pill may re-render per move")
    .toBeLessThan(MOVES * 3);

  // 5. SPLIT-GRIP drag — resizing the preview/timeline panes. The panes must
  //    resize on the compositor; a ResizeObserver that pushes state turns this
  //    into a full editor re-render per frame.
  const grip = window.getByRole("separator", { name: "Resize preview and timeline" });
  await expect(grip).toBeVisible();
  const gb = (await grip.boundingBox())!;
  const GRIP_MOVES = 30;
  const split = await measure(window, "split-drag", GRIP_MOVES, async () => {
    await window.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await window.mouse.down();
    for (let i = 1; i <= GRIP_MOVES; i += 1) {
      await window.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2 + (i % 10) * 4 - 20);
    }
    await window.mouse.up();
  });
  expect
    .soft(renders(split, "timeline"), "resizing panes must not re-render the timeline per frame")
    .toBeLessThan(GRIP_MOVES / 3);
  expect
    .soft(renders(split, "preview"), "resizing panes must not re-render the preview per frame")
    .toBeLessThan(GRIP_MOVES / 3);

  // 6. WINDOW RESIZE — the same question at the OS level.
  const SIZES = [1280, 1180, 1080, 1240, 1360, 1420, 1300, 1280];
  const resize = await measure(window, "window-resize", SIZES.length, async () => {
    for (const w of SIZES) {
      await app.evaluate(
        async ({ BrowserWindow }, width) => {
          const win = BrowserWindow.getAllWindows()[0]!;
          if (win.isMaximized()) win.unmaximize();
          win.setSize(width, 860);
        },
        w
      );
      await window.waitForTimeout(90);
    }
  });
  expect
    .soft(renders(resize, "timeline"), "a resize must re-render the timeline at most once per size")
    .toBeLessThanOrEqual(SIZES.length * 2);
  expect
    .soft(renders(resize, "preview"), "a resize must re-render the preview at most once per size")
    .toBeLessThanOrEqual(SIZES.length * 2);

  // 7. SLIDER drag inside the inspector — the control must be local-first, so
  //    the moving handle costs one small control render, never an editor one.
  //    Selecting a pill raises its action toolbar; "Edit moment" opens the
  //    dialog (a click alone only selects + seeks).
  await window.locator("[data-moment-pill]").nth(1).click();
  await window.getByRole("button", { name: "Edit moment" }).first().click();
  const dialog = window.getByRole("dialog", { name: "Edit moment" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const slider = dialog.getByRole("slider").first();
  await expect(slider).toBeVisible();
  const sb = (await slider.boundingBox())!;
  const SLIDER_MOVES = 30;
  const sliderDrag = await measure(window, "slider-drag", SLIDER_MOVES, async () => {
    await window.mouse.move(sb.x + 4, sb.y + sb.height / 2);
    await window.mouse.down();
    for (let i = 1; i <= SLIDER_MOVES; i += 1) {
      await window.mouse.move(sb.x + 4 + i * (sb.width / (SLIDER_MOVES + 4)), sb.y + sb.height / 2);
    }
    await window.mouse.up();
  });
  expect
    .soft(renders(sliderDrag, "timeline"), "a slider drag must not re-render the timeline")
    .toBeLessThan(SLIDER_MOVES / 3);
  expect
    .soft(renders(sliderDrag, "preview"), "a slider drag must not re-render the preview")
    .toBeLessThan(SLIDER_MOVES / 3);
  expect
    .soft(renders(sliderDrag, "pill"), "a slider drag must not re-render every pill")
    .toBeLessThan(EDIT_COUNT * 2);

  // 8. SEEK — clicking along the lane moves the playhead across edit after
  //    edit. Each landing legitimately changes "the edit under the playhead";
  //    what must NOT follow is a re-render of the entire editor for it.
  await window.keyboard.press("Escape");
  // Arrow keys — the timeline's own ±5s seek. A keypress reaches `seekBy`
  // exactly as a lane click reaches `seek`, without the ambiguity of which
  // element a synthetic click landed on.
  await window.locator("[data-timeline-scroll]").click({ position: { x: 8, y: 4 } });
  const SEEKS = 20;
  const seek = await measure(window, "seek-across-edits", SEEKS, async () => {
    for (let i = 1; i <= SEEKS; i += 1) {
      await window.keyboard.press(i % 6 === 0 ? "ArrowLeft" : "ArrowRight");
      await window.waitForTimeout(50);
    }
  });
  expect
    .soft(renders(seek, "timeline"), "a seek must not re-render the whole timeline")
    .toBeLessThan(SEEKS);
  expect
    .soft(renders(seek, "control-bar"), "a seek must not re-render the control bar")
    .toBeLessThan(SEEKS);
  expect
    .soft(renders(seek, "pill"), "a seek must not re-render every pill")
    .toBeLessThan(EDIT_COUNT * 2);
});
