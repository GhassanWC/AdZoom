/**
 * The editing assistant, driven against the REAL desktop app (Electron +
 * SQLite, offline, a real H.264 fixture) through the normal user workflow:
 *
 *   1. select a clip → "Trim the first two seconds"
 *        → the timeline's Clips row and the preview update, the edit persists
 *   2. ⌘Z restores the clip (the SAME undo stack manual edits use), ⌘Y redoes
 *   3. quit + relaunch: the trim AND the chat's "what changed" history survive
 *   4. a lower third by chat, a MANUAL edit, then a targeted revision
 *        ("move it to the top left and delay it half a second") that changes
 *        only the graphic — the manual edit is untouched
 *   5. export through the app's own Export dialog → the MP4 shows the revised
 *        graphic (pixel-checked), and is 2s shorter than the source
 *
 * No test hooks: clips are selected by clicking, requests are typed into the
 * chat, undo is the keyboard shortcut. The only stubs are the OS file dialogs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  cleanupDir,
  ffmpegPath,
  firebaseApiKey,
  launchApp,
  openRoute,
  seedSignedInSession,
  stubDialogs,
  type LaunchedApp,
} from "./fixtures";

let workDir: string;
let profileDir: string;
let fixture: string;
let launched: LaunchedApp | undefined;
let projectId = "";

test.skip(!firebaseApiKey(), "the renderer was built without NEXT_PUBLIC_FIREBASE_* — sign-in is impossible");
test.describe.configure({ mode: "serial" });

type StoredMoment = {
  id: string;
  effectType: string;
  startTime: number;
  endTime: number;
  cut?: { active?: boolean };
  enabled?: boolean;
  textOverlay?: { text?: string };
  textStyle?: { customX?: number; customY?: number; align?: string };
};

/**
 * A plain light-grey recording with a real AAC track. Solid on purpose: any
 * dark pixel in the export is then the lower third's plate, so the pixel
 * checks can't be fooled by the test pattern.
 */
function makeSolidFixture(dir: string, seconds = 12): string {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "assist-fixture.mp4");
  execFileSync(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0xE0E0E0:size=1280x720:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest", out,
  ], { timeout: 300_000 });
  return out;
}

/** Mean luma (0–255) of a box given as FRACTIONS of the frame, at output time t. */
function lumaAt(mp4: string, t: number, box: { x: number; y: number; w: number; h: number }): number {
  const buf = execFileSync(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", mp4, "-frames:v", "1",
    "-vf", `crop=iw*${box.w}:ih*${box.h}:iw*${box.x}:ih*${box.y},scale=1:1:flags=area`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ]);
  return buf[0];
}

function durationOf(mp4: string): number {
  // ffmpeg prints "Duration: 00:00:10.00" for `-i` with no output.
  let text = "";
  try {
    execFileSync(ffmpegPath(), ["-hide_banner", "-i", mp4], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    text = String((err as { stderr?: string }).stderr ?? "");
  }
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

async function storedDoc(window: Page): Promise<{ moments: StoredMoment[]; log: Array<{ requestId: string; lines: string[] }> }> {
  return window.evaluate(async () => {
    const list = await window.framevo!.projects.list();
    const doc = (await window.framevo!.projects.get(list[0]!.id)) as Record<string, unknown> | null;
    const analysis = doc?.analysis as { detectedMoments?: StoredMoment[] } | undefined;
    return {
      moments: analysis?.detectedMoments ?? [],
      log: (doc?.assistantLog as Array<{ requestId: string; lines: string[] }>) ?? [],
    };
  });
}

const activeCuts = (ms: StoredMoment[]) =>
  ms.filter((m) => m.effectType === "cut" && m.cut?.active !== false && m.enabled !== false);

function clipPill(window: Page) {
  return window.getByTestId("footage-clip").first();
}

async function openAssistant(window: Page): Promise<void> {
  if (!(await window.locator("#director-chat-input").isVisible().catch(() => false))) {
    await window.getByRole("button", { name: "Ask Framevo" }).first().click();
  }
  // A project with no edits opens on setup — choose to direct the edit in chat.
  const direct = window.getByTestId("direct-edit-chat");
  if (await direct.isVisible().catch(() => false)) await direct.click();
  await expect(window.locator("#director-chat-input")).toBeVisible({ timeout: 15_000 });
}

async function sendChat(window: Page, text: string): Promise<void> {
  const input = window.locator("#director-chat-input");
  await input.fill(text);
  await input.press("Enter");
}

async function openProject(app: LaunchedApp): Promise<void> {
  await openRoute(app.window, `/dashboard/projects/${projectId}`);
  await expect(app.window.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 60_000 });
  await expect(clipPill(app.window)).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "framevo-e2e-assist-"));
  profileDir = mkdtempSync(join(tmpdir(), "framevo-e2e-assist-profile-"));
  fixture = makeSolidFixture(workDir);
  expect(existsSync(fixture)).toBe(true);
});

