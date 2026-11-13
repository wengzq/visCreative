# 0041 · ACP Agents: MiniMax Code and CodeBuddy

Status: done (steps 0 and a–c implemented; step d accepted by the maintainer in real sessions on 2026-11-10)

Date: 2026-11-09

Builds on [0005](0005-agent-adapters-and-mcp.md) (adapters and the vis MCP server), [0026](0026-agent-instructions.md) (shared instructions with per-Agent overlays) and [0028](0028-agent-and-provider-registries.md) (Agent registry; [adding an Agent](../contributing/adding-an-agent.md)).

## Background

The maintainer wants more Agents in the list, starting with MiniMax Code, Doubao Work and WorkBuddy (2026-11-09). RFC 0028 made this a matter of one adapter package and one registration. The cost now lies in the adapter: Codex is 555 lines over `codex app-server`, DeepSeek 533 over ACP, Claude 267 over the SDK.

What each candidate exposes was established on 2026-11-09 by reading published packages and source. **None of the three CLIs has been run.** Each item below says where it comes from.

**MiniMax Code** (`mcode`, MIT, source at `github.com/MiniMax-AI/minimax-code` read at v0.7.2; npm `@minimax-ai/code` is at 0.7.6):
- `mcode acp` is an ACP server on stdio, with stdout carrying protocol messages only (`packages/tui/src/acp/agent.ts`). `initialize` advertises `loadSession`, `sessionCapabilities: { list, fork, resume, close }`, `mcpCapabilities: { http, sse }` and image prompts. It handles `session/cancel` and sends `session/request_permission`.
- `session/set_config_option` takes `permissionMode`, `model` and `thinkingEffort` (`acp/control-state.ts`). The permission modes are ask, auto, full and off.
- Tools run inside the `mcode` process. The architecture note reads "TUI / exec / ACP → CliService → local Applications → … local tools". The only detached spawns are the self-updater and opening external URLs.
- Data and credentials live in `~/.minimax`, or `~/.minimax-<profile>` with a profile. The legacy location is `~/.mavis`. `private-config-file.ts` notes that these "can contain plaintext credentials". The installer puts binaries in `~/.minimax-code`. A bring-your-own model key is read from `MCODE_PROVIDER_API_KEY`.
- No system-prompt channel in ACP. Project instructions are read from `AGENTS.md` in the cwd (`local-runtime/src/project/instructions.ts`) and global ones from `~/.minimax/AGENTS.md`.
- Headless `mcode exec` has no ask mode: pending approvals fail the run. It does not fit our approval model, so this RFC does not use it.

**CodeBuddy Code** (Tencent, `@tencent-ai/codebuddy-code` 2.181.0, proprietary, binaries `codebuddy` / `cbc`). WorkBuddy is Tencent's desktop agent built on the same engine and publishes its CLI and SDK docs under `workbuddy.ai/docs/cli`.
- `codebuddy --acp` (`--acp-transport stdio`, the default) is an ACP server. The bundled `dist/codebuddy-headless.js` advertises `loadSession`, MCP over http/sse and image prompts, and implements `session/resume`, `session/cancel` and `session/request_permission`.
- Flags documented for the CLI: `--permission-mode` (`default`, `acceptEdits`, `auto`, `dontAsk`, `plan`, `bypassPermissions`), `--append-system-prompt`, `--model`, `--mcp-config`, `--strict-mcp-config`. Whether they apply under `--acp` is unverified.
- State lives in `~/.codebuddy` (overridable with `CODEBUDDY_CONFIG_DIR`) and `~/.codebuddy.json`. Credentials come from login or from `CODEBUDDY_API_KEY` / `CODEBUDDY_AUTH_TOKEN`.
- The package also ships `cbc-prewarm` and `codebuddy-broker.js`. Whether `--acp` hands work to a long-lived process outside the tree we spawn is unknown, and it decides whether our sandbox applies.

