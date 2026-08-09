/**
 * The guard against a desktop app built from two environments at once.
 *
 * `build:bundle` and `build:renderer` are separate commands with separate
 * configuration. Each validates itself, so a stale renderer/out paired with a
 * fresh main passes both and dies at sign-in with `auth/invalid-credential` —
 * a message naming two project numbers and neither artifact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeBuildMismatch,
  oauthProjectNumber,
  parseRendererStamp,
} from "../src/main/build-identity.ts";

const DEV_CLIENT = "574329747163-sfkv5i2c.apps.googleusercontent.com";
const PROD_CLIENT = "461465030931-j3ksvsov.apps.googleusercontent.com";

const devMain = {
  environment: "development",
  googleClientId: DEV_CLIENT,
  apiBaseUrl: "http://localhost:3000",
};
const prodStamp = {
  environment: "production",
  firebaseProjectId: "adzoom-prod",
  messagingSenderId: "461465030931",
  apiBaseUrl: "https://framevo.app",
};

test("a project number is read only from a well-formed client id", () => {
  assert.equal(oauthProjectNumber(DEV_CLIENT), "574329747163");
  assert.equal(oauthProjectNumber("not-a-client-id"), null);
  assert.equal(oauthProjectNumber(""), null);
});

test("a dev bundle serving the production renderer is caught, and both halves named", () => {
  const message = describeBuildMismatch(devMain, prodStamp);
  assert.ok(message);
  assert.match(message, /574329747163/);
  assert.match(message, /461465030931/);
  assert.match(message, /adzoom-prod/);
  // It has to say what to DO, not just that something is wrong.
  assert.match(message, /desktop:build/);
  assert.match(message, /production screen inside a development build/);
});

test("halves that agree say nothing at all", () => {
  assert.equal(
    describeBuildMismatch({ ...devMain, googleClientId: PROD_CLIENT }, prodStamp),
    null
  );
});

test("a missing or unusable stamp is not treated as a mismatch", () => {
  // No stamp: a dev server, or a renderer built before this check existed.
  assert.equal(describeBuildMismatch(devMain, null), null);
  assert.equal(parseRendererStamp(null), null);
  assert.equal(parseRendererStamp({ environment: "production" }), null, "no project number");
  assert.equal(parseRendererStamp("{}"), null);
  // A build with no OAuth client cannot disagree with anything.
  assert.equal(describeBuildMismatch({ ...devMain, googleClientId: "" }, prodStamp), null);
});

test("a stamp is read defensively and keeps only strings", () => {
  const stamp = parseRendererStamp({
    environment: "production",
    firebaseProjectId: "adzoom-prod",
    messagingSenderId: "461465030931",
    apiBaseUrl: 42,
  });
  assert.deepEqual(stamp, {
    environment: "production",
    firebaseProjectId: "adzoom-prod",
    messagingSenderId: "461465030931",
    apiBaseUrl: "",
  });
});
