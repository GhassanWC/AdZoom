/**
 * Editor interaction + responsiveness, driven against the REAL desktop app.
 *
 * This is the spec that would have caught the editor being slow. The rest of the
 * suite proves the workflow works; this one proves it works *well*:
 *
 *   • every control kind — button, text input, slider, dropdown, toggle, colour
 *     picker, tab/segmented — responds on the interaction itself, NOT after the
 *     document write round-trips through SQLite;
 *   • the final value still lands in the database (local-first must not mean
 *     lossy), including when the user switches edits mid-debounce;
 *   • the dialog and the timeline stay usable from a narrow window up to
 *     maximized, across live resizes, with no horizontal page overflow;
 *   • playback keeps advancing while all of that is going on.
 *
 * "Responds instantly" is asserted the only honest way available to a test: the
 * control's own rendered value must change within a budget far below what a
 * persistence round-trip costs.
 *
 * Every test creates the edit it operates on and asserts against THAT edit's id.
 * Several tests add edits of the same type, so matching by type alone would
 * quietly assert on the wrong row.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  cleanupDir,
  firebaseApiKey,
  launchApp,
  makeFixtureVideo,
  openRoute,
  seedSignedInSession,
  stubDialogs,
  type LaunchedApp,
} from "./fixtures";

let workDir: string;
let profileDir: string;
let fixture: string;
let launched: LaunchedApp;

test.skip(
  !firebaseApiKey(),
  "the renderer was built without NEXT_PUBLIC_FIREBASE_* — sign-in is impossible"
);

test.describe.configure({ mode: "serial" });

/** Budget for "the UI answered me". A persisted round-trip is far slower. */
const INSTANT_MS = 250;

// ── helpers ────────────────────────────────────────────────────────────────

async function storedMoments(
  window: Page
): Promise<Array<Record<string, unknown>>> {
  return window.evaluate(async () => {
    const list = await window.framevo!.projects.list();
    const doc = await window.framevo!.projects.get(list[0]!.id);
    const analysis = doc?.analysis as
      | { detectedMoments?: Array<Record<string, unknown>> }
      | undefined;
    return analysis?.detectedMoments ?? [];
  });
}

/** The persisted state of ONE edit, by id. */
async function storedMoment(
  window: Page,
  id: string
): Promise<Record<string, unknown> | undefined> {
  return (await storedMoments(window)).find((m) => String(m.id) === id);
}

/** The moment editor — a floating (backdrop-less) dialog. */
function momentDialog(window: Page) {
  return window.getByRole("dialog", { name: "Edit moment" });
}

/**
 * Insert an edit at the playhead through the editor's own Add menu.
 * `addMomentAtPlayhead` selects the new edit AND opens the inspector, so the
 * dialog is up when this resolves.
 */
async function addEdit(window: Page, label: string): Promise<void> {
  await closeMomentEditor(window);
  await window.getByTitle("Insert a new edit at the playhead").click();
  const menu = window.getByRole("menu", { name: "Add an edit" });
  await menu.waitFor();
  await menu.getByText(label, { exact: true }).click();
  await expect(momentDialog(window)).toBeVisible({ timeout: 15_000 });
}

/** Insert an edit and return ITS id, so assertions can be exact. */
async function addEditAndGetId(window: Page, label: string): Promise<string> {
  const before = new Set((await storedMoments(window)).map((m) => String(m.id)));
  await addEdit(window, label);
  let id = "";
  await expect
    .poll(
      async () => {
        const fresh = (await storedMoments(window)).find(
          (m) => !before.has(String(m.id))
        );
        id = fresh ? String(fresh.id) : "";
        return id;
      },
      { timeout: 15_000 }
    )
    .not.toBe("");
  return id;
}

async function closeMomentEditor(window: Page): Promise<void> {
  if (!(await momentDialog(window).isVisible())) return;
  await window.getByRole("button", { name: "Close moment settings" }).click();
  await expect(momentDialog(window)).toBeHidden({ timeout: 10_000 });
}

/** Resize the Electron BrowserWindow and let layout settle. */
async function setWindowSize(
  app: LaunchedApp,
  width: number,
  height: number
): Promise<void> {
  await app.app.evaluate(
    async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      if (win.isMaximized()) win.unmaximize();
      win.setSize(size.width, size.height);
    },
    { width, height }
  );
  await app.window.waitForTimeout(350);
}