<!-- privacy-allow: public npm package scope of the Doubao CLI -->
**Doubao CLI** (`@bytedance/doubao-cli` 2.31.3: an npm launcher for a closed native bundle; inspected statically, macOS arm64 archive, SHA-256 verified against the launcher's manifest):
- Arguments are `-p <prompt>`, `-C <dir>`, `--resume`, `--list`, `--model`, `--effort`, `--permission-mode` and `--dangerously-bypass-approvals-and-sandbox`. There is no ACP, no JSON-RPC and no way to inject an MCP server. The bundle contains a `stream-json` output path, but no documented flag selects it.
- In `-p` mode a pending approval ends the run with `interaction_required`.
- Its README says work runs in "a shared service … managed automatically". Tools then execute in a daemon we do not spawn, so the Seatbelt policy and environment filter (AGENTS.md, security rules) would not cover them.

## Goals

1. A shared ACP runtime in `workbench-core`, so an ACP Agent is a descriptor, launch arguments, a sandbox profile and a few hooks.
2. DeepSeek ported onto it with no behavior change.
3. MiniMax Code and CodeBuddy adapters on it, with full approvals, resume, interrupt, models and effort where the Agent offers them.

## Out of scope

- Doubao, until it offers a structured protocol with interactive approvals and either runs tools in the process tree we start or documents an isolation we can rely on. Revisit when its CLI changes. The notes above are the starting point.
- The WorkBuddy desktop app and its remote-task features. We integrate the CodeBuddy Code CLI.
- Headless or print modes for any Agent. Without interactive approvals they would force a bypass flag, which the approval rules forbid.
- Real model turns before step d (see Cost).

## Design

### 1. Shared ACP runtime

Move the protocol half of `packages/workbench/deepseek/src/adapter.ts` into `packages/workbench/core/src/acp/`. That half covers the per-turn process, handshake, new or resume session, the admission rule, `session/update` translation, permission requests, close-then-kill, `terminateTurn`, `dispose` and the model probe. The adapter supplies a profile:

```ts
type AcpAgentProfile = {
  kind: AgentKind
  /** Used in error messages and notices ("MiniMax Code startup failed: …"). */
  label: string
  sandbox: SandboxAgent
  /** Resolve the executable and the per-turn arguments; called after the sandbox is prepared. */
  launch(prepared: { cwd: string; sandbox: PreparedSandbox; work?: WorkContext; skillsPath?: string }): { command: string; args: string[] }
  /** How shared instructions reach the Agent (§3). */
  instructions: 'launch' | 'prompt'
  /** Config option ids, when the Agent offers them through session/set_config_option. */
  config: { model?: string; effort?: string; permission?: { id: string; ask: string } }
  /** Map a native tool to an approval kind and complete write paths; unknown tools stay 'other' and are never auto-approved. */
  classifyTool(tool: AcpToolCall): { kind: 'execute' | 'edit' | 'fetch' | 'read' | 'other'; paths?: string[]; autoApprovalBlocked?: boolean }
  /** Item id prefix in the transcript; DeepSeek keeps 'ds'. */
  itemPrefix: string
  resume: 'session/resume' | 'session/load'
}
```

The DeepSeek-specific pieces stay in its package: the dsh overlay, recovering tool kinds from tool titles, `resolveDsh`, and the `reasoning_effort` default. The port is a refactor. Every existing DeepSeek adapter test passes unchanged, apart from import paths, and the overlay policy strings stay byte-identical.

### 2. Turn lifecycle and approvals

Unchanged from DeepSeek (0005, 0004):

- One Agent process per turn, started under the Seatbelt policy on macOS, with the ACP session id as `resumeId`. A resume that fails with an RPC error starts a new session.
- The admission rule still applies: a rejection within the admission window means not received, and a process exit means `unknown`.
- Interrupting sends `session/cancel`, then kills after the grace period.
- Before prompting, the runtime sets the Agent's permission option to its asking mode: MiniMax `permissionMode = default` ("Ask"), CodeBuddy `--permission-mode default` and config `mode = default` ("Always Ask"). Every native command and write then reaches `session/request_permission` → `requestApproval`, where the session's auto mode and path rules (0015) decide. The runtime never chooses auto, full, `bypassPermissions` or `dontAsk`.
- vis MCP tool confirmations are accepted automatically, as in every session.
- **Read-only fallback.** When isolation cannot be prepared, dsh disables its tools through the overlay. These Agents have no overlay, so the runtime denies every mutating permission request. That is safe only if every mutating tool really goes through `request_permission` in ask mode. Step 0 checks this; an Agent that fails the check reports itself unavailable while the fallback is in effect.

### 3. Instructions

Shared instructions (0026, about 11 KB) need a channel that is always loaded.

- **CodeBuddy:** `--append-system-prompt` at launch, if step 0 confirms it applies under `--acp`. Otherwise use the prompt channel below.
- **MiniMax Code:** ACP has no system-prompt field. Writing `AGENTS.md` into the cwd is rejected: `session.create` accepts an author-chosen `workDir`, and an author's own `AGENTS.md` must never be overwritten. The proposal is a leading text block in every `session/prompt`, ahead of `turnPrompt(input)`. That costs about 3k input tokens a turn, but the instructions survive context compaction and resume. It can be revisited if MiniMax adds a system-prompt channel. **Maintainer decision** (below).

Agent-specific notes go in the adapter's `prompt.ts`, as for DeepSeek.

### 4. Descriptors and isolation

| | MiniMax Code | CodeBuddy |
|---|---|---|
| `kind` | `minimax-code` | `codebuddy` |
| `label` | `MiniMax Code` | `CodeBuddy` (see decisions) |
| install command | `npm install -g @minimax-ai/code` | `npm install -g @tencent-ai/codebuddy-code` |
| `forbiddenPaths` | `~/.minimax`, `~/.mavis`, `~/.mavis-*` | `~/.codebuddy`, `~/.codebuddy.json`, `~/.codebuddy.json.*` |
| `runtimeDirectory` | `.minimax` | `.codebuddy` (`runtimeHomeVariable: CODEBUDDY_CONFIG_DIR`) |
| `envPassthrough` | `MCODE_PROVIDER_API_KEY` | `CODEBUDDY_API_KEY`, `CODEBUDDY_AUTH_TOKEN` |
| executable override | `VIS_MCODE_PATH`; also `~/.minimax-code/bin/mcode` | `VIS_CODEBUDDY_PATH`; `codebuddy`, then `cbc` |
| capabilities | resume, interrupt, models, effort, approvals | resume, interrupt, models, effort, approvals |
| config ids (step 0) | permission `permissionMode` = `default` ("Ask"); model `model`; effort `thinkingEffort` | permission `mode` = `default` ("Always Ask"); model `model`; effort `thought_level` |
| `session/close` | supported | not supported (`-32601`): skip it and stop the process |

- `~/.minimax-*` is not listed. The pattern would also match MiniMax's own install directory `~/.minimax-code`, and the sandbox exempts only the exact runtime directory. The runtime never passes a MiniMax profile, so profile directories are not used. Widening the deny list to cover them needs a per-Agent exemption list in `SandboxAgent` and is left as a follow-up.
- CodeBuddy documents `~/.codebuddy.json` in the home root, outside its runtime directory. In step 0, under Seatbelt, it wrote only inside `~/.codebuddy` and never tried that file. If a real turn needs it, add a `runtimeFiles` allowance to `SandboxAgent` rather than widening writes to home.
- The application never opens these paths. Availability probes check only for the executable, never for login state. A missing login surfaces as the Agent's own error in the transcript, as with dsh's missing key.

### 5. Models and effort

As for DeepSeek, `agentOptions` starts a probe process, reads the model config option from `session/new` and reads each choice through `session/set_config_option`. The ids are in the §4 table. Model values are opaque strings returned by the Agent (MiniMax `m:minimax:MiniMax-M3:v:thinking`; CodeBuddy `default-model`, `gpt-6.1-sol` and others), never parsed. CodeBuddy's list includes models billed at different credit rates; the picker shows the Agent's own names and descriptions.

## Cost and safety

- Tests use scripted ACP transports recorded from step 0 and never launch a real Agent.
- Step 0 starts the real CLIs but sends no `session/prompt`. `initialize`, `session/new`, `session/set_config_option` and `session/close` make no model calls. It still runs only with the maintainer's approval, the maintainer's own login, an isolated visCreative data directory, and the Seatbelt policy applied.
- Step d (real turns) needs separate approval per Agent, tight generation limits in `providers.json` and an isolated data directory, as for Claude Code.

## Steps

0. **Probe, with maintainer approval.** Install both CLIs and, for each, record an ACP transcript of `initialize` → `session/new` (with the vis MCP server) → `set_config_option` → `session/close`. Under the Seatbelt policy, observe the process tree (`ps -o pid,ppid,pgid`) for anything detached or reparented, and record file writes outside cwd and the runtime home. For CodeBuddy, confirm whether `--append-system-prompt`, `--permission-mode` and `--strict-mcp-config` apply under `--acp`. Output: fixtures under each adapter's test directory and a short findings note appended to this RFC. An Agent that runs tools outside its tree is dropped from this RFC.
1. **a. Shared ACP runtime, DeepSeek ported.** No behavior change. Independent of step 0 and can start now.
2. **b. MiniMax Code adapter**, after a and 0.
3. **c. CodeBuddy adapter**, after a and 0, in parallel with b.
4. **d. Real-Agent acceptance**, per Agent, with approval: a turn, a command approval, a file-write approval, interrupt, resume after restart, and a child work item reporting to its parent.

Each of a–c updates the [adding an Agent](../contributing/adding-an-agent.md) guide where the ACP route changes it, and both README roadmaps.

## Decisions (maintainer, 2026-11-09)

1. **MiniMax instructions channel:** a leading block on every turn.
2. **CodeBuddy label:** `CodeBuddy`, the CLI we actually launch.
3. **Step 0 approved:** install both CLIs on the maintainer's machine and run the no-prompt probe. Step a starts in parallel.

## Step 0 findings (2026-11-09)

The probe used the maintainer's own logins and the production `prepareSandbox` policy and filtered environment. A stub stdio MCP server named `vis` stood in for vis. It never sent `session/prompt`, so no model calls were made. Sanitized transcripts are kept for steps b and c as scripted-transport fixtures.

| | MiniMax Code 0.7.6 | CodeBuddy 2.181.0 |
|---|---|---|
| Starts under Seatbelt; `initialize`, `session/new`, `session/resume` | yes | yes |
| Writes outside cwd | `~/.minimax` only | `~/.codebuddy` only |
| Processes outside the spawned tree | none | none |
| Stub MCP server | not started by `session/new`: connections are lazy, so a real turn confirms it (step d) | started at `session/new` as a child in the same process group, and received `initialize` and `tools/list` |
| Exits on stdin EOF | yes, exit code 0 | no: killed after the grace period, as the runtime already does |
| Permission option | `permissionMode`: `default` (Ask), `auto`, `bypassPermissions`; scope is the process | `mode`: `default` (Always Ask), `acceptEdits`, `plan`, `auto` (an AI reviewer decides), `dontAsk`, `bypassPermissions`, `fullAccess` |
| Other config options | `model`, `thinkingEffort` (`default`, `low` … `max`); modes `default` and `plan` | `model`, `thought_level` (`disabled` … `max`, `enabled`), `sandbox` (CodeBuddy's own; leave `false`, ours applies), `multitask` |
| Vendor extensions | `mcode/*` methods advertised in `initialize._meta` | `_codebuddy.ai/command` and `_codebuddy.ai/modResidentInvalidate` notifications; ignore them |

Consequences for the design:
- The shared runtime treats `session/close` as optional: a `-32601` reply goes straight to stopping the process.
- Neither Agent runs anything outside the spawned tree at this stage, so both stay in scope.
- **Open for step d:**
  - whether CodeBuddy's "Always Ask … on first use of each tool" remembers a grant when we answer `allow_once`. If it does, every approval has to be per-call, or CodeBuddy's capability `approvals` is not met;
  - whether `--append-system-prompt` takes effect under `--acp`. Until confirmed, CodeBuddy uses the prompt instruction channel;
  - MiniMax's lazy MCP start under Seatbelt.

## Implementation notes (step a)

`createAcpRuntime` and `AcpAgentProfile` live in `packages/workbench/core/src/acp/` and are exported by `@vis/workbench-core`. DeepSeek keeps its public runtime options and constructor, overlay, executable resolver, tool-title recovery, complete write-path extraction, model-option helpers and `reasoning_effort` default. Its translator wrapper fixes the shared translator's prefix to `ds`; the overlay and Seatbelt policy are unchanged.

The profile follows §1 with these additions: `sessionFiles(prepared)` describes per-session files written before launch and removed after model probes; `prepared` includes `sessionId` as well as cwd, sandbox, work and skills. `processLabel` preserves native connection diagnostics, `permissionSummary` preserves the adapter's permission fallback text, `defaultEffort(option)` supplies the Agent's default rule, and optional `modelOption(choice, options, defaultModel)` retains Agent-specific catalog mapping. Tool classification also returns the native command's optional `cwd` and accepts ACP `delete` and `move` kinds, so mutating permissions retain their existing treatment. These details keep dsh semantics outside the shared protocol runtime. Probe directories are supplied through runtime option `probeDir`, without coupling core to an overlay location.

The `prompt` channel prepends shared instructions before `turnPrompt(input)` on every prompt, using the current work context and actual access/isolation state. An optional permission config must report its asking value before every prompt. In read-only fallback, the runtime permits only verified non-mutating vis confirmations and proven `read` permissions; unknown tools and `fetch` are denied before approval because their effects are not proven read-only. A profile may set `readOnlyEnforcedByAgent: true` only when the Agent itself disables mutations: DeepSeek's overlay disables writes, edits and risky tools with approval set to never, so it retains the previous `!mutating || permissionsExpanded` gate and its tests remain unchanged. MiniMax leaves this option unset. Expanded-mode approvals are unchanged. Session close is best-effort: unsupported-method and other errors proceed to process cleanup, and processes ignoring stdin EOF are stopped after the grace period. All shared-runtime tests use an in-memory scripted ACP transport and launch no real Agent.

Permission setup fails closed: the session must expose the declared option, an update must confirm its asking value before prompting, and an already-asking option skips the update.

The classification hook also supplies optional `visTool: true` when native metadata proves the tool belongs to the vis MCP server. The runtime no longer guesses identity from display titles, which MiniMax can derive from input descriptions. DeepSeek preserves its existing title-based recognition in its own profile. Mutating classifications still pass through approval and read-only fallback rules even when `visTool` is true.

## As-built: restart resume and inactivity safeguard (2026-11-11)

For a resumed turn with a model config option, no author-selected model and no cached default, startup now runs `initialize` → probe `session/new` (no MCP servers) → probe `session/close` → the profile's resume method → configuration → `session/prompt`. Other turns skip the default probe. Resumed model values are not overlay defaults, and model IDs remain opaque. Creating or closing another session after resume can switch the Agent's active session and leave CodeBuddy's prompt without updates or a response. Both `session/load` and `session/resume`, including MiniMax's profile, use this ordering.

The probe must precede the resume attempt, before its success or returned config options are known. A missing model option on an otherwise model-capable profile therefore cannot suppress that probe. If the probe returns no default, startup still resumes: a resumed session without a model option needs no model update, while a resumed session with a model option still fails with `did not return a default model`, as before. If resume returns an RPC error, the existing fallback creates the turn's new session, takes its default directly and does not probe again; a cached default or explicit model skips the preliminary probe entirely.

After admission, ten minutes without a session update, an Agent-to-client request or a prompt response fails the turn with an `agent_inactive` transcript notice and immediately kills the owned process tree, using the same cleanup path as `terminateTurn`. `inactivityTimeoutMs` overrides this interval for tests. Activity resets the interval; pending user approvals suspend it, including overlapping requests, and the final decision starts a full interval. This bounds silent model calls and tool executions as well as lost prompt streams; it is an inactivity limit, not a total turn deadline. Normal completion, interruption and disposal clear the timer. Fake-only regression tests cover ordering, default alignment, caching, resume fallback, silence, pending permissions and activity resets.

## Implementation notes (step b)

`@vis/agent-minimax` implements MiniMax Code on the shared runtime and is registered in studiod with an executable-only availability probe. The descriptor uses kind `minimax-code`, label `MiniMax Code`, homepage `https://github.com/MiniMax-AI/minimax-code`, the npm install hint in §4 and an original 24×24 stroke icon. It passes only `MCODE_PROVIDER_API_KEY`, uses runtime directory `.minimax` without a home-variable override, and denies `~/.minimax`, `~/.mavis` and `~/.mavis-*` to other Agents. It deliberately does not deny `~/.minimax-*`, which would also block the official install directory.

Executable lookup is explicit `mcodePath` / `VIS_MCODE_PATH`, then `mcode` on PATH, then `~/.minimax-code/bin/mcode`; an invalid explicit override fails without falling back. The core executable helper resolves Windows npm shims without executing them. The only native argument is `acp`. Shared instructions are prepended to every prompt, including resumed turns. The profile uses `model`, `thinkingEffort` and `permissionMode = default` (Ask), `session/resume`, `session/close`, transcript prefix `mm`, and effort `default` when offered (otherwise the Agent's current effort). Opaque model ids and labels come directly from config options.

Classification follows the native `name` field emitted by MiniMax's `updates.ts` and `interactions.ts`, checked against the corresponding native tool schemas. Its ACP `kind` is a substring heuristic, and permission titles may come from `rawInput.description`, so neither proves a native tool's identity. The coordinator-approved shared-runtime extension `classification.visTool` lets each profile establish vis identity: MiniMax uses the native name, while DeepSeek retains its previous title regex unchanged. No overlay or Agent-specific instruction note was needed.

| Native identity | Classification → approval | Complete paths / automatic approval |
|---|---|---|
| `bash` | `execute` → command | cwd is the session workspace, as specified by the native tool; no inferred file targets |
| `write` | `edit` → file write | exactly `rawInput.path`, resolved lexically against cwd like the native tool; home aliases remain manual |
| `edit` | `edit` → file write | exactly `rawInput.file_path`, resolved lexically against cwd like the native tool; home aliases remain manual |
| `web_fetch` | `fetch` → network | no write paths |
| `read`, `grep`, `glob` | `read` → other | no write paths |
| native name matching `mcp__vis__[A-Za-z0-9_]+` | `other`, `visTool: true` | vis confirmation is accepted once; gateway permissions still apply |
| unknown or absent native name, including misleading title/kind | `other` → other | no paths, `autoApprovalBlocked: true`, never marked as vis |

ACP previews and `locations` do not establish complete write targets. Missing or malformed native path input, or a leading home alias (`~`), leaves paths absent, so the shared automatic file-approval rule cannot accept the write. Lexical resolution matches MiniMax's `resolveLocalCandidatePath` helper before the core checks canonical scope. The asking permission mode is verified before each prompt; missing, rejected, ignored or unconfirmed configuration fails startup. In the read-only fallback, native command, write, fetch and unknown-tool permissions are denied before approval; verified non-mutating vis confirmations and native read tools may proceed. The shared profile's optional `readOnlyEnforcedByAgent` exception is reserved for Agents that disable mutating tools themselves, such as dsh's overlay; MiniMax does not opt in. Vendor notifications are ignored and unsupported requests receive `-32601`.

Tests use selected sanitized response payloads from the 2026-11-09 production-Seatbelt no-prompt handshake (MiniMax Code 0.7.6), scripted in-memory transports and fake executable/home paths. Neither real CLI nor any credential directory was opened. These tests establish adapter behavior, not that MiniMax's native permission policy asks for every mutation.

Step d still requires separate maintainer approval, an isolated data directory and tight generation limits. Confirm a real turn and the lazy vis MCP server start under Seatbelt, per-call native command and file-write approvals (including repeated `allow_once` and the read-only fallback), interruption and process-tree cleanup, persistence/resume after restart, model and effort selection, and a dispatched child work item reporting to its parent. Native read/write paths and permission updates should be checked against the actual installed release; profile credential directories remain the §4 follow-up.

## Implementation notes (step c)

`@vis/agent-codebuddy` implements CodeBuddy on the shared ACP runtime, with a descriptor and executable-only availability probe registered in studiod. It resolves an explicit runtime path or `VIS_CODEBUDDY_PATH`, then `codebuddy` on PATH, then `cbc` on PATH. An invalid override fails without silently falling back. No adapter-specific prompt or launch file is needed. No CodeBuddy-specific changes were needed in the shared runtime.

The launch is `codebuddy --acp --permission-mode default`, with no permission bypass or append-system-prompt flag. The profile uses `instructions: 'prompt'`, config ids `model`, `thought_level`, and `mode = default`, resume method `session/resume`, and transcript prefix `cb`. Missing permission configuration or an update that fails to confirm `default` rejects startup before prompting. The Agent's reported current effort is retained when the author has not selected one; model ids are opaque and all names, descriptions, credit rates and ordering pass through unchanged. CodeBuddy's native `sandbox` option is never changed.

Isolation uses `.codebuddy` and `CODEBUDDY_CONFIG_DIR`, with only `CODEBUDDY_API_KEY` and `CODEBUDDY_AUTH_TOKEN` added to the filtered environment. Its descriptor protects `~/.codebuddy`, `~/.codebuddy.json`, and `~/.codebuddy.json.*` from other Agents. Sandbox tests use a fake home and fake backup file, never saved credentials. Scripted adapter tests reproduce unsupported `session/close` (`-32601`) and a process ignoring stdin EOF, including escalation when SIGTERM is ignored. Unknown notifications are ignored and unknown requests receive `-32601`. CodeBuddy leaves `readOnlyEnforcedByAgent` unset: read-only fallback permits only source-confirmed read tools and verified nonmutating vis confirmations; fetch, mutating and unproven tools are denied before asking the author.

Tool mapping was established by reading, without executing, the extracted `@tencent-ai/codebuddy-code` 2.181.0 `dist/codebuddy-headless.js`: `AcpUtils.toolInfoFromToolUse`, native tool-name constants, and streaming argument updates. Initial streaming calls can report `kind: 'other'`, an empty raw input, and the native name in `_meta['codebuddy.ai/toolName']`; later updates supply `rawInput`. Permission requests may contain only a tool id and arguments, so the shared runtime recovers prior update metadata. Formatted titles such as command text and an edit title containing a path are never parsed for targets.

| Native kind / ACP fallback | Approval category | Complete write paths / automatic approval |
| --- | --- | --- |
| `execute`; `Bash`, `PowerShell`, `BashOutput`, `KillShell` | command | No paths or cwd inferred: native shells can change directory and ACP does not prove the current directory, so session auto mode cannot automatically grant these commands |
| `edit`; `Write`, `Edit`, `MultiEdit` | file_write | Only these confirmed single-file native tools, identified by native metadata, expose their nonempty `rawInput.file_path`; missing/invalid input or conflicting locations omit paths; relative paths remain ineligible for automatic approval |
| `delete`, `move` | file_write | No paths inferred; author approval required |
| `fetch`; `WebFetch`, `WebSearch` | network | No paths; author approval required |
| `read`, `search`; `Read`, `Glob`, `Grep`, `NotebookRead` | other | No paths; search is treated as read |
| No recognized ACP kind or native name, including `NotebookEdit`, `Agent`, `REPL` | other | No paths or cwd; never automatically approved |
| Native `codebuddy.ai/toolName = mcp__vis__*` confirmations | shared vis tool rule | Automatically accept `allow_once`; gateway permissions still apply |
| Native `codebuddy.ai/toolName = DeferExecuteTool` with `rawInput.toolName = mcp__vis__*` | shared vis tool rule | Same as above (added in step d); any other wrapped target, such as `ShareLink`, stays other and asks |

A recognized native tool name takes precedence over the reported ACP kind, so native commands and writes cannot be treated as read-only when ACP reports `read`, `search` or `fetch`. Only unknown or absent native names fall back to the reported ACP kind, with `search` mapped to `read`. Native classification uses only `codebuddy.ai/toolName` metadata; display titles never prove a native tool or a read-only classification. A private `isVisTool` helper returns `visTool: true` only for `_meta['codebuddy.ai/toolName']` matching `mcp__vis__*`; display titles and raw arguments cannot grant this flag. The shared runtime uses this profile flag for nonmutating vis confirmations instead of interpreting display titles. Source evidence: `AcpUtils.convertInputItemContentToAcp` sets this metadata from the function call's native `ec.name`; streaming `tool_call_pending` uses the native `ef` name, and `handleToolApproval` places the native `eC` name in request-permission metadata `eQ`. MCP tool names use the `mcp__<server>__<tool>` namespace. Tests cover descriptive vis titles and spoofed titles from other tools. The native `NotebookRead` implementation validates `notebook_path`, reads and parses the file, and formats cells without executing them, so it is also classified as read. `LS` appears in native-name constants, but no implementation was established in the inspected bundle; it stays other until verified. Descriptive ACP locations alone never prove complete write targets, and the adapter never interprets shell command strings to infer cwd or paths. CodeBuddy commands deliberately require author approval in expanded mode and never auto-approve because ACP provides no provable current working directory.

The package includes the sanitized 2026-11-09 no-prompt handshake recording for realistic initialize/new/resume/close responses and the full model/effort catalog. That recording contains no `set_config_option` exchange; tests synthesize updated responses using its complete config-option shape. All transports and executable lookup fixtures are fake, and no real CodeBuddy or MiniMax binary was launched during implementation.

Step d still requires maintainer approval and isolated real-Agent acceptance:

- Verify whether answering `allow_once` under “Always Ask” prompts again for the same native tool, rather than remembering the first grant. Confirm every mutation reaches the permission bridge, including in the read-only fallback.
- Confirm `--append-system-prompt` applies under `--acp` before considering a launch instruction channel, and whether `--strict-mcp-config` is needed and honored.
- Capture real `set_config_option` responses for permission, model and effort, and verify model selection does not relax asking mode.
- Verify actual tool update/permission metadata, complete paths for native file writes, and whether command cwd can ever be proven. `NotebookEdit`, delegated/subagent tools, REPL, custom tools, and any additional mutation surface remain conservatively unclassified without target proofs.
- Verify vis MCP calls under the sandbox, interruption and cleanup of MCP/tool descendants, resume after daemon restart, a child work item reporting to its parent, and whether a real turn needs the home-root `.codebuddy.json` runtime-file allowance. The no-prompt process-tree findings do not establish real-turn behavior.

## Step d findings (2026-11-09, partial)

Run with the RFC 0026 harness (`apps/web/agent-eval`, extended to accept `minimax-code` and `codebuddy`): isolated data directory under `/tmp`, Mock providers with daily limits of 1, session approval mode `auto`, remaining approvals denied and recorded. Versions: mcode 0.7.6, codebuddy 2.181.0. Scenarios G1 (canvas write), G4 (local script), W4 (two turns), R1 (child done report).

Fixed during step d:

- **Model probe aborted on one refused choice.** mcode lists four model choices but refuses `m:minimax:MiniMax-M3.1-Flash:v:` with `-32603 Invalid model reasoning`, in any order. The shared runtime failed the whole model list, so no MiniMax session could start. It now leaves out choices the Agent refuses with an error reply, so they cannot be selected; a closed connection or timeout still fails, and refusing every choice fails with the Agent's last error.
- **CodeBuddy calls MCP tools through `DeferExecuteTool`.** MCP tools load lazily: the model finds them with `ToolSearch` and invokes them through the wrapper, whose permission request names the wrapper in metadata and the target in `rawInput.toolName`. CodeBuddy documents that the target's own permission checks apply. The profile now sets `visTool` only when the metadata names the wrapper and the target matches `mcp__vis__*`.

Observed after the fixes (CodeBuddy):

- G1 completed: one canvas text node through vis MCP under Seatbelt, no approvals needed; content quality is for human review.
- R1 completed: the child wrote a text node, called `work.report` done with `refs.nodeIds`, and stayed idle. The harness check fails only because the node's purpose is `working`, which the canvas guide prescribes for child workspaces; the adapter path works.
- G4: the native `Write` inside the work directory was auto-approved with its complete path. The `Bash` command then required approval as designed (no provable cwd) and the harness denied it.
- W4: CodeBuddy asked to `Read` a guessed file under its own install directory, which needs approval outside the work directory; the harness denied it.
- **A denied approval ends the CodeBuddy turn** (G4, W4 both ended `interrupted` right after the denial) instead of letting the model continue. With CodeBuddy, denying is effectively stopping the turn; the author must approve to proceed.
- Vis tool argument errors (for example `nodeIds` as a string) come back as tool errors and the model retries successfully.

Still open:

- MiniMax Code real turns: blocked by the account balance (`insufficient balance (1008)`), reported correctly as an `agent_error` notice. Rerun G1, G4, W4 and R1 once funded.
- CodeBuddy: W4's second turn (resume within a session) and a G4 run with the command approved, both needing an author approval in the UI rather than the harness; interruption and cleanup of MCP descendants; resume after a daemon restart; whether `allow_once` is remembered under "Always Ask"; `--append-system-prompt` under `--acp`.


## Step d acceptance (2026-11-10)

The maintainer used MiniMax Code and CodeBuddy in real sessions in the app and reported both working, which completes step d. The finer checks listed above as still open were not recorded one by one; they were recorded by hand on 2026-11-11 (below). The `apps/web/agent-eval` runner supports only Codex and DeepSeek, so it cannot run these scenarios for MiniMax Code or CodeBuddy.

## Manual checks (maintainer, 2026-11-11)

These are manual results. The `apps/web/agent-eval` harness was not run.

| Agent | Check | Result |
|---|---|---|
| CodeBuddy | Stop and cleanup | Passed. After Stop, no CodeBuddy, MCP, shell or `sleep` processes remained. |
| CodeBuddy | Resume after a daemon restart | **Failed** on the first attempt (a retry after Stop recovered; see the defect below). After the fix, a retest passed: following a studiod restart, the original session answered correctly on the first attempt, with no Stop or retry. |
| CodeBuddy | `allow_once` under "Always Ask" | Passed. The second command asked for approval again. |
| CodeBuddy | Instructions on a turn with no tool calls | Delivered, as designed. CodeBuddy has no `--append-system-prompt` at launch; it receives the instructions as a text block on each prompt (`instructions: 'prompt'`). The block was present in the turn, which made no tool calls. Asked which interfaces add and link a text node, it named `canvas_apply` but also `entity.create` / `entity.link`, which are library-setting interfaces. That is expected: the instructions name only `canvas_get` / `canvas_apply`, and the node and link operations are in the `canvas` guide, which needs a tool call. Whether `--append-system-prompt` works under `--acp` remains unprobed and matters only if the launch channel is reconsidered. |
| MiniMax Code | G1, advertisement copy | Accepted by the tester. |
| MiniMax Code | G4, local image-processing script | Passed on a second run. The first used an already square attachment, so nothing was cropped. The second cropped an existing 1672×941 canvas image to 941×941 with a local script, delivered it as a new node and left the original asset and node revisions unchanged. |
| MiniMax Code | W4, edit the same text node | Passed. The same node was updated with no protection refusal and no duplicate. |
| MiniMax Code | R1, child delivery and reporting | Passed per the parent side: delivery reference returned, review completed, child archived, no extra work items. |

**Defect found:** on the first resumed turn after a studiod restart, the runtime had no cached default model. It opened a temporary `session/new` to read one between `session/load` and `session/prompt`, then closed it. CodeBuddy switched to that temporary session. The provider answered (HTTP 200, `finish_reason=stop`), but CodeBuddy sent no updates and never answered `session/prompt`. With no inactivity limit after admission, the turn stayed running. Fixed the same day: see [As-built: restart resume and inactivity safeguard](#as-built-restart-resume-and-inactivity-safeguard-2026-11-11). Resume after a daemon restart still needs a manual retest with a real CodeBuddy session.
