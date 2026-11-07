# visCreative contributor guide

For AI agents (Codex, Claude Code, …) and humans working in this repository. Design decisions live in `docs/rfc/`; if this file and an RFC disagree, the RFC wins — fix whichever is wrong in the same commit.

## What this is

A multi-agent creative space: one shared canvas per project, several agent sessions (Codex, DeepSeek Harness/dsh) that read and write the canvas and submit image/video generation jobs through formal interfaces. Since RFC 0009 there are also work items, dispatch from root workspaces, a board and an inbox.

## Product principle

**Mechanism belongs to the product, proposals to the Agent, decisions to the author.** visCreative provides the foundations of creation and leaves taste to the person making the work. Check every RFC against this:

- The product never encodes what good looks like. Limits, safety and cost rules are mechanism; style, pacing, structure and tone are not.
- Agents bring craft and options. On open creative choices they offer distinct directions with reasons instead of one best answer, and they follow the author's direction.
- Default paths stay optional. A workflow or a vocabulary such as the shot table must not become the only way to make something.
- The author's work is protected, and choosing stays easy: writing, drawing and final selections change only through the author's own action. Enforce that in the gateway.
- Do not infer an author's taste behind their back. Anything remembered about it is written by them and editable by them.
- The author defines what good means and packages it their own way: skills today, plugins and workflows later. These are the extension points for taste, so they outrank built-in creative defaults, though never safety or cost rules. We ship the seams, not the taste.

## Layout

pnpm monorepo, Node 24+, TypeScript, zod 4, drizzle + better-sqlite3, React 19 + @xyflow/react 12.

| Path | Contents |
|---|---|
| `packages/protocol` | **The single contract**: zod schemas for RPC methods, events, error codes and views. `methods.ts` registers each method's callers (`ui` / `agent`) |
| `packages/domain`, `storage` | Domain ports; SQLite schema and drizzle migrations (one `space.db` per project, one global `app.db`) |
| `packages/canvas/{core,ui}` | Canvas service and canvas UI |
| `packages/workbench/{core,ui,codex,deepseek,claude}` | Sessions, turns, message queue, approvals; session and work-item UI; agent adapters and their developer instructions (`prompt.ts`) |
| `packages/generation`, `assets` | Generation jobs and providers (mock, render, Volcengine Ark); assets |
| `services/studiod` | Background daemon: gateway (`gateway.ts`), work-item service and global execution slots |
| `apps/web` | Local web UI (`src/client`) and browser e2e (`e2e/`). `apps/cli` is the `vis` command and MCP server agents use |

Layering is enforced by `scripts/check-boundaries.mjs`: UI packages talk to the backend only through `protocol` and never depend on a core package.

## Commands

```bash
pnpm install
pnpm check                               # boundary check + typecheck + all unit tests
pnpm build                               # required before e2e
pnpm --filter @vis/web test:e2e          # browser e2e: real studiod + fake Codex, no models or paid services
pnpm --filter @vis/web perf              # timeline performance report (RFC 0024 §8) under /tmp/vis-perf; measures only, not part of check or e2e
pnpm --filter @vis/storage db:generate   # after schema changes; never hand-write migrations
pnpm dev:studiod && pnpm dev:web         # run locally; data lives in ~/.vis-dev
```

**Definition of done**: `pnpm check` passes, and after `pnpm build` the full e2e suite passes **twice in a row**. Under heavy machine load e2e can hit timing failures; rerun the case alone to confirm. Never weaken an assertion to get green — if it is genuinely a timing issue, wait for the condition (`expect.poll`) and keep the assertion's intent.

## Code style

- No semicolons, single quotes. Comments explain *why*, not what; match the comment density of the file you are editing.
- Code is written in English: comments, test names, log lines and the fallback message of errors (`VisError.of(..., message)`, `new Error(...)`, zod messages). `pnpm check:english` (part of `pnpm check`) rejects Han characters there. Exceptions: UI copy dictionaries (`messages.ts`, the Chinese side of `error-messages.ts`), Agent-facing text (`prompt.ts`, overlays, capability `summary` / `description` in `protocol/methods.ts`), and test data that is user content (a node body like `'第一镜：清晨'` is data, not prose).
- New RFCs under `docs/rfc/` are written in English (from RFC 0025 on); earlier RFCs stay in Chinese and are not translated wholesale — notes added to them may be English. The README roadmap summarizes each RFC in English.
- UI copy never lives inline: put it in the package's `messages.ts` (`defineMessages` from `@vis/ui-kit`) in both Chinese and English, and format numbers and dates with `useFormat()`. `pnpm check:i18n` rejects hard-coded Chinese in UI code (RFC 0018).
- No new dependencies, icon libraries or CSS frameworks without discussion. Icons are inline SVG; colors come from theme variables in `app.css`.
- Change the contract in `packages/protocol` first, then implementations. Contract tests live in `protocol.test.ts` / `capabilities.test.ts`.
- e2e selectors use `aria-label` or visible text, not `data-testid`.
- Every animation respects `prefers-reduced-motion`.

