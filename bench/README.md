# Golden Editorial Benchmark

The quality harness for the Editorial Engine. Classic-parity tests prove code
behaviour didn't accidentally change; **this benchmark asks the real question:
"would this output be publishable without major manual correction?"**

## Two tiers

### Tier 1 — replay (committed, deterministic, runs today)

```
npm run bench:editorial                    # run + compare against bench/baseline.json
npm run bench:editorial -- --save-baseline # re-baseline (deliberate changes only)
```

`bench/fixtures/*.json` are **signal bundles** shaped like real analysis output
(attention curves, silences, scene changes, inferred-click false positives,
event clicks) replayed through the REAL server-side selection pipeline —
`balanceTimeline → decideTimeline → generateOverlayEdits → reviewComposition` —
per template listed in `manifest.json`. No Gemini, no I/O ⇒ byte-deterministic,
so baseline comparison is **exact** and the script exits non-zero on drift or
on a failed acceptance gate.

Acceptance gates (talking-head fixtures, Clean Professional vs Classic):
strictly fewer inappropriate edits · zero cursor emphasis · no cut regression ·
zero zoom-spacing violations · zero decorative overlays.

Notes on the metrics table: `spacing viol.` for CLASSIC cells is measured
against the 12s reference bar (Clean Professional's) so the columns compare;
Classic itself never promised that spacing. `inappropriate` is fixture-kind
aware (cursor emphasis / speed / decoration **on talking footage**).

### Tier 2 — real videos (corpus required, tolerance bands)

Real videos live in the dev-project bucket named in `manifest.json`
(`video_corpus.bucket`) — **never in the repo**. The `wanted` list is the
corpus to collect. Because the CV pass and Web Audio run in the browser, the
honest harness is Playwright against the standalone server (the existing
`scripts/serve-standalone.mjs` E2E pattern): upload fixture → set
`templateId` → run analysis → snapshot `analysis.detectedMoments` +
diagnostics into `bench/runs/`. Gemini makes these runs nondeterministic, so
tier-2 comparisons use tolerance bands (±1 edit per type, ±10% counts), never
exact equality — and the **human rubric scores one designated run**.

Status: harness deferred until the corpus exists (Phase 1 report, section J).
Adding a video = upload to the bucket + an entry in `video_corpus.entries` +
a run.

## The human rubric

Auto-metrics catch violations; a person judges publishability. Score each
output against `scores/RUBRIC.md`, store one JSON per run in `scores/`, and
trend them. The rubric gates each phase exit; auto-metrics gate every
editorial PR.