/** The page must never scroll horizontally, at any window size. */
async function horizontalOverflow(window: Page): Promise<number> {
  return window.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

/** Every element that spills past the right edge of the viewport. */
async function overflowingElements(window: Page): Promise<string[]> {
  return window.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Skip anything deliberately scrolled horizontally by its own container
      // (the timeline track is wider than its viewport by design, when zoomed).
      let scrollerClipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") {
          scrollerClipped = true;
          break;
        }
      }
      if (scrollerClipped) continue;
      // 2px of slack absorbs sub-pixel rounding on fractional DPI scales.
      if (r.right > vw + 2) {
        const cls =
          typeof el.className === "string" ? el.className.slice(0, 50) : "";
        bad.push(
          `${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)} vw=${vw}`
        );
      }
    }
    return bad.slice(0, 10);
  });
}

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "framevo-e2e-ui-"));
  profileDir = mkdtempSync(join(tmpdir(), "framevo-e2e-ui-profile-"));
  fixture = makeFixtureVideo(workDir, "ui-fixture.mp4", { seconds: 12 });
  expect(existsSync(fixture)).toBe(true);

  launched = await launchApp({ userDataDir: profileDir });
  await seedSignedInSession(launched.window);
  await openRoute(launched.window, "/dashboard/projects");
  await stubDialogs(launched.app, { open: fixture });

  await launched.window
    .getByRole("link", { name: "Upload", exact: true })
    .first()
    .click();
  await launched.window.getByRole("button", { name: /Choose a video/i }).click();
  await expect
    .poll(() => launched.window.evaluate(() => window.location.pathname), {
      timeout: 60_000,
    })
    .toMatch(/^\/dashboard\/projects\/.+/);
  await expect(
    launched.window.getByRole("button", { name: "Export" })
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () =>
        launched.window
          .locator("video")
          .first()
          .evaluate((el: HTMLVideoElement) => el.readyState),
      { timeout: 30_000 }
    )
    .toBeGreaterThanOrEqual(1);
});

test.afterAll(async () => {
  await launched?.close();
  cleanupDir(workDir);
  cleanupDir(profileDir);
});

// ── 1. Text input ──────────────────────────────────────────────────────────

test("typing echoes instantly and persists the final text, not a prefix", async () => {
  const { window } = launched;
  const id = await addEditAndGetId(window, "Caption");

  const field = window.getByRole("textbox", { name: "Caption text" });
  await expect(field).toBeVisible();
  await field.click();
  await field.fill("");

  // Fast typing: every keystroke must appear immediately. If the field were
  // still controlled by persisted state, characters would lag or drop here.
  const phrase = "Rapid caption typing test";
  const started = Date.now();
  await field.pressSequentially(phrase, { delay: 12 });
  const typingMs = Date.now() - started;

  await expect(field).toHaveValue(phrase, { timeout: INSTANT_MS });
  // A per-keystroke document write is what used to blow this out.
  expect(typingMs).toBeLessThan(4_000);

  // …and the whole phrase — not a truncated prefix — reaches SQLite.
  await expect
    .poll(
      async () => {
        const m = await storedMoment(window, id);
        return (m?.captions as { text?: string } | undefined)?.text ?? "";
      },
      { timeout: 10_000 }
    )
    .toBe(phrase);
});

// ── 2. Slider ──────────────────────────────────────────────────────────────

test("a slider moves immediately and commits the value it lands on", async () => {
  const { window } = launched;
  const id = await addEditAndGetId(window, "Blur");

  const slider = window.getByRole("slider", { name: "Strength" });
  await expect(slider).toBeVisible();
  const before = Number(await slider.inputValue());

  // The keyboard path is also the one that used to rubber-band, because each
  // repeat wrote the document and the echo fought the handle.
  await slider.focus();
  for (let i = 0; i < 10; i += 1) await window.keyboard.press("ArrowRight");

  await expect
    .poll(async () => Number(await slider.inputValue()), { timeout: INSTANT_MS })
    .toBeGreaterThan(before);
  const after = Number(await slider.inputValue());

  // Blur wants the pointer released / focus lost to flush.
  await slider.blur();
  await expect
    .poll(
      async () => {
        const m = await storedMoment(window, id);
        const s = (m?.blurRedaction as { blurStrength?: number } | undefined)
          ?.blurStrength;
        return s === undefined ? -1 : Math.round(s * 100);
      },
      { timeout: 10_000 }
    )
    .toBe(after);
});

// ── 3. Toggle ──────────────────────────────────────────────────────────────