test.afterAll(async () => {
  await launched?.close();
  cleanupDir(workDir);
  cleanupDir(profileDir);
});

test("select a clip, 'Trim the first two seconds' → timeline + preview + storage update", async () => {
  launched = await launchApp({ userDataDir: profileDir });
  const { app, window } = launched;
  await seedSignedInSession(window);
  await openRoute(window, "/dashboard/projects");
  await stubDialogs(app, { open: fixture });
  await window.getByRole("link", { name: "Upload", exact: true }).first().click();
  await window.getByRole("button", { name: /Choose a video/i }).click();
  await expect.poll(() => window.evaluate(() => window.location.pathname), { timeout: 60_000 }).toMatch(/^\/dashboard\/projects\/.+/);
  projectId = (await window.evaluate(() => window.location.pathname)).split("/").pop()!;
  await expect(window.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 60_000 });

  // One clip: the whole 12s recording.
  await expect(clipPill(window)).toHaveAttribute("aria-label", /Clip 1, 12\.0 seconds/, { timeout: 30_000 });

  // Select it on the Clips row — the subject of "the first two seconds".
  await clipPill(window).click();
  await expect(clipPill(window)).toHaveAttribute("aria-selected", "true");

  await openAssistant(window);
  await sendChat(window, "Trim the first two seconds");

  // The chat says exactly what changed…
  const bubble = window.getByTestId("assistant-edit").last();
  await expect(bubble).toContainText("Trimmed 2.0s from the start of clip 1", { timeout: 15_000 });

  // …the timeline's clip is now 10s and STILL selected (selection follows the
  // trim even though the trim gave the clip a new boundary)…
  await expect(clipPill(window)).toHaveAttribute("aria-label", /Clip 1, 10\.0 seconds, from 0:02/);
  await expect(clipPill(window)).toHaveAttribute("aria-selected", "true");

  // …the preview jumped to the new first frame (source 2s)…
  await expect
    .poll(() => window.locator("video").first().evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1.95);

  // …and it is persisted: ONE cut over 0–2s, plus the request in the log.
  await expect.poll(async () => activeCuts((await storedDoc(window)).moments).map((c) => [c.startTime, c.endTime]), { timeout: 10_000 }).toEqual([[0, 2]]);
  expect((await storedDoc(window)).log).toHaveLength(1);
});

test("⌘Z restores the clip; ⌘Y re-applies it", async () => {
  const { window } = launched!;
  // Undo is the editor's own shortcut — focus must not be in the chat box.
  await window.locator("body").click({ position: { x: 5, y: 5 } });
  await window.keyboard.press("Control+z");
  await expect(clipPill(window)).toHaveAttribute("aria-label", /Clip 1, 12\.0 seconds/, { timeout: 10_000 });
  await expect.poll(async () => activeCuts((await storedDoc(window)).moments).length, { timeout: 10_000 }).toBe(0);

  await window.keyboard.press("Control+y");
  await expect(clipPill(window)).toHaveAttribute("aria-label", /Clip 1, 10\.0 seconds/, { timeout: 10_000 });
  await expect.poll(async () => activeCuts((await storedDoc(window)).moments).map((c) => [c.startTime, c.endTime]), { timeout: 10_000 }).toEqual([[0, 2]]);
});

test("the trim and its chat history survive quitting and reopening", async () => {
  await launched!.close();
  launched = await launchApp({ userDataDir: profileDir });
  await seedSignedInSession(launched.window);
  await openProject(launched);
  const { window } = launched;

  await expect(clipPill(window)).toHaveAttribute("aria-label", /Clip 1, 10\.0 seconds, from 0:02/);
  expect(activeCuts((await storedDoc(window)).moments).map((c) => [c.startTime, c.endTime])).toEqual([[0, 2]]);

  // The reopened chat still shows what that request changed.
  await window.getByRole("button", { name: "Ask Framevo" }).first().click();
  await expect(window.getByTestId("assistant-edit").first()).toContainText("Trimmed 2.0s from the start of clip 1", { timeout: 15_000 });
});

let lowerThirdId = "";
let manualZoom: StoredMoment | undefined;

