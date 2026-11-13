# 0042 · Open-source practices

Status: implemented (steps a–d); the first publish and the visibility change wait for the maintainer, and step e waits for a second contributor

Date: 2026-11-09

Builds on the contributor guide (`AGENTS.md`, `CONTRIBUTING.md`) and the CI workflow (`.github/workflows/ci.yml`).

## Background

The maintainer plans to run visCreative as an open-source project and wants its repository practices to match well-run projects that teach contributors how to work with them (2026-11-09).

A good part of this already exists:

- `AGENTS.md` is the single rulebook for people and Agents; `CLAUDE.md` imports it. `CONTRIBUTING.md` covers setup, the definition of done and expected platform skips, and `docs/contributing/` explains adding an Agent or a provider.
- Code, comments, logs and new RFCs are English, enforced by `pnpm check:english`; UI copy lives in `messages.ts` in both languages, enforced by `pnpm check:i18n`. The README is bilingual and both versions change together.
- Architecture rules are checked by scripts (`check:boundaries`, `check:agents`), and CI runs check, build and one e2e round on every pull request.

What is missing falls into three areas.

**Nothing stops private values from being published.** There are two GitHub repositories, both private today:

| Remote | Repository | Contents |
| --- | --- | --- |
| `origin` | `visCreative-archive` | Full development history |
| `public` | `visCreative` | One squashed snapshot, "Initial public release of visCreative" (2026-11-07), 147 files behind `main` as of this RFC |

A scan of `main` on 2026-11-09 found nothing private in the tree: a vendor's name appears only in its public product names (an npm package scope and a speech API domain, each marked `privacy-allow`), the only home path is a placeholder in a test, and no internal hosts, private addresses, personal emails or key-shaped strings were found. The history is another matter. Commit authors include a work email, a personal email and a GitHub noreply address, and branch names carry a personal name. The snapshot avoided all of this by being squashed and committed with the noreply identity, but that was done by hand, and the local `user.email` of the main checkout is the work address: a commit made there and pushed straight to `public` would publish it. Nothing checks for any of this.

**Contributors have no entry points on GitHub.** There are no issue templates, pull request template, `CODEOWNERS`, or security policy, so a report or a pull request arrives with whatever its author thought to include, and a vulnerability report has no private channel.

**Lessons are scattered.** Pitfalls are recorded in RFC findings sections, tied to the RFC that met them. Someone working on the UI or an Agent adapter has no single place to look first.

## Goals

1. Publish only what is meant to be public, checked by a script on every commit path that leads to `public`.
2. Make publishing a repeatable, scripted step instead of a manual one.
3. Give contributors clear GitHub entry points: issue and pull request templates, code owners and a security policy.
4. Keep pitfalls in one place per topic, so people and Agents read them before touching an area.
5. Prepare an issue-first workflow for when there is more than one contributor, without adding overhead before then.

## Out of scope

- Rewriting or publishing the archive's history.
- An administrator-only rules file. The security, cost and data rules in `AGENTS.md` already state what may not change; making a file editable only with approval is a GitHub permission question for later.
- A documentation index checker. Worth doing once `docs/` grows; not needed to go public.
- A contributor license agreement. The project is MIT-licensed and contributions are taken under the same license.
- Changes to product behavior. This RFC is repository process only and does not touch the product principle.

## Design

### 1. Privacy check

`scripts/check-privacy.mjs`, written like the other `check-*.mjs` scripts: plain Node, no new dependency.

What it checks:

- **Tracked files**, content and paths (default), **staged changes** (`--staged`, for the pre-commit hook) or **a commit range** (`--range <a>..<b>`), including commit messages and author and committer identities.

What counts as private, in two layers:

