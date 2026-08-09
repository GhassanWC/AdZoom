/**
 * IPC security.
 *
 * The renderer is sandboxed, so these validators ARE the trust boundary: if one
 * of them lets something through, a compromised renderer reaches the filesystem
 * or the database. Each case below is a specific thing an attacker (or a bug)
 * would try.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IpcValidationError,
  hasAcceptedVideoExtension,
  ipcErrorMessage,
  localMediaId,
  validateByteCount,
  validateDownloadUrl,
  validateExportRequest,
  validateExternalUrl,
  validateHandle,
  validatePatch,
  validateTitle,
} from "../../src/lib/platform/desktop/ipc.ts";

const validRecipe = {
  sourceWidth: 1920,
  sourceHeight: 1080,
  fps: 30,
  resolution: "1080p",
  format: "YouTube 16:9",
  sourceDuration: 12,
  moments: [],
  effects: { autoZoom: 70 },
  applyWatermark: false,
};

const validExport = {
  jobId: "job1234567",
  projectId: "proj123456",
  projectTitle: "My video",
  mediaId: "media12345",
  outputId: "out1234567",
  recipe: validRecipe,
};

test("handles must be opaque ids — no paths, no traversal, no injection", () => {
  assert.equal(validateHandle("abc123_-ZZ", "id"), "abc123_-ZZ");
  for (const bad of [
    "../../etc/passwd",
    "C:\\Windows\\System32",
    "short",
    "id with spaces",
    "id/with/slash",
    "id\u0000null",
    "'; DROP TABLE projects;--",
    "a".repeat(65),
    42,
    null,
    undefined,
    { toString: () => "abc123456" },
  ]) {
    assert.throws(() => validateHandle(bad, "id"), IpcValidationError, `accepted: ${String(bad)}`);
  }
});

test("patches cannot carry prototype-pollution keys", () => {
  assert.throws(() => validatePatch(JSON.parse('{"__proto__":{"admin":true}}')), IpcValidationError);
  assert.throws(() => validatePatch({ analysis: { constructor: { x: 1 } } }), IpcValidationError);
  assert.throws(() => validatePatch({ a: { b: { prototype: {} } } }), IpcValidationError);
  // A legitimate editor patch passes untouched.
  const ok = { analysis: { detectedMoments: [{ id: "m1", effectType: "zoom" }] }, updatedAt: 1 };
  assert.deepEqual(validatePatch(ok), ok);
});

test("patches must be plain JSON of bounded depth and size", () => {
  assert.throws(() => validatePatch("not an object"), IpcValidationError);
  assert.throws(() => validatePatch([1, 2, 3]), IpcValidationError);
  assert.throws(() => validatePatch({ fn: () => 1 }), IpcValidationError);

  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  assert.throws(() => validatePatch(deep), IpcValidationError);

  const huge = { blob: "x".repeat(9 * 1024 * 1024) };
  assert.throws(() => validatePatch(huge), IpcValidationError);
});

test("titles are bounded and stripped of control characters", () => {
  assert.equal(validateTitle("  Launch demo  "), "Launch demo");
  assert.equal(validateTitle("a\u0000b\u001fc"), "abc");
  assert.throws(() => validateTitle(""), IpcValidationError);
  assert.throws(() => validateTitle("   "), IpcValidationError);
  assert.throws(() => validateTitle("x".repeat(201)), IpcValidationError);
  assert.throws(() => validateTitle(123), IpcValidationError);
});

test("export requests are fully validated before a render is spawned", () => {
  const parsed = validateExportRequest(validExport);
  assert.equal(parsed.jobId, validExport.jobId);
  assert.equal(parsed.recipe.sourceWidth, 1920);

  assert.throws(() => validateExportRequest({ ...validExport, jobId: "../x" }), IpcValidationError);
  assert.throws(
    () => validateExportRequest({ ...validExport, recipe: { ...validRecipe, fps: 120 } }),
    IpcValidationError
  );
  assert.throws(
    () => validateExportRequest({ ...validExport, recipe: { ...validRecipe, resolution: "8K" } }),
    IpcValidationError
  );
  assert.throws(
    () => validateExportRequest({ ...validExport, recipe: { ...validRecipe, sourceWidth: 0 } }),
    IpcValidationError
  );
  assert.throws(
    () => validateExportRequest({ ...validExport, recipe: { ...validRecipe, sourceWidth: 99999 } }),
    IpcValidationError
  );
  assert.throws(
    () => validateExportRequest({ ...validExport, recipe: { ...validRecipe, moments: "all" } }),
    IpcValidationError
  );
  // An encoder the app doesn't ship is refused rather than passed to ffmpeg.
  assert.throws(
    () => validateExportRequest({ ...validExport, encoder: "h264_evil; rm -rf /" }),
    IpcValidationError
  );
  assert.equal(validateExportRequest({ ...validExport, encoder: "h264_nvenc" }).encoder, "h264_nvenc");
});

test("only http(s) links can be handed to the OS browser", () => {
  assert.equal(validateExternalUrl("https://framevo.app/pricing"), "https://framevo.app/pricing");
  for (const bad of [
    "file:///C:/Windows/System32/cmd.exe",
    "framevo://app/__media/x",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "not a url",
    123,
  ]) {
    assert.throws(() => validateExternalUrl(bad), IpcValidationError, `accepted: ${String(bad)}`);
  }
});

test("only accepted video containers can be imported", () => {
  for (const good of ["a.mp4", "A.MOV", "clip.webm", "rec.mkv", "movie.m4v"]) {
    assert.equal(hasAcceptedVideoExtension(good), true, good);
  }
  for (const bad of ["a.exe", "a.mp4.exe", "a.txt", "a", "a.mp3", "a.bat"]) {
    assert.equal(hasAcceptedVideoExtension(bad), false, bad);
  }
});

test("media ids are recovered only from real local media URLs", () => {
  assert.equal(localMediaId("framevo://app/__media/abc123_-ZZ"), "abc123_-ZZ");
  assert.equal(localMediaId("framevo://app/__media/abc123_-ZZ?t=1"), "abc123_-ZZ");
  assert.equal(localMediaId("https://firebasestorage.googleapis.com/v0/b/x/o/y.mp4"), null);
  assert.equal(localMediaId("framevo://app/__media/../../secret"), null);
  assert.equal(localMediaId(undefined), null);
});

/* ── Media transfer ─────────────────────────────────────────────────────────
 *
 * The download URL reported after an upload is written into the project
 * document and syncs from there to every other device and to the website. It is
 * the one value a compromised renderer could use to repoint a user's project at
 * a video it controls, so it is checked rather than trusted.
 */