## Hard rules

**Security (non-negotiable)**
- Provider API keys live only in the system credential store: macOS Keychain or Windows Credential Manager. On macOS, write through stdin to `security -i`, read with `security find-generic-password -s vis-creative.provider -a <providerId> -w`. On Windows, use WinRT `PasswordVault` through `powershell.exe -NoProfile -NonInteractive -Command -`, with both script and secret through stdin, resource `vis-creative.provider`, userName = providerId; discard the error stream. A key must never reach a database, config file, log, event, error message, or any agent-visible output.
- Never read or print the real `vis-creative.provider` credential entries. Tests use only the fake `vis-creative.provider.test` entry and delete it in `finally`.
- Never open credential files under `~/.dsh` or `~/.codex`. The app only launches dsh; it does not read or store `DEEPSEEK_API_KEY`, and must never ask users to paste it.
- On macOS, the sandbox prevents agents from reading provider keys, studiod tokens or database files. Windows has no equivalent isolation in RFC 0022: agents run as the current user and can technically access these resources; the UI must disclose this before key configuration. Gateway permissions, environment filtering and approval rules remain in force. The web UI never executes agent-produced HTML (Markdown goes through react-markdown with raw HTML disabled).
- Permissions are enforced in the gateway by caller and work-item relationships, never by prompt wording.

**Cost**
- Expensive things never repeat by accident: generation jobs are idempotent by `requestId`. Cancelling is not a refund — report `providerCancelled` honestly.
- Tests and development never call real Ark. Any end-to-end run with real generation or real agents needs the maintainer's explicit approval, an isolated data directory, and tightened daily limits in `providers.json`.

**Data**
- SQLite is the source of truth. State changes happen in transactions and emit events; clients deduplicate by `seq`.
- Content edits carry `expectedRevision` (read before write). A work item's `revision` also bumps when derived fields change, so the UI rereads and retries once for state transitions and pin/title edits.

## Work items and multi-agent (RFC 0009 + 0010 in brief)

- A work item is a workspace with its own directory and sessions. Sessions have no agent role; only root work items can dispatch direct children. Agent work writes require a linked, unarchived session and work-item relationships are checked in the gateway.
- States: todo → in_progress → in_review → done, plus reject, recall and reopen. Agents must follow these arrows (illegal transitions return `invalid_transition`); the user is never blocked — `work.move` lets the board move a card to any status with no reason or confirmation. A move only changes status: it never stops a running turn, cancels generation, or cascades to children (the UI just warns that work is still running); recall is the action that stops agents.
- Execution slots are global (default 6); when full, activations queue in cross-project FIFO order.
- Canvas nodes and assets belong to the project. Frames are ordinary organizational nodes, never work-item ownership or permission boundaries; deleting a work item keeps all canvas nodes. Adapters auto-accept vis tool confirmations in every session, including sessions without a work item. Other command/file approvals and security/cost limits remain in force; a session's `auto` approval mode (RFC 0015) only auto-approves commands and file writes whose canonical paths stay inside the session workDir or project dir, and asks for everything else.
- Reports from child work items route to the parent’s main session: the first unarchived session ordered by `createdAt` ascending (then ID). Replies and review feedback route to the child’s main session. Root work items reply directly to the user instead of calling `work.report`.
- `work.changes` uses this activation’s canvas events from the work item’s own sessions, sorted by per-node `lastSeq` descending; `changeCount` counts distinct changed nodes.
- Work messages are delivered and acknowledged per batch; an unacknowledged batch is redelivered once after a failed turn or a restart.
- UI spec: `docs/rfc/0009-ui-spec.md`, revised by `docs/rfc/0010-workspaces-without-canvas-binding.md`.

## Commits and collaboration

- Default branch is `main`; work on feature branches with English commit messages.
- Push or merge only when the maintainer asks.
- Attribution trailer: Codex uses `Co-Authored-By: Codex <noreply@openai.com>`; Claude Code uses the trailer its environment provides.
- When behavior or a contract changes, update the relevant RFC and both READMEs (English and Chinese) in the same change, including the roadmap.
- When several workers run in parallel, scope is split by directory. If you need to touch another worker's files or the contract, explain why to the coordinator first instead of widening your own scope.
- Screenshots (1600×1000, deviceScaleFactor 2) and scratch reports go under `/tmp`, not into the repo (`artifacts/` is gitignored).
