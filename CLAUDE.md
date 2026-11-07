@AGENTS.md

## Notes for Claude Code

- Typical split: Claude owns design (RFCs, contracts, UI specs), review and merging; larger implementation work is dispatched to Codex workers running in parallel (separate branches or worktrees). Each task spec states its scope, the files to read first, the acceptance criteria, and which directories are off limits.
- After merging worker branches, rerun `pnpm check`, `pnpm build` and two e2e rounds on the merged result before reporting.
