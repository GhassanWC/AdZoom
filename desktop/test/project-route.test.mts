/**
 * The dynamic project route, on both sides of the process boundary.
 *
 * A static export has ONE artifact for `/dashboard/projects/[id]`, and the
 * protocol handler folds every real id onto it. Two functions have to agree
 * about that, in two different processes:
 *
 *   main     `rewriteAppPath`   URL → which file to serve
 *   renderer `projectIdFromPath` URL → which project to open
 *
 * If they ever disagree, deep links and reloads open the wrong thing (or
 * nothing), and that failure only shows up in a packaged build. Hence a test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_ROUTE_PLACEHOLDER,
  rewriteAppPath,
} from "../src/main/protocol-rules.ts";
import { projectIdFromPath, projectHref } from "@/components/desktop/project-route.ts";

const PLACEHOLDER_PATH = `/dashboard/projects/${PROJECT_ROUTE_PLACEHOLDER}`;

test("a real project id resolves to the placeholder artifact", () => {
  assert.equal(rewriteAppPath("/dashboard/projects/abc123"), PLACEHOLDER_PATH);
  assert.equal(rewriteAppPath("/dashboard/projects/Zm9vYmFy-_09"), PLACEHOLDER_PATH);
});

test("the RSC payload requests behind client navigation resolve too", () => {
  // Next fetches `<route>.txt` …
  assert.equal(rewriteAppPath("/dashboard/projects/abc123.txt"), `${PLACEHOLDER_PATH}.txt`);
  // … and, for segment prefetches, `<route>/__next.<segment>.txt`.
  assert.equal(
    rewriteAppPath("/dashboard/projects/abc123/__next._tree.txt"),
    `${PLACEHOLDER_PATH}/__next._tree.txt`
  );
  assert.equal(
    rewriteAppPath("/dashboard/projects/abc123/__next._full.txt"),
    `${PLACEHOLDER_PATH}/__next._full.txt`
  );
});

test("the placeholder itself is never rewritten again", () => {
  assert.equal(rewriteAppPath(PLACEHOLDER_PATH), PLACEHOLDER_PATH);
  assert.equal(rewriteAppPath(`${PLACEHOLDER_PATH}.txt`), `${PLACEHOLDER_PATH}.txt`);
  assert.equal(
    rewriteAppPath(`${PLACEHOLDER_PATH}/__next._tree.txt`),
    `${PLACEHOLDER_PATH}/__next._tree.txt`
  );
});

test("every other route is left exactly as it is", () => {
  for (const path of [
    "/",
    "/login",
    "/dashboard",
    "/dashboard/projects",
    "/dashboard/exports",
    "/dashboard/storage",
    "/_next/static/chunks/main.js",
    "/dashboard/projects", // the listing, not a project
  ]) {
    assert.equal(rewriteAppPath(path), path, path);
  }
  // A trailing slash names the listing, not a project.
  assert.equal(rewriteAppPath("/dashboard/projects/"), "/dashboard/projects/");
});

test("the renderer recovers the id the URL actually carries", () => {
  assert.equal(projectIdFromPath("/dashboard/projects/abc123"), "abc123");
  assert.equal(projectIdFromPath("/dashboard/projects/abc123/"), "abc123");
  assert.equal(projectIdFromPath(projectHref("abc123")), "abc123");
});

test("the placeholder is not treated as a project id", () => {
  // Otherwise the editor would go looking for a project called "__project__"
  // every time someone landed on the build artifact's own path.
  assert.equal(projectIdFromPath(PLACEHOLDER_PATH), null);
});

test("non-project paths yield no id", () => {
  assert.equal(projectIdFromPath("/dashboard/projects"), null);
  assert.equal(projectIdFromPath("/dashboard"), null);
  assert.equal(projectIdFromPath("/dashboard/projects/"), null);
  assert.equal(projectIdFromPath(null), null);
  assert.equal(projectIdFromPath(undefined), null);
});

test("a round trip through the href builder survives escaping", () => {
  // Ids are our own opaque handles, but the pair must still be lossless for
  // anything a URL can carry — a mismatch here is an "opens the wrong project".
  for (const id of ["abc123", "a-b_c", "AAAAAAAA"]) {
    const href = projectHref(id);
    assert.equal(projectIdFromPath(href), id, href);
    assert.equal(rewriteAppPath(href), PLACEHOLDER_PATH, href);
  }
});