test("a download URL must be https and must belong to Firebase Storage", () => {
  const good =
    "https://firebasestorage.googleapis.com/v0/b/app/o/users%2Fu%2Fclip.mp4?alt=media&token=t";
  assert.equal(validateDownloadUrl(good), good);
  assert.ok(validateDownloadUrl("https://storage.googleapis.com/bucket/o/clip.mp4"));

  for (const hostile of [
    "http://firebasestorage.googleapis.com/o/clip.mp4", // downgraded
    "https://evil.example/clip.mp4", // attacker's host
    "https://firebasestorage.googleapis.com.evil.example/clip.mp4", // suffix trick
    "file:///C:/Windows/System32/drivers/etc/hosts",
    "javascript:alert(1)",
    "framevo://app/__media/abc123",
    "",
    null,
    { toString: () => "https://firebasestorage.googleapis.com/x" },
  ]) {
    assert.throws(
      () => validateDownloadUrl(hostile),
      IpcValidationError,
      `must reject ${String(hostile)}`
    );
  }
});

test("a failed IPC call shows its own message, not Electron's plumbing", () => {
  const raw = new Error(
    "Error invoking remote method 'framevo:auth:google-start': " +
      "Error: Framevo's sign-in service isn't running at http://localhost:3000."
  );
  assert.equal(
    ipcErrorMessage(raw),
    "Framevo's sign-in service isn't running at http://localhost:3000."
  );
  // A message that merely mentions an error is left alone.
  assert.equal(ipcErrorMessage(new Error("Export failed: no encoder")), "Export failed: no encoder");
  // Nothing usable still has to read as a sentence.
  assert.match(ipcErrorMessage(undefined), /^Framevo/);
});

test("a reported byte count cannot be negative, absurd, or not a number", () => {
  assert.equal(validateByteCount(0, "bytesSent"), 0);
  assert.equal(validateByteCount(1024.9, "bytesSent"), 1024, "truncated, not rounded up");
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 5 * 1024 ** 3, "100", null]) {
    assert.throws(() => validateByteCount(bad, "bytesSent"), IpcValidationError);
  }
});
