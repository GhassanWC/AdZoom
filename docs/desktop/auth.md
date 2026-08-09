# Desktop authentication

Framevo Desktop signs in to **the same Firebase account as the website**. Same
uid, same subscription, same projects, same usage. There is no second identity
system and no second user table.

What differs is only *where the password is typed*.

## Why not `signInWithPopup`

Google refuses to serve its sign-in page inside an embedded user agent
(`disallowed_useragent`), and that refusal is correct: a desktop app that draws
its own Google login is indistinguishable from one harvesting passwords. The
user must authenticate in a browser they control, where the address bar and
their password manager can vouch for the origin.

So the desktop app implements Google's **OAuth 2.0 for Mobile & Desktop Apps**
flow instead.

## The flow

```
 renderer          main process              system browser         Framevo API        Google
    │                    │                          │                    │               │
    │ signInWithGoogle() │                          │                    │               │
    ├───────────────────►│                          │                    │               │
    │                    │ bind 127.0.0.1:<port>    │                    │               │
    │                    │ PKCE verifier+challenge  │                    │               │
    │                    │ shell.openExternal ─────►│                    │               │
    │                    │                          │ consent ──────────────────────────►│
    │                    │       ?code&state  ◄─────┤                    │               │
    │                    │ POST {code, verifier} ──────────────────────► │               │
    │                    │                          │      code+secret ──┼──────────────►│
    │                    │                          │      id_token   ◄──┼───────────────┤
    │  { idToken }  ◄────┤◄──────────────────────────────────────────────┤               │
    │                    │                          │                    │               │
    │ signInWithCredential(GoogleAuthProvider.credential(idToken))       │               │
    │ → the SAME Firebase user the website's popup produces              │               │
```

| Step | Lives in | Why there |
| --- | --- | --- |
| PKCE, state, loopback listener | `desktop/src/main/auth/` | Needs a real socket; must not be reachable from the page |
| Consent screen | The user's browser | Google requires it; the user must see the true origin |
| Code → token exchange | `src/app/api/auth/desktop/exchange` | Needs the client **secret**, which cannot ship in an app bundle |
| Firebase session | The renderer's Firebase SDK | So every existing hook, rule and query works unchanged |

### Loopback, not a custom scheme

Google deprecated custom-URI-scheme redirects for desktop clients; loopback
(RFC 8252 §7.3) is the supported callback and the only one the authorization
endpoint will accept. The `framevo://` deep link the browser page offers
afterwards carries **no code and no token** — it exists purely to bring the app
window back to the front.

### What guards it

* **PKCE** binds the authorization code to the process that started the flow. A
  stolen code is useless without the verifier, which never leaves the machine.
* **`state`**, compared in constant time, is the CSRF guard: without it any page
  the user visits could POST to `http://127.0.0.1:<port>/?code=…` and graft an
  attacker's code onto the session.
* The listener binds **127.0.0.1 only** — never `0.0.0.0`, which would expose
  the callback to the local network.
* The exchange endpoint accepts **only loopback redirect URIs**, and returns
  only the ID token. The access and refresh tokens stay on the server and are
  discarded; Framevo never acts on the user's behalf at Google.

`desktop/test/oauth.test.mts` covers each of these as a unit test.

## Configuration

### The rule that makes this fail

**A Google OAuth client only works with the Firebase project it was created
in.** Firebase refuses an ID token whose audience belongs to another project:

```
auth/invalid-credential — "Google ID token audience is not authorized for this application"
```

That message names neither project, which makes it maddening to diagnose. It is
however trivially detectable in advance, because an OAuth client id is
`<GCP project number>-<hash>.apps.googleusercontent.com` and the Firebase web
config's `messagingSenderId` **is** that project number. So Framevo compares
them — at build time, at Electron startup, and in the exchange endpoint — and
reports a mismatch naming both sides. See `config/desktop-env.mjs`.

You therefore need **one desktop OAuth client per Firebase project**:

| Environment | Firebase project | Create the OAuth client in |
| --- | --- | --- |
| development | `adzoomdev` | the `adzoomdev` Google Cloud project |
| production | `adzoom-prod` | the `adzoom-prod` Google Cloud project |

Console path: *APIs & Services → Credentials → Create credentials → OAuth client
ID → Application type: **Desktop app***. Nothing needs registering as a redirect
URI; loopback is implicit for that type.

### Where the values go

Environment-specific files, never `.env.local`:

