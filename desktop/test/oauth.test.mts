/**
 * The security-critical half of desktop sign-in.
 *
 * These are the checks that stand between "the user signed in" and "someone
 * else signed in as them": PKCE derivation, the state comparison that makes the
 * loopback callback un-forgeable, and the response reader that refuses anything
 * that isn't a real ID token. All pure, all runnable without Electron.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  base64Url,
  buildAuthUrl,
  callbackPage,
  createPkcePair,
  createState,
  exchangeEndpoints,
  isLoopbackApi,
  parseCallback,
  readExchangeResponse,
  statesMatch,
  unreachableMessage,
} from "../src/main/auth/oauth.ts";

test("the PKCE challenge is the S256 hash of its verifier", () => {
  const pair = createPkcePair();
  assert.equal(pair.method, "S256");
  // RFC 7636 requires 43–128 unreserved characters.
  assert.match(pair.verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal(
    pair.challenge,
    base64Url(createHash("sha256").update(pair.verifier).digest())
  );
  // No padding, no URL-unsafe characters — Google rejects both.
  assert.ok(!/[+/=]/.test(pair.challenge));
});

test("verifiers and states are never reused", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    seen.add(createPkcePair().verifier);
    seen.add(createState());
  }
  assert.equal(seen.size, 100);
});

test("the authorization URL is Google's installed-app flow, not an embedded one", () => {
  const url = new URL(
    buildAuthUrl({
      clientId: "client-123.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:51234",
      challenge: "CHALLENGE",
      state: "STATE",
    })
  );
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE");
  assert.equal(url.searchParams.get("state"), "STATE");
  // Loopback: the only redirect Google still accepts for desktop clients.
  assert.match(url.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+$/);
  // Framevo asks for identity only — never Drive, Gmail or anything durable.
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  // No secret is ever put in the URL.
  assert.equal(url.searchParams.get("client_secret"), null);
});

test("a build with no client id fails loudly instead of opening a broken page", () => {
  assert.throws(
    () =>
      buildAuthUrl({
        clientId: "",
        redirectUri: "http://127.0.0.1:1",
        challenge: "c",
        state: "s",
      }),
    /no Google desktop client id/i
  );
});

test("state comparison is exact and length-safe", () => {
  assert.ok(statesMatch("abc", "abc"));
  assert.ok(!statesMatch("abc", "abd"));
  assert.ok(!statesMatch("abc", "abcd"));
  assert.ok(!statesMatch("", ""));
  assert.ok(!statesMatch("abc", ""));
});

test("a callback with the right state yields the code", () => {
  const result = parseCallback("/?code=4%2Fabc-def&state=S", "S");
  assert.deepEqual(result, { ok: true, code: "4/abc-def" });
});

test("a forged callback is rejected — this is the CSRF guard", () => {
  // Any page the user visits could hit the loopback listener; without the state
  // check it could graft an attacker's code onto this session.
  assert.equal(parseCallback("/?code=stolen&state=WRONG", "S").ok, false);
  assert.equal(parseCallback("/?code=stolen", "S").ok, false);
  assert.equal(parseCallback("/?code=stolen&state=S", "").ok, false);
});

test("Google's own error responses become plain messages", () => {
  const denied = parseCallback("/?error=access_denied&state=S", "S");
  assert.equal(denied.ok, false);
  assert.match((denied as { message: string }).message, /cancelled/i);

  const other = parseCallback("/?error=server_error&state=S", "S");
  assert.equal(other.ok, false);
});

test("a malformed or oversized code never reaches the exchange", () => {
  assert.equal(parseCallback("/?code=&state=S", "S").ok, false);
  assert.equal(parseCallback(`/?code=has%20space&state=S`, "S").ok, false);
  assert.equal(parseCallback(`/?code=${"x".repeat(2049)}&state=S`, "S").ok, false);
});

test("only a well-formed JWT is accepted from the exchange service", () => {
  assert.equal(readExchangeResponse({ idToken: "aaa.bbb.ccc" }), "aaa.bbb.ccc");
  assert.throws(() => readExchangeResponse({ idToken: "not-a-jwt" }), /unexpected response/i);
  assert.throws(() => readExchangeResponse({}), /unexpected response/i);
  assert.throws(() => readExchangeResponse(null), /unexpected response/i);
  assert.throws(() => readExchangeResponse({ error: "Google rejected that sign-in." }), /rejected/);
});

test("a localhost API is also tried on IPv4, because Node prefers ::1", () => {
  const endpoints = exchangeEndpoints("http://localhost:3000/");
  assert.deepEqual(endpoints, [
    "http://localhost:3000/api/auth/desktop/exchange",
    "http://127.0.0.1:3000/api/auth/desktop/exchange",
  ]);
  // A remote base has exactly one address; there is no twin to guess at.
  assert.deepEqual(exchangeEndpoints("https://framevo.app"), [
    "https://framevo.app/api/auth/desktop/exchange",
  ]);
});

test("an unreachable service names the address, and dev is not told to check its wifi", () => {
  assert.ok(isLoopbackApi("http://localhost:3000"));
  assert.ok(!isLoopbackApi("https://framevo.app"));

  const dev = unreachableMessage("http://localhost:3000");
  assert.match(dev, /http:\/\/localhost:3000/);
  assert.match(dev, /npm run dev/);
  assert.ok(!/connection/i.test(dev));

  const prod = unreachableMessage("https://framevo.app");
  assert.match(prod, /https:\/\/framevo\.app/);
  assert.match(prod, /connection/i);
});

test("the browser callback page carries no credential and escapes its message", () => {
  const page = callbackPage({
    ok: false,
    message: `<img src=x onerror="alert(1)">`,
    deepLink: "framevo://app/dashboard",
  });
  assert.ok(!page.includes("<img"));
  assert.ok(page.includes("&lt;img"));
  // The deep link exists only to refocus the window — it must never carry the
  // code, which would put a credential in a URL the OS can log.
  assert.ok(!/code=/.test(page));
});
