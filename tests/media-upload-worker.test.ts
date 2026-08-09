/**
 * The worker that puts a source video in the cloud.
 *
 * The upload itself is not exercised here: it is the Firebase Storage SDK
 * talking to a network, and a mock of it would test the mock. What IS covered
 * is the one decision the worker makes alone and gets to be wrong about —
 * the Content-Type the object is stored with.
 *
 * That matters more than it looks. `storage.rules` only accepts `video/*` or
 * `application/octet-stream`, so a wrong value is a rejected upload; and a
 * saved recording's own type is `video/mp4;codecs=avc1…,mp4a…`, whose comma
 * makes it an unparseable Content-Type header for the export API's typed
 * download — a failure that surfaces days later, in another service.
 *
 * The drain loop and the failure reporting are integration behaviour against a
 * real queue; they belong with the emulator matrix, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { contentTypeFor } from "@/lib/sync/media-upload-worker";

test("a recording's codec-bearing MIME type never reaches Storage", () => {
  // What MediaRecorder puts on a saved take. The comma makes it an unparseable
  // Content-Type header for the export API's typed download.
  assert.equal(
    contentTypeFor("Recording.webm", "video/mp4;codecs=avc1.42e01e,mp4a.40.2"),
    "video/mp4"
  );
});

test("a plain video type is kept; anything else is decided by the extension", () => {
  assert.equal(contentTypeFor("clip.mkv", "video/webm"), "video/webm");
  assert.equal(contentTypeFor("clip.mp4", ""), "video/mp4");
  assert.equal(contentTypeFor("clip.m4v", ""), "video/mp4");
  assert.equal(contentTypeFor("clip.mov", "application/octet-stream"), "video/quicktime");
  assert.equal(contentTypeFor("clip.webm", ""), "video/webm");
  assert.equal(contentTypeFor("clip.mkv", ""), "video/x-matroska");
});

test("an unknown extension falls back to a type the Storage rules still accept", () => {
  // storage.rules requires `video/*` OR `application/octet-stream`. Guessing
  // `video/mp4` for a file we cannot identify would be a lie that a decoder
  // downstream has to discover the hard way.
  assert.equal(contentTypeFor("clip.bin", ""), "application/octet-stream");
  assert.equal(contentTypeFor("noextension", ""), "application/octet-stream");
});
