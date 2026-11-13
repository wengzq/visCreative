# Contributing to visCreative

Read [AGENTS.md](AGENTS.md) for the repository's architecture, coding rules, security constraints and collaboration rules. The [English README](README.md) and [Chinese README](README.zh-CN.md) explain setup and product behavior. Integration contributors should also read [Adding an Agent](docs/contributing/adding-an-agent.md) or [Adding a generation provider](docs/contributing/adding-a-provider.md).

## Setup and commands

Use Node 24 or newer and the pnpm version in `package.json`'s `packageManager` field (currently `pnpm@10.34.9`). If pnpm is not installed, run commands as `npx --yes pnpm@10.34.9 <command>`; no global install is needed. Install Chrome (or Edge on Windows), ffmpeg and ffprobe for browser and media tests. Caption rendering needs ffmpeg's ASS filter and the four built-in fonts; `fonts:fetch` downloads and verifies the fonts and their licenses.

```sh
pnpm install --frozen-lockfile
pnpm fonts:fetch
pnpm check                              # architecture, Agent literals, i18n, English code, types, unit tests
pnpm build                              # CLI, daemon, development client and web UI; required before e2e
pnpm --filter @vis/web test:e2e          # full browser suite with local fakes
pnpm --filter @vis/web perf              # optional timeline measurements under /tmp/vis-perf
pnpm --filter @vis/storage db:generate   # generate migrations after a storage schema change
```

For interactive development, run `pnpm dev:studiod` and `pnpm dev:web` in separate terminals. They use `~/.vis-dev`; tests create their own temporary data directories. Do not point test runs at development or production data. `VIS_CHROME_PATH` can select a nonstandard Chrome executable.

## Definition of done

`pnpm check` must pass. After `pnpm build`, the full browser e2e suite must pass **twice consecutively**. If a case fails under machine load, rerun it alone to investigate; never weaken an assertion to get green. Wait for the required condition with `expect.poll` when the failure is caused by timing. Check [known issues](docs/known-issues.md) for outstanding platform validation and performance work, and report any skips and validation you could not perform.

The [CI workflow](.github/workflows/ci.yml) runs check, build and one full browser e2e round on Linux for every pull request and push to `main`. Pushes to `main` also check and build on Windows and macOS; manual `workflow_dispatch` selects `os=all|ubuntu|windows|macos` (default `all`), and includes Linux e2e only when Ubuntu is selected. These two runners are omitted on pull requests. The public repository uses free runners; the archive workflow is disabled and unused. CI uses Node 24, pnpm from `packageManager`, a frozen lockfile, a cached pnpm store and full commit SHAs for actions. Failed runs upload command logs and available e2e diagnostic screenshots for seven days. Unit tests get a 20-second default on CI. E2e uses one worker and a 40-second default per-test budget on CI's two-CPU runners, with four workers and 20 seconds locally; per-assertion waits and explicit test-specific budgets are unchanged. CI's one e2e round does not replace the two-round local definition of done.

Tests use scripted fake Agents, mock/local render providers and local fake vendor servers; they require no provider key or real Agent login and must never call a vendor API. The optional installed-dsh handshake is disabled in CI. Real Agent or generation acceptance requires the maintainer's explicit approval, isolated data and tightened limits, as described in AGENTS.md.

### Platform coverage and expected skips