```
.env.development.local     ← adzoomdev config + its desktop OAuth client
.env.production.local      ← adzoom-prod config + its desktop OAuth client
```

| Variable | Read by | Secret? |
| --- | --- | --- |
| `GOOGLE_DESKTOP_OAUTH_CLIENT_ID` | the exchange route **and** the desktop build | No — it appears in the authorization URL |
| `GOOGLE_DESKTOP_OAUTH_CLIENT_SECRET` | the exchange route only | **Yes — server only, never bundled** |
| `FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID` | the desktop build | No. Optional: only to point the app at a *different* client than the server route uses |
| `NEXT_PUBLIC_CLOUD_API_BASE` | the desktop build | No |
| `NEXT_PUBLIC_FIREBASE_*` | the renderer build | No |

### Precedence, and why `.env.local` is excluded

`.env.local` carries no environment in its name, so anything left there reaches
**both** dev and prod builds. That is precisely how a production OAuth client
ended up in a development desktop build. The desktop reader therefore consults
only:

```
.env  →  .env.<environment>  →  .env.<environment>.local      (later wins)
```

An **empty** assignment is meaningful: it overrides a lower file with "not
configured", which fails loudly instead of falling through to the other
environment's value.

> **Note for the web app.** Next's own precedence puts `.env.local` *above*
> `.env.production`, so a production web build on a developer machine can pick
> up dev credentials from `.env.local`. Production values are restated in
> `.env.production.local` (the highest tier) to close that.

### Which environment a command builds

Declared, never inferred — `NODE_ENV` is unreliable here because npm does not
set it and `next build` sets its own in child processes.

| Command | Environment |
| --- | --- |
| `npm run desktop:dev` | `development` (set by `scripts/dev.mjs`) |
| `npm run desktop:package` / `make` | `production` (set by `scripts/package-win.mjs`) |
| anything else | `FRAMEVO_ENV`, else `NODE_ENV`, else `development` |

`FRAMEVO_ENV=production npm run …` overrides any of it deliberately.

**How the build gets the values.** Neither build step reads `.env` on its own —
Next resolves those files relative to `desktop/renderer` (where they don't
exist), and esbuild reads none at all. Both go through `config/desktop-env.mjs`,
which returns **only** the variables asked for. `desktop/esbuild.mjs`
substitutes the client id and API base into the main bundle;
`build-renderer.mjs` forwards `NEXT_PUBLIC_*` to the renderer. The client
*secret* is never among them, and `desktop/test/bundle-secrets.test.mts` greps
the real build output to prove it.

Both build steps print the resolved Firebase project, Google Cloud project
number, OAuth client id and API base, then **fail the build** if the pairing is
inconsistent. Electron logs the same summary at startup.

**Nothing secret is ever placed in the Electron bundle** — no client secret, no
Firebase Admin credential, no service-account file. See `security.md`.

## Sessions

* **Persistence** is pinned to `browserLocalPersistence` on the app's own
  `framevo://app` origin, at `initializeAuth` time (`src/lib/firebase/client.ts`).
  It has to be set there: `setPersistence()` runs *after* Firebase has already
  read the stored user, so a session written to one store and read from another
  is simply lost — which presents as "the app signs me out every launch".
* **Restore** happens before anything protected renders. `DesktopAuthGate` holds
  a full-window splash while `useAuth().loading` is true, so there is no frame in
  which dashboard content exists for a signed-out user.
* **Revocation** is checked once per launch: the desktop forces a token refresh
  on the restored session. A disabled, deleted or revoked account fails that
  refresh and is signed out to `/login`. A *network* failure is explicitly not
  treated as revocation — offline users keep working.
* **Sign-out** clears the persisted session, cancels any half-finished browser
  flow, and returns to `/login`.

## Other providers

Framevo currently enables Google only, on both web and desktop. Any provider
that does not need a browser hop (email/password, custom tokens) works through
the same `AuthProvider` unchanged if it is enabled in the Firebase project —
the desktop path only replaces the *popup*, not the session model.

## Testing

The interactive half cannot be automated, and shouldn't be: the point of the
design is that Framevo never handles the password. `desktop/e2e/fixtures.ts`
therefore seeds a session into the store Firebase restores from — the same thing
a second launch does — and runs the suite with outbound http(s) blocked, so the
seeded session survives and the offline path is exercised for free. See
`desktop/e2e/auth-navigation.spec.ts`.
