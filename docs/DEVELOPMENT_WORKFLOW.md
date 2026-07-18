# Development workflow

How work gets from an idea to production in this repo.

## Branches

```
claude/issue-123  ──PR──▶  staging  ──manual PR──▶  master
   (or feature/*)          (test here)              (production)
```

| Branch | Role | Who writes to it |
| --- | --- | --- |
| `master` | Production. Firebase App Hosting deploys from here. | Nobody directly — only a reviewed `staging` → `master` PR. |
| `staging` | Integration. Where you test the site before release. | Merged PRs from task branches. |
| `claude/issue-*`, `feature/*` | One task, one branch. | Claude, or you. |

**Nothing merges or deploys automatically.** CI reports status; a human clicks
merge. Releasing to production is a deliberate, separate PR from `staging` into
`master`.

## The loop

1. **File an issue** using the *Development task* template. The issue body is
   Claude's entire specification — it cannot ask follow-up questions mid-run, so
   ambiguity here becomes a wrong PR. Fill in acceptance criteria and constraints.
2. **Add the `claude` label** when the task is genuinely ready to build. This is
   the trigger; filing the issue alone does nothing.
3. **Claude implements it** — branches off `staging`, writes code and tests, runs
   typecheck/tests/build locally, and opens a PR into `staging`. If the issue
   turns out to be underspecified, it is instructed to stop and comment rather
   than guess.
4. **CI runs** on the PR (see below).
5. **You review and merge** into `staging`.
6. **You test the site** off `staging`.
7. **You open `staging` → `master`** yourself when you want to release.

## CI gates (`.github/workflows/ci.yml`)

Runs on every PR into `staging` or `master`.

| Job | Command | Blocking? |
| --- | --- | --- |
| Lint | `npm run lint` | **No — advisory for now** |
| TypeScript | `npm run typecheck` | Yes |
| Unit tests | `npm test` (node:test, ~540 tests) | Yes |
| Production build | `npm run build` | Yes |
| Playwright E2E | `npm run test:e2e` | Yes |

### Why lint is non-blocking

ESLint was added after the codebase existed and starts with a backlog of ~124
errors and ~42 warnings. Blocking on it would fail every PR on unrelated debt.

**To make it blocking:** clear the backlog (`npm run lint:fix` handles the
mechanical ones), then delete the `continue-on-error: true` line from the `lint`
job in `ci.yml`. That single line is the whole switch.

### E2E scope

Playwright covers **unauthenticated public pages only** (`e2e/smoke.spec.ts`),
served from a real production build. CI runs with *placeholder* Firebase
credentials — the app guards real access behind `isFirebaseConfigured()`, so
public pages render fine without secrets.

Covering the editor, dashboard, or any signed-in flow would need the Firebase
emulator plus seeded test accounts. That is a deliberate future step, not an
oversight. **Do not** wire real Firebase credentials into CI to widen coverage.

The specs assert *structure* (page responds, renders an `<h1>`, no client-side
exception) rather than marketing copy, so wording changes don't turn CI red.

## Required repository setup

These are one-time, and must be done in the GitHub UI.

### 1. Secrets — Settings → Secrets and variables → Actions

| Name | Type | Required | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Secret | **Yes** | Authenticates Claude. Without it the workflow fails immediately. |
| `CLAUDE_APP_ID` | Variable | Recommended | GitHub App id — see below. |
| `CLAUDE_APP_PRIVATE_KEY` | Secret | Recommended | GitHub App private key. |

### 2. The GitHub App (recommended — read this one)

A pull request opened using the default `GITHUB_TOKEN` **does not trigger other
workflows.** GitHub blocks that to prevent recursive runs. The practical
consequence: Claude opens a PR and CI never runs on it — it looks green because
nothing ran, which is worse than red.

Fix it by creating a GitHub App (Contents, Issues, and Pull Requests: read &
write), installing it on this repo, and setting `CLAUDE_APP_ID` /
`CLAUDE_APP_PRIVATE_KEY`. The workflow picks it up automatically.

Without the app everything still works, but you must push an empty commit or
close-and-reopen each of Claude's PRs to make CI run.

### 3. Branch protection — Settings → Branches

Recommended, and what makes "no automatic merges" actually enforced rather than
merely intended:

- **`master`**: require a PR, require CI to pass, restrict who can push.
  Consider allowing `staging` as the only merge source.
- **`staging`**: require a PR and require CI to pass.

### 4. Labels

Create a `claude` label. It is the trigger for the implementation workflow.

## Running the checks locally

```bash
npm run typecheck
npm test              # node:test, fast (~3s)
npm run lint          # advisory
npm run build         # production build
npm run test:e2e      # Playwright — needs `npm run build` first
npm run test:e2e:ui   # interactive debugging
```

First E2E run needs browsers: `npx playwright install chromium`.

`npm run test:e2e` serves the **existing** `.next` build — it does not rebuild.
If you changed app code, run `npm run build` first or you'll be testing stale
output.

It serves that build through `scripts/serve-standalone.mjs`, which boots
`.next/standalone/server.js` — the exact artifact Firebase App Hosting runs.
`next start` is deliberately *not* used: it does not support
`output: "standalone"`, so it would exercise a server path production never
takes. The script also copies `.next/static` and `public/` into the standalone
folder, which the Next build intentionally leaves to the deployer.

> Don't run `npm run build` while `npm run dev` is running — it corrupts the
> Turbopack cache and dev starts throwing Internal Server Errors.

## Guardrails on the Claude workflow

The prompt in `claude-implement-issue.yml` forbids: deploying, running any
`deploy:*` script, touching `firestore.rules` / `storage.rules` /
`apphosting.yaml` / `cloudbuild*.yaml` unless the issue asks, committing
secrets, pushing directly to `staging` or `master`, opening PRs against
`master`, and merging its own PR.

It runs with `--max-turns 60` on `claude-sonnet-5`. For architecturally hard
tasks, switch `--model` to `claude-opus-4-8` in that workflow.
