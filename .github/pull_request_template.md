<!--
Base branch should be `staging`, not `master`.
Production releases are a separate, manual staging → master PR.
-->

## What & why

<!-- One paragraph. Link the issue: "Closes #123" -->

Closes #

## How it was verified

<!--
Not "tests pass" — what did you actually observe? Which flow was exercised?
If it could not be verified end-to-end, say so plainly and explain why.
-->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:e2e`
- [ ] `npm run build`
- [ ] Exercised the affected flow in the running app

## Risk & rollback

<!-- What could this break? Anything needing a migration, a redeploy, or an env/secret change? -->

## Reviewer notes

<!--
Call out anything deliberately left out of scope, any tradeoff taken, and
anything you were NOT able to confirm.
-->
