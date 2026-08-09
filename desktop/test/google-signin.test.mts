/**
 * The desktop sign-in flow around its two network hops.
 *
 * The interesting property is WHEN failure is discovered. Signing in costs the
 * user a browser trip, an account choice and a password; finding out afterwards
 * that Framevo's own exchange service was never reachable wastes all of it and
 * burns the authorization code, so the check has to happen before the browser
 * ever opens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startGoogleSignIn } from "../src/main/auth/google-desktop.ts";

const CLIENT_ID = "574329747163-test.apps.googleusercontent.com";
const JWT = "aaa.bbb.ccc";

test("a down exchange service fails before the user is sent to Google", async () => {
  const opened: string[] = [];
  await assert.rejects(
    startGoogleSignIn({
      clientId: CLIENT_ID,
      apiBaseUrl: "http://localhost:3000",
      openExternal: async (url) => {
        opened.push(url);
      },
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    // The message names the address and the fix, not the user's connection.
    /localhost:3000.*npm run dev/s
  );
  assert.deepEqual(opened, [], "the browser must not open when sign-in cannot finish");
});

test("a POST-only endpoint answering 405 counts as reachable, and the flow completes", async () => {
  let authUrl = "";
  let exchanged: unknown = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    // The preflight is a GET; a healthy Next route replies 405 to it.
    if ((init?.method ?? "GET") === "GET") return new Response(null, { status: 405 });
    exchanged = JSON.parse(String(init?.body));
    return Response.json({ idToken: JWT });
  };

  const signIn = startGoogleSignIn({
    clientId: CLIENT_ID,
    apiBaseUrl: "http://127.0.0.1:3000",
    fetchImpl,
    openExternal: async (url) => {
      authUrl = url;
    },
  });

  // Play the part of the browser: wait for the app to hand out an authorization
  // URL, then hit its loopback redirect the way Google would.
  const deadline = Date.now() + 5_000;
  while (!authUrl && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(authUrl, "the browser should have been opened once the service answered");

  const params = new URL(authUrl).searchParams;
  const redirectUri = params.get("redirect_uri")!;
  const callback = await fetch(`${redirectUri}/?code=abc123&state=${params.get("state")}`);
  assert.equal(callback.status, 200);

  assert.deepEqual(await signIn, { idToken: JWT });
  assert.equal((exchanged as { code: string }).code, "abc123");
  // The verifier — never the challenge — is what redeems the code.
  assert.match((exchanged as { codeVerifier: string }).codeVerifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal((exchanged as { redirectUri: string }).redirectUri, redirectUri);
});
