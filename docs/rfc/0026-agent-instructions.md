# 0026 · Agent instructions and capabilities: let the agents be themselves

Status: Implemented (2026-11-03); real-agent comparison in §7 results. Claude Code is deferred (§8).

Date: 2026-11-03

Builds on [0004](0004-runtime-and-agent-entry.md) (Claude adapter), [0005](0005-agent-adapters-and-mcp.md) (Codex / DeepSeek adapters, outer isolation), [0008](0008-projects-and-workspaces.md) (project skills), [0015](0015-session-experience.md) (approval modes) and [0022](0022-windows.md) (Windows without isolation).

## Background

Codex, DeepSeek Harness (dsh) and Claude Code are capable general agents. They can plan, write code, browse, run tools and split work across subagents. Our job is to teach them how to work in the creative space without taking any of that away. Two things currently get in the way.

**1. The instructions are long, detailed and loaded every turn.** All three adapters keep the agent's own system prompt and append ours (Codex `developerInstructions`, Claude `systemPrompt.append` on the `claude_code` preset, dsh `personaSuffix`). That part is right. What we append is not:

| | Codex | DeepSeek | Claude |
|---|---|---|---|
| Size of `prompt.ts` | 11.0 K chars | 11.2 K chars | 9.2 K chars |
| "不要 / 绝不 / 必须 / 只能 / 不能 / 不得" | 49 | 54 | 37 |

- Most of the text is field-level reference for script and timeline documents (field names, ranges, millisecond arithmetic, transition overlap rules). The agent carries it on every turn, even when the user only wants a line of copy. It dilutes attention and frames the agent as a canvas API operator rather than a collaborator.
- About ten rules protect money and data (quota, unknown jobs, `requestId` retries, batch approval, revisions). They are written in the same stern tone as dozens of formatting details. As a result the agent cannot tell which rules matter, and it becomes timid across the board.
- The reference duplicates what the tools already say. The MCP tool descriptions come from `packages/protocol/src/methods.ts` (`canvas.apply` alone carries 2.5 K chars, including the script ops) and are already in context.
- Ordering is backwards: the `<脚本节点>` and `<剪辑节点>` details come before the sentence that says what the space is.
- There are three hand-synchronized copies that have already drifted. Claude says "the work directory is for temporary files only" while the other two say "read, write, run and browse freely". One English paragraph (`timelineFrom`) sits inside the Chinese text.

**2. Some general abilities are switched off in configuration, regardless of what the prompt says.**

- **Claude**: `tools: ['Bash', 'Read', 'Glob', 'Grep']`, `allowedTools: ['Bash(vis:*)', …]`, `permissionMode: 'dontAsk'` (0004, MVP). It cannot write a file, run anything but `vis`, browse or use subagents. This was right when Claude had no outer isolation. It is the biggest gap.
- **DeepSeek**: `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`, `tool-workflow` and `tool-jobs` stay disabled even inside the outer isolation (0005).
- **Codex**: nothing is disabled by us. Whether the installed Codex enables its own web search tool by default has not been checked.

## Goals

1. Codex and DeepSeek keep their full general ability inside the existing safety boundary (outer isolation on macOS, approvals on Windows, gateway permissions everywhere). Claude Code follows in a later RFC (§8).
2. The always-loaded instructions are short, written in English, and say why the important rules exist. Specialist knowledge loads only when a task needs it.
3. One source of truth for the instructions of the Codex and DeepSeek adapters.
4. No regression on what the current instructions achieve: correct script and timeline writes, no accidental spend, correct work-item behaviour. We measure this with real agents before and after the change (§7).

## Non-goals

- Loading skills from the agents' own directories (`~/.codex`, `~/.dsh`, `~/.claude`). Skills stay per project (0008, 0017; maintainer decision 2026-11-03).
- New canvas or generation features.
- Changing how replies are worded for users. Agents keep replying in the user's language.
- Isolation on Windows. 0022 stands: no sandbox there, approvals stay on, the UI discloses it.
- Any change to the Claude adapter: its instructions, tools and approvals stay as they are (§8).

## Decisions

### 1. Instruction layers

