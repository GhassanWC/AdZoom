# The website half: download, gate, deep links

The app is how people use Framevo, so the website's job is to get them into it —
without breaking for the people it can't serve.

## What the website keeps

Blocking editing on the web is a real cost, so the line is drawn at what
genuinely needs a local machine:

| Stays on the web                                   | Moves to the app        |
| -------------------------------------------------- | ----------------------- |
| Signing in, account, settings                       | Uploading a video       |
| Billing, plans, invoices                            | Recording               |
| Project history (the list, names, dates)            | Editing a project       |
| **Downloading finished exports**                    | Processing / analysis   |
| Every public/marketing page                         |                         |

Someone on a borrowed laptop must still be able to grab last week's export, and
someone on a phone must still be able to cancel their plan. `isGatedRoute()` in
`src/lib/desktop/gate.ts` is the whole rule, and the list above is asserted in
`tests/desktop-distribution.test.ts`.

## The gate

`src/components/desktop/DesktopGate.tsx`, mounted once in the dashboard layout.

It watches the ROUTE, not the button. "Editing happens in the app" is a property
of the destination — a deep link, a bookmark, a Back button and an in-app link
all have to land in the same place, and a per-button check would have covered
whichever ones we remembered.

Three outcomes:

- **allow** — ungated route, inside the desktop app, no published installer, or
  `NEXT_PUBLIC_DESKTOP_GATE=off`;
- **block** — the download dialog (desktop browser);
- **mobile** — "editing needs a computer", with links to exports and billing.
  Never a Windows installer on a phone.

It is a genuinely blocking dialog: background scroll is locked, focus moves
inside, Tab is trapped, and there is no Escape handler because there is nothing
to dismiss to.

## OS detection

`src/lib/desktop/platform-detect.ts` — pure, and used by both the server (from
request headers, including `Sec-CH-UA-*`) and the browser (`navigator`), so the
button and the endpoint it points at can't disagree.

Two things browsers cannot tell us, handled rather than guessed:

- **macOS architecture.** Chrome and Safari both report "Intel" on Apple Silicon
  for Rosetta compatibility. Ship a **universal** macOS build and the question
  disappears; `assetFor` prefers `arch: "universal"` for exactly this reason.
- **iPadOS.** Since iPadOS 13 an iPad's user agent is a Mac's. `maxTouchPoints
  > 1` on a "Macintosh" is the tell — without it we'd offer a tablet a .dmg.

Windows on ARM falls back to the x64 build (Windows 11 emulates it): a working
download beats a correct-looking dead end.

## Endpoints

| Route                    | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `/api/desktop/latest`    | JSON manifest: version, notes, per-asset URL/size/SHA-256   |
| `/api/desktop/download`  | Resolves OS + arch, 302s to the artifact                    |

`/api/desktop/download` is the URL to put in emails and docs — the storage
layout underneath can change without invalidating a published link. It answers
browsers and scripts differently (`Accept: text/html` → a redirect to
`/download` with a reason; otherwise JSON), so a human clicking a stale link
lands somewhere useful and a script gets something parseable.

Refusals are specific: **503** for an unpublished release (the production
download is never replaced by an unverified build), **404** naming the detected
platform when no asset exists, **400** for an invalid explicit `?platform=`.

## Deep links

`framevo://open/dashboard/projects/<id>` — built by
`src/lib/desktop/deep-link.ts`, validated by the SAME module in the Electron
main process.

A custom scheme is an OS-wide entry point: any web page in any browser can
navigate to `framevo://…` and the OS hands the string to the app. Main used to
load whatever path arrived; it now resolves through a closed allowlist and falls
back to the dashboard, so the worst a hostile link can do is open the app.

The website's "Open Framevo" button can't ask whether the scheme is registered —
no browser exposes that — so it navigates and watches for focus loss. That's a
heuristic, which is why it only decides whether to OFFER the download, never
whether to block anything.

## Analytics

The funnel has an end as well as a start:

| Event                          | Fired from                                  |
| ------------------------------ | ------------------------------------------- |
| `desktop_download_page_viewed` | /download                                   |
| `desktop_download_clicked`     | every download button (with `placement`)    |
| `desktop_gate_shown`           | the blocking dialog                         |
| `desktop_mobile_notice_shown`  | the phone/tablet state                      |
| `desktop_deep_link_attempted` / `_failed` | the website's "Open Framevo"      |
| `desktop_app_opened`           | the app, once per session                   |
| `desktop_app_installed`        | the app, first run (`fresh` vs `upgrade`)   |
| `desktop_deep_link_opened`     | the app, when a link actually landed        |

App-side events come from the renderer (`DesktopAppTelemetry`), which already
has the analytics pipeline — no second SDK in main. "First run" is a version
marker in `localStorage`, not a machine fingerprint: the app is local-first and
has no business identifying the device it runs on.