- **Generic rules, in the repository.** Private IPv4 ranges (10/8, 172.16/12, 192.168/16) outside loopback and documentation ranges; email addresses outside `example.*` domains and `users.noreply.github.com`; absolute home paths (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`) except the placeholder names tests use; and key-shaped strings (`sk-…`, `AKIA…`, `ghp_…`, `xox?-…`, PEM private-key headers). Commit identities must be a noreply address.
- **Personal values, on the machine only.** `~/.config/vis-creative/private-words.txt`, one term per line: internal project names, hosts, people, a work email domain. The file is never committed; the check reads it when present and skips this layer when absent, which is what CI does.

A hit reports what kind of value matched, where (file and line, or commit), and which rule or list matched, **never the value itself**, so the check's own output cannot leak it. A value that is public on purpose (for example a vendor's public npm scope) is allowed by a `privacy-allow: <reason>` marker on its line or the line before; a marker without a reason does not count. Placeholder domains, the attribution trailers' noreply addresses, URL userinfo in tests and one- or two-letter placeholder names are allowed by the rules themselves. Locally the personal layer also adds the git user name and email and the home directory name; `!term` in the words file takes back an automatic term.

Where it runs:

- `pnpm check:privacy`, part of `pnpm check`, over tracked files with the generic rules. CI therefore runs it on every pull request.
- Opt-in hooks under `scripts/hooks/` (`git config core.hooksPath scripts/hooks`): `pre-commit` checks staged changes, and `pre-push` checks the pushed range when the target is the `public` remote, including both layers and commit identities.
- The release script (§2) runs it with both layers before every publish.

### 2. Publishing to `public`

`scripts/release-public.mjs` turns a verified commit of `main` into the next snapshot on `public/main`.

1. Refuse unless the working tree is clean and the commit is on `main`.
2. Build a new commit whose tree is exactly the `main` tree and whose single parent is the current `public/main`, so `public` is a linear series of snapshots that shares no history with the archive.
3. Set author and committer to the identity configured in `~/.config/vis-creative/release.json` (a noreply address); refuse if none is configured.
4. Resolve the previous snapshot's archive source from the local ref `refs/vis/public-snapshot`, or from `--since <ref>` when supplied. Refuse if neither exists, if the ref cannot be resolved, or if it is not an ancestor of `--source` (default `main`).
5. Take the message from `--message <file>`: a release summary written for the public. Collect `Co-Authored-By` trailers from all archive commits in `<previous source>..<source>` (previous exclusive, source inclusive, including merged branches) and append approved agent credits after a blank line. With no approved trailers, leave the supplied message unchanged.
6. Run the privacy check on the tree, the final message including trailers, and the identity, with both layers.
7. Print what would be pushed, the exact approved trailers, and counts of excluded candidates and omitted duplicates, then stop. Pushing needs `--push` and an interactive confirmation; Agents never pass `--push` without the maintainer's explicit request, like any other push.
8. Only after a successful push, update `refs/vis/public-snapshot` to the archive source commit. Dry runs, rejected confirmations, failed pushes and an unchanged public tree never advance it. If the push succeeds but recording fails, report that publication succeeded and print the local repair command.

#### Agent credit and the local range record (2026-11-13)

The maintainer decided to preserve the AI co-authors' credit on public snapshots. A single squashed commit otherwise loses the attribution recorded throughout the archive. Only emails in `PUBLIC_AGENT_EMAILS` in `scripts/privacy-rules.mjs` are copied: `noreply@anthropic.com` and `noreply@openai.com`. The privacy rules share this same list. Human co-authors, other addresses and malformed candidates are counted but their values are never printed or copied. Only Git-parsed, single-line trailers qualify; examples in commit bodies and folded or malformed values do not.

Deduplication uses the case-insensitive `(email, name)` pair, ordered alphabetically by email and then name using locale-independent lexical comparison. Distinct names with the same approved email retain their credit. Original trailer text is preserved; if equivalent pairs have different spelling or spacing, the lexically first original line is used, so traversal order cannot change the result. Copied names still pass the personal privacy rules before any trailer is printed.

The local ref lives in the archive repository's Git metadata, shared by its worktrees, outside the repository tree. Source hashes are never added to generated snapshot messages or metadata. A new clone needs an explicit seed or `--since`; the script does not guess from public history, which deliberately has no archive ancestry. The published snapshot `2d321d8a` came from archive source `e84cb111`. Seed that known correspondence once, in the archive checkout:

```sh
git update-ref refs/vis/public-snapshot e84cb111
```

An explicit range can be previewed without updating the record:

```sh
node scripts/release-public.mjs --message /tmp/release-summary.txt --since e84cb111~5 --source e84cb111
```

As with every release dry run, first check out the selected source with a clean tree. The ref is local release state; never push it or an archive branch to `public`.

These trailers provide durable attribution in each snapshot's commit message. They do not guarantee an entry in GitHub's Contributors list: GitHub associates contribution credit with account-linked email addresses, and the agents' shared vendor noreply addresses need not identify GitHub accounts. The snapshot author and committer remain the maintainer's noreply identity, so the list may still show only that author. See GitHub's [co-author attribution](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors) and [contributors graph](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors) documentation.

`public` only ever receives these snapshots. Its history shares nothing with the archive, so a branch of the archive pushed there would carry the whole archive history with it; the `pre-push` hook rejects that, because the range then contains commits with non-noreply identities. For a snapshot push it sees exactly one new commit.

The script never makes the repository public. Changing visibility is the maintainer's action on GitHub, after a final snapshot has passed the check.

### 3. GitHub entry points

- `.github/ISSUE_TEMPLATE/bug.yml` and `feature.yml`: issue forms asking for version or commit, platform, Agent and provider in use (never keys or tokens), steps, expected and actual results; for features, the problem before the proposal. `config.yml` disables blank issues and links to the security policy.
- `.github/pull_request_template.md`: the linked issue or RFC, what changed and why, and a checklist matching the definition of done: `pnpm check`, `pnpm build`, the full e2e suite twice, RFC and both READMEs updated when behavior or a contract changes, no real vendor calls in tests, privacy check clean.
- `.github/CODEOWNERS`: the maintainer owns everything by default, and explicitly owns `AGENTS.md`, `docs/rfc/`, `packages/protocol/`, the credential and sandbox code, and `.github/`, so a change there always asks for the maintainer's review once branch protection requires it.
- `SECURITY.md`: report vulnerabilities through GitHub private vulnerability reporting, not public issues; what is in scope (credential handling, sandbox escape, gateway permission bypass, cost limits); and that real provider keys must never be included in a report.
- Branch protection on `main` of the public repository: require the CI check and one review once there is a second maintainer. This is a GitHub setting, recorded in `CONTRIBUTING.md`.

### 4. Public-repository rules in `AGENTS.md`

A short "Public repository" section, next to the security rules:

- Everything written in the repository and on GitHub is public and permanent: code, docs, comments, fixtures, file names, commit messages, issues, pull requests and comments. Editing text later does not remove it from history.
- No internal company services, repositories, tools, hosts, people, accounts or project ids. Examples use placeholders (`<project dir>`, `me@example.com`).
- Machine-specific values live in local config, never in the repository.
- Commits that reach `public` use a noreply identity; run `pnpm check:privacy` and install the hooks.

### 5. Lessons

`docs/lessons/<topic>.md`, with an index in `docs/lessons/README.md`. Each entry states the symptom, the cause and what to do instead, in a few lines, and links the commit or RFC that found it. `AGENTS.md` tells contributors to read the file for the area they touch and to add an entry when they hit a non-obvious pitfall. RFC findings sections stay where they are; a lesson that applies beyond its RFC is copied into the topic file.

Seeded from recent work, for example:

- UI: on macOS and Linux `contextmenu` fires while the button is down, so a `popover="auto"` menu opened there is light-dismissed by the release (fixed in the work card menu).
- Agents: an ACP Agent may advertise a configuration choice it then refuses, so probes must tolerate per-choice refusals; CodeBuddy calls MCP tools through `DeferExecuteTool`, so tool identity comes from the wrapped name.
- Tooling: `pnpm` is not on `PATH` in some non-interactive shells; use `npx --yes pnpm@<version>`.

### 6. Issue-first workflow, deferred

Once a second regular contributor joins: every change starts from an issue, the contributor comments to claim it, works on a branch named after it (`fix/123-short-name`), and opens one pull request that links it (`Fixes #123`). Until then, issues are welcome but not required, and the pull request template only asks for a link when one exists. A workflow that closes unlinked pull requests is not added until the workflow itself is adopted.

## Steps

- **a.** Privacy check, hooks, `pnpm check:privacy` in `pnpm check`, the "Public repository" section of `AGENTS.md`, and `CONTRIBUTING.md` instructions. Done when the check passes on `main`, catches each rule in its own tests, and reports matches without values.
- **b.** GitHub entry points: issue forms, pull request template, `CODEOWNERS`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.
- **c.** Release script, then a dry run against the current `main`. The first real publish, and making the repository public, wait for the maintainer.
- **d.** `docs/lessons/` with the seeded entries and the pointer in `AGENTS.md`.
- **e.** Issue-first workflow, when a second contributor joins.

Steps a, b and d are independent; c needs a.

Progress (2026-11-09): a, b and d are implemented, and so is c up to the maintainer's part: the release dry run on `main` (5e4db1d) built a snapshot on top of `public/main` and passed the privacy check with both layers. Its first run reported only automatic personal terms (a public handle, and a short home directory name inside ordinary identifiers), which `!term` lines take back; see `docs/lessons/tooling.md`. What remains is the maintainer's first publish and visibility change.

## Decisions (maintainer, 2026-11-09)

1. **Launch path.** Everything in this RFC is prepared in the archive. The release script then syncs a final checked snapshot to `wengzq/visCreative`, and the maintainer makes that repository public. Whether development later moves to the public repository is decided after launch; until then the archive stays the development repository.
2. **Code of conduct.** Adopt the Contributor Covenant as `CODE_OF_CONDUCT.md`, with reports going to the maintainer through a private contact link on the maintainer's GitHub profile. GitHub has no private messages, so the maintainer adds that link to the profile before the repository goes public.
3. **Security contact.** GitHub private vulnerability reporting only; no email address is published. GitHub offers private vulnerability reporting only on public repositories, so the maintainer enables it on `wengzq/visCreative` right after making it public (Settings → Advanced Security → Private vulnerability reporting, or `gh api -X PUT repos/wengzq/visCreative/private-vulnerability-reporting`); until then the link in `SECURITY.md` does not work.