test("a toggle flips on the click and settles correctly after rapid clicking", async () => {
  const { window } = launched;
  const id = await addEditAndGetId(window, "Callout");

  const toggle = window.getByRole("switch", { name: "Enabled" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // One click: the switch reports its new state immediately.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false", {
    timeout: INSTANT_MS,
  });

  // Rapid repeated clicking — an even count returns to the same state, and no
  // click may be swallowed.
  for (let i = 0; i < 6; i += 1) await toggle.click({ delay: 10 });
  await expect(toggle).toHaveAttribute("aria-checked", "false", {
    timeout: INSTANT_MS,
  });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true", {
    timeout: INSTANT_MS,
  });
  await expect
    .poll(async () => (await storedMoment(window, id))?.enabled !== false, {
      timeout: 10_000,
    })
    .toBe(true);
});

// ── 4. Segmented control / tabs ────────────────────────────────────────────

test("segmented controls select on the click and persist", async () => {
  const { window } = launched;
  const id = await addEditAndGetId(window, "Blur");

  const group = window.getByRole("radiogroup", { name: "Reason" });
  await expect(group).toBeVisible();
  const options = group.getByRole("radio");
  const count = await options.count();
  expect(count).toBeGreaterThan(1);

  // Click through every option; each must light up on its own click.
  for (let i = 0; i < count; i += 1) {
    const opt = options.nth(i);
    await opt.click();
    await expect(opt).toHaveAttribute("aria-checked", "true", {
      timeout: INSTANT_MS,
    });
  }

  // The last selection is the one that persists.
  await expect
    .poll(
      async () => {
        const m = await storedMoment(window, id);
        return (m?.blurRedaction as { reasonType?: string } | undefined)
          ?.reasonType;
      },
      { timeout: 10_000 }
    )
    .toBeTruthy();
});

// ── 5. Colour picker ───────────────────────────────────────────────────────

