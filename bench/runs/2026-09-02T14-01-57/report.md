# Editorial benchmark — replay tier (2026-09-02T14-01-57)

## th-01-clean-speaker (talking-head)

| template | mode | live AI | zooms | cursor | cuts | speed | decor | spacing viol. | overlaps | clusters | disabled | inappropriate | quiet share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| classic-talking-head | classic | 7 | 2 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0.517 |
| talking-clean-pro | enforce | 6 | 2 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.572 |

## th-02-energetic-creator (talking-head)

| template | mode | live AI | zooms | cursor | cuts | speed | decor | spacing viol. | overlaps | clusters | disabled | inappropriate | quiet share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| classic-talking-head | classic | 8 | 3 | 2 | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 3 | 0.347 |
| talking-clean-pro | enforce | 5 | 3 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.587 |

## th-03-low-signal (talking-head)

| template | mode | live AI | zooms | cursor | cuts | speed | decor | spacing viol. | overlaps | clusters | disabled | inappropriate | quiet share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| classic-talking-head | classic | 7 | 0 | 1 | 4 | 1 | 0 | 0 | 0 | 0 | 0 | 2 | 0.554 |
| talking-clean-pro | enforce | 6 | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.613 |

## sr-01-saas-walkthrough (screen-recording)

| template | mode | live AI | zooms | cursor | cuts | speed | decor | spacing viol. | overlaps | clusters | disabled | inappropriate | quiet share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| classic-screen-recording | classic | 15 | 4 | 2 | 1 | 1 | 7 | 0 | 9 | 6 | 0 | 0 | 0.45 |

## hy-01-intro-then-demo (hybrid)

| template | mode | live AI | zooms | cursor | cuts | speed | decor | spacing viol. | overlaps | clusters | disabled | inappropriate | quiet share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| classic-auto | classic | 9 | 4 | 2 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.424 |
| talking-clean-pro | enforce | 6 | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.59 |

## Acceptance gates (talking-head fixtures, Clean Professional vs Classic)

- ✅ th-01-clean-speaker · fewer-inappropriate (2 → 0)
- ✅ th-01-clean-speaker · zero-cursor-emphasis (0)
- ✅ th-01-clean-speaker · no-cut-regression (2 → 3)
- ✅ th-01-clean-speaker · zoom-spacing-clean (0)
- ✅ th-01-clean-speaker · zero-decoration (0)
- ✅ th-02-energetic-creator · fewer-inappropriate (3 → 0)
- ✅ th-02-energetic-creator · zero-cursor-emphasis (0)
- ✅ th-02-energetic-creator · no-cut-regression (1 → 1)
- ✅ th-02-energetic-creator · zoom-spacing-clean (0)
- ✅ th-02-energetic-creator · zero-decoration (0)
- ✅ th-03-low-signal · fewer-inappropriate (2 → 0)
- ✅ th-03-low-signal · zero-cursor-emphasis (0)
- ✅ th-03-low-signal · no-cut-regression (4 → 5)
- ✅ th-03-low-signal · zoom-spacing-clean (0)
- ✅ th-03-low-signal · zero-decoration (0)