test("lower third by chat, a manual edit, then a targeted revision that touches only the graphic", async () => {
  const { window } = launched!;
  await openAssistant(window);
  await sendChat(window, `Add a lower third saying "Sarah Chen · Head of Design" at 0:03`);
  await expect(window.getByTestId("assistant-edit").last()).toContainText(`Added Lower Third "Sarah Chen · Head of Design" at 0:03.0`, { timeout: 15_000 });
  await expect.poll(async () => (await storedDoc(window)).moments.find((m) => m.textOverlay?.text === "Sarah Chen · Head of Design")?.id ?? "", { timeout: 10_000 }).not.toBe("");
  const lt = (await storedDoc(window)).moments.find((m) => m.textOverlay?.text === "Sarah Chen · Head of Design")!;
  lowerThirdId = lt.id;
  expect(lt.startTime).toBe(3);
  expect(lt.textStyle?.customY ?? 0).toBeGreaterThan(0.7); // bottom-left by design

  // A MANUAL edit after the AI draft, through the editor's own Add menu.
  const before = new Set((await storedDoc(window)).moments.map((m) => m.id));
  await window.getByTitle("Insert a new edit at the playhead").click();
  const menu = window.getByRole("menu", { name: "Add an edit" });
  await menu.waitFor();
  await menu.getByText("Zoom", { exact: true }).click();
  await expect.poll(async () => (await storedDoc(window)).moments.find((m) => !before.has(m.id) && m.effectType === "zoom")?.id ?? "", { timeout: 15_000 }).not.toBe("");
  manualZoom = (await storedDoc(window)).moments.find((m) => !before.has(m.id) && m.effectType === "zoom");
  const dialog = window.getByRole("dialog", { name: "Edit moment" });
  if (await dialog.isVisible().catch(() => false)) {
    await window.getByRole("button", { name: "Close moment settings" }).click();
  }

  // The revision: "it" is the graphic the last request made, NOT the zoom the
  // user just added and selected.
  await openAssistant(window);
  await sendChat(window, "Move it to the top left and delay it half a second");
  await expect(window.getByTestId("assistant-edit").last()).toContainText("moved to top left", { timeout: 15_000 });
  await expect(window.getByTestId("assistant-edit").last()).toContainText("Delayed");

  await expect.poll(async () => (await storedDoc(window)).moments.find((m) => m.id === lowerThirdId)?.startTime, { timeout: 10_000 }).toBe(3.5);
  const after = (await storedDoc(window)).moments;
  const lt2 = after.find((m) => m.id === lowerThirdId)!;
  expect(lt2.endTime - lt2.startTime).toBeCloseTo(lt.endTime - lt.startTime, 6);
  expect(lt2.textStyle?.align).toBe("left");
  expect(lt2.textStyle?.customY ?? 1).toBeLessThan(0.2);
  expect(lt2.textOverlay?.text).toBe("Sarah Chen · Head of Design");
  // Unrelated edits are untouched: the manual zoom AND the earlier trim.
  expect(after.find((m) => m.id === manualZoom!.id)).toEqual(manualZoom);
  expect(activeCuts(after).map((c) => [c.startTime, c.endTime])).toEqual([[0, 2]]);
});

test("export through the app's Export dialog shows the REVISED graphic in the MP4", async () => {
  const { app, window } = launched!;
  const output = join(workDir, "assistant-export.mp4");
  await stubDialogs(app, { open: fixture, save: output });
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Export" }).click();
  const sheet = window.getByRole("dialog");
  await sheet.getByRole("button", { name: /^Export$/ }).click();
  await expect(sheet.getByText(/Show in folder/i)).toBeVisible({ timeout: 150_000 });
  expect(existsSync(output)).toBe(true);
  expect(statSync(output).size).toBeGreaterThan(10_000);

  // 12s source − the 2s trim.
  expect(durationOf(output)).toBeCloseTo(10, 0);

  const lt = (await storedDoc(window)).moments.find((m) => m.id === lowerThirdId)!;
  const y = lt.textStyle!.customY!;
  const x = lt.textStyle!.customX!;
  // The plate band, from the SAVED position — the same data the preview drew.
  const topLeftPlate = { x: x + 0.01, y: Math.max(0, y - 0.01), w: 0.25, h: 0.02 };
  const bottomLeft = { x: x + 0.01, y: 0.88, w: 0.25, h: 0.02 };
  // Source 3.5s plays at output 1.5s (2s trimmed). Check well after the entrance.
  const visibleAt = lt.startTime - 2 + 1.2;
  const beforeAt = lt.startTime - 2 - 0.3; // source 3.2s: the OLD start was 3.0 — must be clear now
  expect(lumaAt(output, visibleAt, topLeftPlate)).toBeLessThan(180);
  expect(lumaAt(output, visibleAt, bottomLeft)).toBeGreaterThan(205);
  expect(lumaAt(output, beforeAt, topLeftPlate)).toBeGreaterThan(205);
});