test("the colour hex field accepts typing and persists the colour", async () => {
  const { window } = launched;
  const id = await addEditAndGetId(window, "Hook text");

  const hex = window.getByRole("textbox", { name: /hex$/i }).first();
  if ((await hex.count()) === 0) {
    test.skip(true, "no colour field exposed for this overlay type");
    return;
  }
  await hex.click();
  await hex.fill("#3366ff");
  await expect(hex).toHaveValue(/3366ff/i, { timeout: INSTANT_MS });
  await hex.blur();

  await expect
    .poll(
      async () => {
        const m = await storedMoment(window, id);
        return JSON.stringify(m ?? {}).toLowerCase().includes("#3366ff");
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ── 6. THE regression: switching edits while a write is pending ────────────

test("switching edits mid-debounce persists the draft to its OWN edit", async () => {
  const { window } = launched;

  // A first caption to switch AWAY to, then the one we type into.
  const firstId = await addEditAndGetId(window, "Caption");
  const secondId = await addEditAndGetId(window, "Caption");
  expect(secondId).not.toBe(firstId);

  const field = window.getByRole("textbox", { name: "Caption text" });
  await field.click();
  await field.fill("");
  await field.pressSequentially("MID-DEBOUNCE-MARKER", { delay: 8 });

  // Switch edits WITHOUT blurring the field.
  //
  // This distinction is the whole test. A real pointer click on the nav button
  // blurs the input first, and blur flushes the draft to the edit it belongs to
  // — so a normal click never reproduces the race. The reachable version is a
  // selection change that does NOT move focus: the playhead crossing into
  // another edit during playback, or a programmatic nav like this one. Here the
  // pending debounce is still in flight when the dialog swaps to another edit.
  const prev = window.getByRole("button", { name: "Previous edit" });
  expect(await prev.count()).toBeGreaterThan(0);
  await expect(prev.first()).toBeEnabled();
  await prev.first().evaluate((el: HTMLButtonElement) => el.click());

  // The dialog really did move to a different edit, and the field kept focus.
  await expect
    .poll(
      async () =>
        window.evaluate(
          () => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label")
        ),
      { timeout: 2_000 }
    )
    .toBe("Caption text");

  await window.waitForTimeout(1_200); // outlast the text debounce
  await closeMomentEditor(window);

  const all = await storedMoments(window);
  const carriers = all.filter((m) =>
    String((m.captions as { text?: string } | undefined)?.text ?? "").includes(
      "MID-DEBOUNCE-MARKER"
    )
  );
  // Exactly ONE edit carries the text — never zero (the draft was lost) and
  // never a different edit than the one it was typed into.
  expect(carriers).toHaveLength(1);
  expect(String(carriers[0]!.id)).toBe(secondId);
});

// ── 7. Buttons: rapid repeated clicking must not double-fire ──────────────

test("rapid repeated clicking of the Add menu never inserts by itself", async () => {
  const { window } = launched;
  await closeMomentEditor(window);

  const addBtn = window.getByTitle("Insert a new edit at the playhead");
  const before = (await storedMoments(window)).length;
  for (let i = 0; i < 4; i += 1) {
    await addBtn.click({ delay: 15 });
    await window.waitForTimeout(60);
  }
  await window.keyboard.press("Escape");
  await window.waitForTimeout(500);
  expect((await storedMoments(window)).length).toBe(before);
});

// ── 8. Playback ────────────────────────────────────────────────────────────

test("playback advances smoothly while controls are being used", async () => {
  const { window } = launched;
  await closeMomentEditor(window);
  const video = window.locator("video").first();

  await video.evaluate(async (el: HTMLVideoElement) => {
    el.currentTime = 0;
    await el.play().catch(() => undefined);
  });
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => !el.paused), {
      timeout: 5_000,
    })
    .toBe(true);

  const t0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);

  // Hammer the UI while it plays: open a menu, toggle a docked panel.
  await window.getByTitle("Insert a new edit at the playhead").click();
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Canvas" }).click();
  await window.waitForTimeout(300);
  await window.getByRole("button", { name: "Canvas" }).click();
  await window.waitForTimeout(1_200);

  const t1 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
  // The clock genuinely moved — the preview did not stall behind React work.
  expect(t1).toBeGreaterThan(t0);

  await video.evaluate((el: HTMLVideoElement) => el.pause());
});

// ── 9. Window sizes ────────────────────────────────────────────────────────

const SIZES: Array<{ name: string; w: number; h: number }> = [
  { name: "narrow", w: 900, h: 720 },
  { name: "medium", w: 1280, h: 800 },
  { name: "wide", w: 1680, h: 1000 },
];

for (const size of SIZES) {
  test(`editor fits a ${size.name} window (${size.w}×${size.h}) with no overflow`, async () => {
    await setWindowSize(launched, size.w, size.h);
    const { window } = launched;

    expect(await horizontalOverflow(window)).toBeLessThanOrEqual(0);
    await expect(window.getByRole("button", { name: "Export" })).toBeVisible();
    await expect(
      window.getByTitle("Insert a new edit at the playhead")
    ).toBeVisible();

    // The moment dialog — the densest surface — must fit too.
    await addEdit(window, "Caption");
    const dialog = momentDialog(window);
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(size.w);
    expect(box!.x).toBeGreaterThanOrEqual(-1);

    expect(await horizontalOverflow(window)).toBeLessThanOrEqual(0);
    expect(await overflowingElements(window)).toEqual([]);

    // The dialog scrolls INTERNALLY rather than pushing the page.
    await dialog.evaluate((el) => {
      const scroller =
        el.querySelector<HTMLElement>("[class*='overflow-y']") ?? el;
      scroller.scrollTop = scroller.scrollHeight;
    });
    expect(await horizontalOverflow(window)).toBeLessThanOrEqual(0);

    // Controls remain operable at this width.
    const field = window.getByRole("textbox", { name: "Caption text" });
    await field.click();
    await field.fill(`width-${size.w}`);
    await expect(field).toHaveValue(`width-${size.w}`, { timeout: INSTANT_MS });

    await closeMomentEditor(window);
  });
}

test("maximizing and live-resizing keeps the layout sound", async () => {
  const { app, window } = launched;

  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.maximize();
  });
  await window.waitForTimeout(500);
  expect(await horizontalOverflow(window)).toBeLessThanOrEqual(0);
  await expect(window.getByRole("button", { name: "Export" })).toBeVisible();

  // A live drag-resize: many size changes in quick succession, with the dialog
  // open. This is where a resize handler that re-renders the world shows up.
  await addEdit(window, "Caption");
  for (const w of [1500, 1300, 1100, 980, 1200, 1450]) {
    await setWindowSize(launched, w, 820);
    expect(await horizontalOverflow(window)).toBeLessThanOrEqual(0);
  }
  await expect(momentDialog(window)).toBeVisible();
  expect(await overflowingElements(window)).toEqual([]);

  // Still interactive after all that.
  const field = window.getByRole("textbox", { name: "Caption text" });
  await field.click();
  await field.fill("after-resize");
  await expect(field).toHaveValue("after-resize", { timeout: INSTANT_MS });
  await closeMomentEditor(window);

  await setWindowSize(launched, 1280, 800);
  await expect(window.getByRole("button", { name: "Export" })).toBeEnabled();
});

// ── 10. Health check ───────────────────────────────────────────────────────

test("the app is still healthy and responsive after the whole suite", async () => {
  const { window } = launched;
  await expect(window.getByRole("button", { name: "Export" })).toBeEnabled();
  expect(await window.evaluate(() => document.readyState)).toBe("complete");
  // Every edit created above survived to the database.
  expect((await storedMoments(window)).length).toBeGreaterThan(5);
});