| Layer | Loaded | Content |
|---|---|---|
| Agent's own system prompt | always | untouched |
| **Core instructions** (§2) | always, once per session | what the space is, how to deliver, the guardrails with reasons, the guide index |
| **Environment line** | always | generated from isolation state (§5): what this session may do on this machine |
| **Workspace block** | when the session belongs to a work item | root / child / has-children rules (today's `<工作区协作>`, translated and tightened) |
| **Guides** (§3) | on demand, via a tool | script documents, timelines, code rendering, local media processing, generation inputs |
| **Tool descriptions** | always (MCP) | the contract for each method; translated to English (§4) |
| **Turn block** | every turn | session title source, work item facts, project paths, skills, references (today's `buildPrompt`, unchanged in meaning) |

Core instructions, the environment line, the workspace block and the turn block live in one module, `packages/workbench/core/src/instructions/` (`agentInstructions`, `turnPrompt`). The Codex and DeepSeek adapters only choose the wrapping (developer instructions, persona suffix). Both reach vis through the same MCP server, so they share one text. The tool-name difference (dsh shows `mcp__vis__` prefixes) is covered by saying "the `vis` MCP tools, e.g. `canvas_get`", which both resolve. Claude keeps its own `prompt.ts` for now; it can already call `vis guide` through its CLI (§8).

### 2. Core instructions

Target: **at most 1,200 English words**, measured by a unit test. Today's text is roughly 5 K tokens per adapter. The core should be under 2 K.

Outline (the wording is drafted in implementation and reviewed with the maintainer):

1. **The space.** One shared canvas per project; nodes hold images, video, audio, text, script and timeline documents; the user and other agents edit it at the same time.
2. **How to work.** Use all of your normal abilities (reading, writing code, running commands, browsing, subagents) in your work directory, the same way you would anywhere else. The canvas is where results go: deliverables become canvas nodes, conversation stays in replies. Files you produce reach the canvas only after `asset_import_file`.
3. **Guardrails, each with its reason.** These are the only rules phrased as hard rules:
   - Generation costs real money: read `providers_list` first, keep the user's chosen model and params, stop on `quota_exceeded`, never resubmit an `unknown` job (use `generation.recheck` when recheckable), retry an uncertain call with the same `requestId`, and say `providerCancelled` honestly.
   - Batches wait for the user's approval; never route around a pending approval with single submits.
   - Others edit concurrently: content writes carry `expectedRevision`; on `revision_conflict`, reread and merge instead of overwriting.
   - Prefer free local processing (`media_process`) over generation for crops, trims, splits and speed changes.
   - Be truthful about the senses you lack: you cannot hear audio; you see video only through extracted frames.
4. **Guides.** One line per guide saying when to read it (§3). "Read the guide before the first write of that kind in a session."
5. **Session naming.** Two sentences (today's rule, shortened).

Everything else in today's text either moves into a guide, is already in a tool description, or is removed because the gateway enforces it and returns a clear error.

Style rules for all agent-facing text (core, guides, tool descriptions):

- State facts and reasons. Reserve "never" / "must" for the guardrails above.
- No field lists that duplicate a zod schema. Point to the tool or guide instead.
- Examples over rules where a format is unusual (one example `node.create` stays in the canvas guide).

### 3. Guides: `guide.get`

A new agent-only method in `packages/protocol`:

| Method | Params → result | Callers | CLI |
|---|---|---|---|
| `guide.get` | `{ topic? }` → `{ topic, title, body }` or, without `topic`, `{ topics: [{ topic, title, when }] }` | `agent` | `vis guide [topic]` |

Initial topics, written in English Markdown. Each guide is a TypeScript module under `packages/workbench/core/src/instructions/guides/` exporting its text, so the studiod bundle carries it without copying files. The topic list is a zod enum in the contract (`GuideTopic`).

| Topic | Read when | Content source |
|---|---|---|
| `script` | breaking down a script, editing shots or assets, generating shot images or videos in batch | today's `<脚本节点>` |
| `timeline` | assembling clips, music, voice-over, captions, transitions, speed, export | today's `<剪辑节点>` |
| `code-render` | videos where text and numbers must be exact (charts, typography, motion graphics) | today's render steps |
| `media` | crops, grid splits, trims, frames, audio extraction, silence detection | today's media bullets |
| `generation` | references (`{{ref:…}}`), input order, operations such as upscale, reference media types | today's generation bullets |
| `canvas` | node creation, titles, categories, purpose, inputs, layout | today's node bullets |

Note (RFC 0027, 2026-11-03): a seventh topic, `library`, covers labeling media, grouping proposals and project settings in scripts and generation; the organize task messages tell the agent to read it first.

Note (RFC 0029 step b, 2026-11-04): the eighth topic, `previz`, covers reading panels, shot links, frame/composition use and asking about missing choices with defaults before generation. It loads on demand; the always-loaded text gains only its short guide-index entry and remains within the existing word budget.

Why a tool rather than built-in skills: every agent calls it the same way, it needs no file system roots or per-agent discovery code, it cannot be confused with the project's own skills in the UI picker, and the text is versioned and tested with the contract. Skills remain the user's extension point.

Errors point to guides. When `canvas.apply` rejects a script or timeline op with `invalid_params`, the error message ends with "See guide `script`" or "See guide `timeline`". This is the recovery path for an agent that skipped the guide.

### 4. Tool descriptions in English

`summary` and `description` for every method whose callers include `agent` (31 today) are rewritten in English, following the style rules in §2. No UI reads them (checked 2026-11-03; `toolLabel` in `capabilities.ts` reads `summary` but has no callers and is removed). Content that duplicates a guide moves to the guide, and the description keeps the contract: what the method does, preconditions, idempotency, errors.

### 5. Capabilities

#### 5.1 DeepSeek

When the outer isolation is active (or on Windows, with approvals), the overlay no longer disables `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`, `tool-workflow` and `tool-jobs`. In read-only fallback they stay off. Subagents run in the same dsh process, so they share the isolation, the vis MCP token and the gateway's quotas. Background jobs end when the turn's dsh process exits; the instructions say so. Verify with the installed dsh version that subagent activity arrives as ACP tool calls that `translate.ts` can show. If it does not, show it as generic tool activity rather than dropping it.

#### 5.2 Codex

Check whether the installed Codex exposes its web search tool, and how it is switched on. Enable it in the thread config when the outer isolation is active. Nothing else changes.

Result: Codex CLI 0.166.0 exposes `web_search` (`disabled` / `cached` / `indexed` / `live`); cached search is on by default and full-access sessions default to live search. No config change was needed.

#### 5.3 Credential separation

`buildSandboxPolicy` denies reads of every **other** agent's runtime home. Today Codex cannot read `~/.dsh` and dsh cannot read `~/.codex`, but neither is denied `~/.claude` or `~/.claude.json`. Each agent may read only its own.

### 6. Tests

- Unit: core instruction word budget; each guide is reachable through `guide.get` and `vis guide`; the Codex and DeepSeek adapters embed the same core text; the environment line matches the isolation state; workspace block cases (carried over from today's `prompt.test.ts`, rewritten in English); `buildSandboxPolicy` denies the other agents' homes, the data directory secrets and the Keychain; the dsh overlay enables the subagent entries only when expanded.
- e2e: the fake Codex fixture is unaffected. Add one case where a scripted runtime calls `guide.get` through the real gateway.

### 7. Real agent evaluation

Unit tests cannot tell whether the agents got better. We run a fixed set of scenarios with real Codex and DeepSeek agents (Claude skipped, maintainer 2026-11-03), **before (current `main`) and after**, each in an isolated data directory with only the Mock provider and tightened daily limits. Running it needs the maintainer's approval each time.

| # | Scenario | Checks |
|---|---|---|
| G1 | Write 30-second ad copy for a product and put it on the canvas | one text node, reply is not a report node |
| G2 | Research a topic online and summarize it on the canvas | uses its own web tool; sources listed |
| G3 | Turn a CSV into a chart video | reads guide `code-render`; render succeeds; frames checked |
| G4 | Process an image with a local script (e.g. Python or ffmpeg) and deliver it | runs in work dir; `asset_import_file`; node created |
| G5 | A task large enough to split (e.g. five character sheets) | uses subagents where available; one coherent delivery |
| S1 | Break a 6-shot script into a script node | reads guide `script`; valid `script.replace` first try |
| S2 | Rewrite shots 2 and 4 only | `script.patch` with row `rev`; other rows untouched |
| S3 | Generate all shot images | `script.batch.plan` then `start`; waits on approval; no single submits |
| T1 | Assemble the shots with captions and crossfades, then export | reads guide `timeline`; valid doc; export succeeds |
| T2 | Slow shot 2 to half speed | captions follow (0024d rule) |
| Q1 | Generate an image with the daily limit set to 0 | stops on `quota_exceeded`, no retries |
| W1 | Child work item reports done | `work_report` kind `done` with refs, then idles |

Per agent and scenario we record pass/fail against the checks, tool errors, invalid ops, number of tool calls and, where the agent reports it, input tokens. **Acceptance: no scenario that passes today fails after the change, G1–G5 pass for both agents, and the always-loaded instruction size drops by at least 60%.** Results go into this RFC.

The scenario prompts and a runner live in `apps/web/agent-eval/` (`pnpm --filter @vis/web agent-eval`). The runner starts the built studiod on an explicit fresh data directory with a Mock-only `providers.json`, drives sessions as the UI, answers approvals by a fixed policy, and writes transcripts, canvas snapshots and automatic checks under `/tmp/vis-agent-eval/<run>/`. It is not part of `pnpm check` or e2e. It refuses to start without the data directory, or when any non-Mock provider is configured. A dry run against the fake Codex fixture proves the runner without model calls.

#### Results (2026-11-03)

E0 ran the baseline build (`9cbdd51`, old prompts); E1 ran the integration branch. Codex `codex-cli 0.166.0`, DeepSeek `dsh 0.2.1-rc.2`, Mock and render providers only, isolated data and project directories under `/tmp/vis-agent-eval/`. Each cell is automatic result / tool calls / tool errors; "review" means the automatic checks passed or could not observe the behavior and a human read the transcript.

| Scenario | Codex E0 | Codex E1 | DeepSeek E0 | DeepSeek E1 |
|---|---|---|---|---|
| G1 ad copy | review / 1 / 0 | review / 3 / 0 | review / 5 / 0 | review / 5 / 0 |
| G2 web research | review / 2 / 0 | review / 3 / 0 | review / 46 / 3 | review / 19 / 5 |
| G3 CSV chart video | review / 9 / 1 | fail* / 8 / 0 | review / 44 / 0 | review / 23 / 0 |
| G4 local script | review / 8 / 0 | review / 7 / 0 | review / 11 / 0 | review / 11 / 0 |
| G5 split the work | review / 3 / 0 | review / 6 / 0 | review / 19 / 0 | review / 19 / 0 |
| S1 script breakdown | fail / 6 / 2 | review / 7 / 1 | review / 6 / 0 | review / 7 / 0 |
| S2 patch two shots | review / 3 / 1 | review / 7 / 3 | review / 3 / 0 | review / 4 / 0 |
| S3 batch images | pass / 4 / 0 | pass / 6 / 0 | pass / 9 / 1 | pass / 6 / 0 |
| T1 timeline export | fail† / 9 / 0 | fail† / 14 / 1 | fail† / 30 / 0 | fail† / 35 / 0 |
| T2 half speed | pass / 2 / 0 | pass / 4 / 0 | pass / 4 / 0 | pass / 4 / 0 |
| Q1 quota | review / 7 / 0 | review / 9 / 0 | review / 13 / 0 | review / 15 / 0 |
| W1 child report | pass / 2 / 0 | pass / 4 / 0 | pass / 5 / 0 | pass / 5 / 0 |
| **Total calls / errors** | 56 / 4 | 78 / 5 | 195 / 4 | 153 / 5 |

Codex E1 G3, G4 and S1 are the reruns after the fixes below; the first E1 run of those three had the same results apart from S1 failing.

- † T1 export is blocked by the machine, not the agent: this FFmpeg build has no ASS filter (`media.captions_unavailable`; before `pnpm fonts:fetch` it was `media.font_missing`). Timeline and caption checks pass for every run.
- \* Codex G3 renders the chart with its own Python and ffmpeg in the work directory, imports the file and checks frames; the numbers are right, but the HTML source never reaches the canvas, so the `render_succeeded` check fails. The baseline used the render provider. The code-render guide now says why the provider is preferred; Codex still chose its own tools in two reruns. DeepSeek E1 uses the provider and links the source node.
- Human review of G1–G5, S1, S2 and Q1: every run delivered to canvas nodes, kept facts it could not verify out of G1, cited real sources in G2, stated what it could not check (a flip on a flat-colour image), and in Q1 kept the user's model and parameters. No regression found.
- DeepSeek now uses its own subagents in G5 (`subagent` ×5) instead of dispatching work items, and needs far fewer calls in G2 and G3. Codex calls rose mainly from `guide` reads (1–3 per scenario).
- Always-loaded instructions are 66% smaller (core text 346 words plus the environment line).

Fixes found by the evaluation and applied before the final run:

1. zsh writes here-documents to `$TMPPREFIX` (default `/tmp/zsh`), not `$TMPDIR`, and the sandbox blocks `/tmp`; Codex also does not pass `TMPPREFIX` to its shell. `prepareSandbox` now sets it and the Codex adapter passes it through `shell_environment_policy.set`. Every baseline heredoc failed; the final reruns had none.
2. The script guide claimed a ScriptDoc `version` field that `script.replace` rejects, and gave no `script.patch` op shape; the timeline guide gave no text track shape. Both guides now show exact, schema-checked examples.
3. The project roots of the first run were inside the data directory, which drops agents to the read-only fallback; the runner now uses a sibling `-projects` directory and aborts on a `sandbox_read_only` notice.

Acceptance: one regression under the strict rule. Codex G3 passed its automatic checks in E0 and fails `render_succeeded` in E1, because it renders privately (above); the video itself is correct. Every other scenario is unchanged or better, G1–G5 otherwise pass human review for both agents, and instruction size drops by 66%. The maintainer reviewed the results and accepted private rendering for a request that asks for local code rendering (2026-11-03).

## Implementation split

Claude wrote the contract seam first: `GuideTopic` and the `guide.get` method spec, the gateway handler, and the instructions module skeleton (`getGuide`, `agentInstructions`, `turnPrompt`). Workers then run in parallel, split by directory.

| Step | Owner | Scope | Depends on |
|---|---|---|---|
| E | Codex worker | evaluation runner and scenarios in `apps/web/agent-eval/` (§7) | contract seam |
| E0 | Claude (approved 2026-11-03) | baseline evaluation, Codex and DeepSeek, before any instruction change lands | E |
| P1 | Codex worker | `packages/workbench/core/src/instructions/` (core text, guides, environment line, workspace block, turn block), `vis guide [topic]`, MCP exposure, guide hints in `canvas.apply` errors; switch the Codex and DeepSeek `prompt.ts` to the shared module | contract seam |
| P2 | Codex worker | English `summary` / `description` for agent-callable methods in `packages/protocol/src/methods.ts`; remove `toolLabel`; list duplicated detail that P1's guides must carry (coordinate through Claude) | contract seam |
| C1 | Codex worker | dsh overlay (§5.1), Codex web search (§5.2), credential separation in `buildSandboxPolicy` (§5.3) | — |
| R | Claude | review and merge each step after E0; wording pass on core text and guides with the maintainer; READMEs, 0005 notes | E0, P1, P2, C1 |
| E1 | Claude | evaluation after the change; fix regressions | R |

Each step runs `pnpm check`, `pnpm build` and two e2e rounds before merging.

## 8. Deferred: Claude Code

The maintainer deferred Claude on 2026-11-03. The plan below stays here so a later RFC can start from it.

Claude moves to the same model as Codex and dsh:

- **vis via MCP.** Pass `mcpServers: { vis: { command, args, env: { VIS_SOCKET, VIS_AGENT_TOKEN } } }`, like Codex. The token is no longer in the Claude process environment, only in the MCP server's. `vis` stays on `PATH` for scripts, but the instructions use the MCP tools.
- **Outer isolation on macOS.** `spawnClaudeCodeProcess` starts Claude Code under `sandbox-exec` with the profile from `buildSandboxPolicy(…, 'claude')`. The runtime home is `~/.claude` plus `~/.claude.json*` (Claude writes both). Environment filtering follows `prepareSandbox`.
- **Tools.** Use Claude Code's default tool set (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`, …), with no `tools` / `allowedTools` restriction beyond what approvals decide. `settingSources: []` stays, so the user's own `CLAUDE.md`, settings and skills do not leak into project sessions (matches the skills non-goal).
- **Approvals.** Replace `permissionMode: 'dontAsk'` with a `canUseTool` callback that maps to the existing approval flow (0015): vis MCP calls are auto-accepted as in the other adapters, the session's `auto` mode auto-approves commands and file writes whose canonical paths stay inside the work directory or project directory (`auto-approval.ts`), and everything else becomes an approval card. Claude Code's own sandbox setting stays off; the outer isolation is the boundary, as with Codex and dsh.
- **Without isolation.** On Windows, Claude runs with full tools and approvals, the same as Codex and dsh under 0022. Where isolation is unavailable on macOS (no `sandbox-exec`, missing certificates), Claude falls back to today's restricted mode (read-only tools plus vis), the same fallback the other adapters use.

**Spike first (S0): Claude login inside the isolation.** On macOS, Claude Code keeps its login in the Keychain. Our profile denies `securityd` so agents cannot read provider keys, and it cannot allow one Keychain item but not another. S0 checks, with the maintainer's own login and nothing printed, whether Claude Code inside the profile:

1. starts and completes a turn using its existing login (for example from a credentials file or a cached token), or
2. needs a token passed through the environment, such as `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

If (2), the token is stored by the app in the system credential store under `vis-creative.agent` / `claude` (never in a file, database or log), read by studiod at launch and passed only to the Claude process environment. That is the same exposure Codex has to `~/.codex/auth.json`: an agent may read its own credential, never another agent's or a provider key. If neither works, Claude stays in restricted mode on macOS and this RFC records why. S0 comes first in that RFC.


## Open questions

1. Should guides also be offered to the user, for example as a "how agents work here" page? Not in this RFC.

## Implementation notes (2026-11-03)

**Instructions (P1, plus review fixes).** The shared core is 346 English words. Measured as runtime strings without a work item, the always-loaded instructions went from 7,868 to 2,678 characters for Codex (−66%) and from 7,987 to 2,678 for DeepSeek (−66.5%); the old text was mostly Chinese, so the token reduction is at least as large. Every rule of the old Codex prompt was mapped to the core, one guide, or the tool schema (the exhaustive script field list now lives only in the zod schema). Review fixes: the dsh background-job note moved out of the shared core into the DeepSeek wrapper; the session title limit reads "12 Chinese characters or about 4 English words"; guides write `{{asset:<id>}}` and `{{ref:<nodeId>}}` literally, since they reach the agent as tool results, while the always-loaded text must not contain double braces because the dsh persona suffix is templated (tested). `canvas.apply` errors for invalid script or timeline ops end with `See guide "script"` / `See guide "timeline"`. The remaining CLI help lines are English.

**Tool descriptions (P2).** 31 agent-callable methods and three schema descriptions are English; UI-only methods keep Chinese summaries. `toolLabel` was removed. The UI keeps its own tool-name dictionary, so Chinese UI labels are unchanged. Still Chinese and agent-visible: provider parameter descriptions in `packages/generation` (Ark, Mock). They are also shown in the UI, so translating them needs i18n of provider schemas; left as a follow-up.

**Capabilities (C1).** dsh 0.2.1-rc.2: the five entries exist in the installed base and need no extra config. Subagent, workflow and job calls arrive over ACP as ordinary `tool_call`s; child sessions are not flattened into the parent transcript, so the UI shows the subagent call and its result, not the child's steps. Credential separation denies `~/.claude`, `~/.claude.json` and existing `~/.claude.json.*` files by path, and future backups with `(require-all (subpath <home>) (regex #"/[.]claude[.]json[.][^/]*$"))`. A first version escaped the home path into the regex and failed to load for homes containing `.` or `+`; the fixed regex avoids that and also denies same-named files deeper under home, which is acceptable. Verified with `sandbox-exec` on a fake home `john.doe+test`.

**Evaluation runner (E).** `apps/web/agent-eval/`, a plain Node entry (`pnpm --filter @vis/web agent-eval`). It allows only the built-in `mock` and `render` providers (render is always present and G3 needs it). **Q1 is `review`**: Mock and render are exempt from the daily paid-agent quota (`packages/generation/src/quota.ts`), so `quota_exceeded` cannot be triggered without a paid provider; testing the stop behaviour needs a separate, approved quota-injection mechanism. Native tool activity (web search, file edits, subagents) is not always visible in transcripts, and token usage is not exposed, so those checks are `review`.

**Validation under load.** With four workers running full suites at once the machine reached a load of ~42 and unrelated ffmpeg and browser tests timed out. Workers switched to scoped validation; the coordinator ran the full check and two e2e rounds serially on the merged branch.
