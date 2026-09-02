# Editorial quality rubric

Score each benchmark output 1–5 per criterion (5 = professional). One JSON per
scoring session in this directory:

```json
{
  "runId": "2026-09-02T14-01-35",
  "fixtureId": "th-01-clean-speaker",
  "templateId": "talking-clean-pro",
  "scorer": "initials",
  "scores": {
    "inappropriateEdits": 5,
    "missedObviousEdits": 4,
    "timing": 4,
    "densityPacing": 5,
    "zoomQuality": 4,
    "captionQuality": 0,
    "visualConflicts": 5
  },
  "publishable": true,
  "notes": "one sentence, optional"
}
```

Criteria:

1. **Inappropriate edits** — edits that don't belong on this content at all
   (cursor emphasis on camera footage, speed ramps mid-sentence, decorative
   noise). 5 = none.
2. **Missed obvious edits** — dead air left in, an emphatic beat with nothing,
   a loading stretch at 1×. 5 = nothing obvious missed.
3. **Timing** — edits land ON their beats, not 0.5s off.
4. **Density / pacing** — the rhythm a professional would sign off on; quiet
   time where the content carries itself.
5. **Zoom quality** — framing, restraint, spacing, no twitchiness.
6. **Caption quality** — accuracy, styling fit, safe areas. Score 0 = N/A
   (no transcript on this fixture).
7. **Visual conflicts** — nothing stacked, colliding, or fighting for focus.

**The headline binary — `publishable`:** "Would I ship this output without
major manual correction?" Minor tweaks (retiming one zoom, editing hook copy)
still count as publishable; deleting a class of edits or re-editing a section
does not.

Phase-exit rule (approved clarification #4): on the talking-head fixtures,
Clean Professional must show strictly fewer inappropriate edits than Classic on
EVERY fixture, no severe missed-edit regression, an overall human score
improvement — and at least one fixture that was not publishable under Classic
must become publishable (if all fixtures are already publishable under Classic,
publishability must not regress and the quality score must improve).