- Linux has Chrome discovery and PATH-based ffmpeg/ffprobe support, but no system credential backend or Agent isolation sandbox. The credential implementation explicitly rejects Linux operations; test fixtures use memory stores or fake command runners. Fake Agents can still exercise canvas and work-item RPCs. Native command approval cases in `web.e2e.ts`, `agent-registry.e2e.ts` and `session-panel.e2e.ts` share `supportsNativeApprovals` and skip on Linux because the adapter deliberately denies permission expansion without isolation; their assertions still run on macOS and Windows. Registry discovery, turns, attachments and approval-mode persistence remain covered on Linux.
- macOS sandbox enforcement tests skip on Linux and Windows because they require Seatbelt (`sandbox-exec`). Windows named-pipe, junction, executable-resolution and real test-only PasswordVault checks skip on other platforms. Platform-independent command-runner and sandbox-policy tests still run everywhere. Real credential tests only use the `vis-creative.provider.test` service and clean it up in `finally`.
- CI fetches the fonts and provisions ffmpeg/ffprobe. Linux Chrome sees the fetched CJK fonts through a temporary Fontconfig configuration and cache; no system-wide font installation is needed. The macOS runner is explicitly `macos-15` because the ffmpeg setup action supplies x64 macOS builds. CI prints tool versions and whether ASS is available in the job summary. If a downloaded build has no ASS filter, `packages/assets/src/timeline-captions.integration.test.ts` skips real caption rendering; `apps/web/e2e/timeline-text.e2e.ts` also skips it on Linux. The remaining caption logic tests still run. Missing Chrome or ffmpeg fails the CI tool check instead of silently skipping browser/media coverage.
- Encoder-specific `libopenh264` tests skip when that encoder is absent; benchmark tests remain opt-in. The CLI integration test in `services/studiod/src/cli.e2e.test.ts` skips on a clean checkout until `pnpm build` creates the CLI. Windows/macOS CI runs unit tests and build only, so their full browser suites remain local acceptance work. The first hosted Linux run passed check/build and exposed e2e platform/fixture/timing issues; its fixes need a hosted rerun, and Windows runner PasswordVault availability remains unverified; Linux CI is test coverage, not a claim of full Linux product support.

## Privacy and the public repository

Everything you commit, and everything you write on GitHub, is public and permanent. `pnpm check:privacy` (run by `pnpm check` and CI) rejects private network addresses, real-looking email addresses, home directory paths and key-shaped strings in tracked files. Its output names the rule and the place, never the matched value. Use placeholders such as `me@example.com` or `<project dir>`; for a value that is public on purpose, add `privacy-allow: <reason>` on the same line or the line before.

Install the hooks once per clone:

```sh
git config core.hooksPath scripts/hooks
```

`pre-commit` checks staged changes. `pre-push` checks pushes to the `public` remote (or `VIS_PUBLIC_REMOTE`), including commit messages and noreply identities. Locally the check also matches your git name and email, your home directory name, and terms you list in `~/.config/vis-creative/private-words.txt` (one per line, `#` comments, `!term` to take back an automatic term). That file never leaves your machine; CI runs only the generic rules.

The maintainer publishes with `scripts/release-public.mjs` (RFC 0042 §2), which turns a verified `main` into a single snapshot commit on the public repository under a noreply identity. Contributors never push to it directly. Report security problems through GitHub private vulnerability reporting, as described in [SECURITY.md](SECURITY.md).

## Design and review

Design decisions live in [docs/rfc](docs/rfc/). Read the relevant RFC before changing behavior. Propose a new RFC for a new design or update the existing one for an agreed change; an RFC takes precedence over AGENTS.md, and any disagreement must be corrected in the same change. New RFCs are in English. When behavior or a contract changes, update its RFC and both README roadmaps in the same change.

Change the shared contract in `packages/protocol` first, including contract tests, then implement it. Respect package boundaries, keep database changes transactional and generate Drizzle migrations with the command above. Discuss new dependencies, icon libraries or CSS frameworks before adding them.

Write code, comments, test names, logs and fallback errors in English. Use single quotes and no semicolons. UI copy belongs in bilingual `messages.ts` dictionaries, with dates and numbers formatted through `useFormat()`. Agent-facing text and user-content test fixtures have the exceptions listed in AGENTS.md. Use accessible names or visible text for e2e selectors, and respect reduced-motion preferences for animations.

Work on a feature branch based on `main` and use English commit messages. Include the checks run, expected skips and remaining risks in the review description. Keep screenshots and scratch reports under the system temporary directory. Follow AGENTS.md for Agent attribution and approval before pushing or merging.
