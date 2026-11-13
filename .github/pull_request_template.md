## Why

<!-- The problem this solves. Link the issue (Fixes #123) or RFC when there is one. -->

## What changed

<!-- The change and anything a reviewer should look at first. -->

## Checks

- [ ] `pnpm check` passes (includes the privacy check)
- [ ] `pnpm build`, then the full e2e suite passed twice in a row
- [ ] The RFC and both READMEs (English and Chinese) are updated if behavior or a contract changed
- [ ] Tests use fakes only: no real Agent, generation provider or vendor API calls
- [ ] No keys, tokens, private hosts, personal paths or internal names in the code, commits or this description

<!-- List expected skips, validation you could not run, and remaining risks. -->
