# Adding an Agent

An Agent adapter translates a local Agent's protocol into visCreative sessions, transcript events and approvals. Start with [AGENTS.md](../../AGENTS.md); [RFC 0028 §1](../rfc/0028-agent-and-provider-registries.md#1-agent-registry) explains the registry, and [RFC 0005](../rfc/0005-agent-adapters-and-mcp.md) explains the runtime boundary.

## 1. Prepare and choose a reference

From the repository root, use Node 24 or newer and install the workspace dependencies:

```sh
npx --yes pnpm@10.34.9 install
```

Read `packages/workbench/core/src/runtime-port.ts` and one existing adapter:

| Directory | Integration |
| --- | --- |
| `packages/workbench/codex/src/` | JSON-RPC through `codex app-server`; `adapter.ts`, `translate.ts`, `prompt.ts` |
| `packages/workbench/deepseek/src/` | ACP through dsh, with an overlay in `overlay.ts` |
| `packages/workbench/claude/src/` | Injected Claude SDK `query`; currently restricted tools and no interactive approvals |

For an ACP Agent, start with the shared runtime in `packages/workbench/core/src/acp/` and `createAcpRuntime`, exported by `@vis/workbench-core`. Supply an `AcpAgentProfile` for launch arguments and files, sandbox metadata, instruction channel, config option ids, native tool classification, transcript prefix, resume method and default effort. DeepSeek's `adapter.ts` is a profile example; keep Agent-specific overlays, tool argument interpretation and model defaults in the adapter package. The shared runtime owns process lifecycle, admission, approvals, translation and model probing. Use the `prompt` instruction channel when launch cannot carry always-loaded instructions: it prepends shared instructions on every turn, including resumed turns, and denies mutating permissions in the read-only fallback.

For an unfamiliar Agent, first establish acceptance, resume, interruption and approval semantics with a scripted transport. Do not launch a real Agent for tests or development. Real-Agent acceptance requires the maintainer's explicit approval, an isolated data directory and tight generation limits. For OpenCode, read the [RFC 0028 research appendix](../rfc/0028-agent-and-provider-registries.md#appendix-opencode-notes-for-a-future-contributor-2026-11-03-docs-only); its unverified notes are not an implementation contract.

An ACP profile's `classifyTool` must set `visTool: true` only when the Agent's native metadata proves the tool belongs to the vis MCP server. The runtime does not infer identity from a display title: some Agents fill it from a tool argument's description. Verified vis confirmations bypass approvals only for non-mutating classifications; unknown tools stay `other` without `visTool`.

New ACP profiles must leave `readOnlyEnforcedByAgent` unset unless the Agent provably disables mutating tools itself in read-only fallback; otherwise, the runtime permits only verified non-mutating vis confirmations and proven `read` permissions, and denies all other requests before approval.

## 2. Create the package and descriptor

Create `packages/workbench/<name>/` with a `package.json`, `tsconfig.json` and `src/index.ts`, following the Codex package. Name it `@vis/agent-<name>`, export `./src/index.ts`, and use the same `typecheck` script and relative tsconfig base. Export the descriptor and runtime constructor from `src/index.ts`.

The workspace already includes `packages/workbench/*`. `scripts/check-boundaries.mjs` automatically allows `agent-*` packages to depend on `protocol`, `domain`, `storage` and `workbench-core`, and allows studiod to depend on them. No new boundary-list entry is needed for this naming convention. Discuss any new external dependency first.

Put an `AgentDescriptor` (imported from `@vis/workbench-core`) in `src/descriptor.ts`. The test-only descriptor in `apps/web/e2e/example-agent.ts` starts like this:

```ts
export const exampleDescriptor = {
  kind: 'example',
  label: 'Example Agent',
  icon: ['M12 2 22 12 12 22 2 12Z', 'M8 12h8M12 8v8'],
  homepage: 'https://example.invalid',
  install: { hint: { zh: 'Example fixture', en: 'Example fixture' } },
  envPassthrough: [],
  forbiddenPaths: [],
  capabilities: { resume: true, interrupt: true, models: true, effort: true, approvals: true },
}
```

- `kind` is the stable database id: it must match `[a-z][a-z0-9-]*`. Choose it once. `label` is an untranslated brand name; `homepage` links to the Agent.
- `icon` contains SVG path data on a 24×24 stroke grid, drawn with `currentColor`. Supply paths, never SVG markup.
- `install.hint` has English and Chinese text; optional `install.command` is an installation hint, not an instruction to install a tool during tests.
- `envPassthrough` lists additional environment **names**, not values. DeepSeek declares `DEEPSEEK_API_KEY`; the others currently declare none. Pass through only what this Agent needs.
- `forbiddenPaths` lists credential locations denied to every other Agent, such as `~/.codex`, `~/.dsh`, or Claude's `~/.claude`, `~/.claude.json` and `~/.claude.json.*`. The empty fixture list is not appropriate for an Agent with saved credentials.
- Set the five capability flags to what the adapter actually implements. They control available UI actions; they do not grant permissions.

## 3. Implement the runtime and instructions

Implement `AgentRuntimePort` from `packages/workbench/core/src/runtime-port.ts`:

- `ensureReady(sessionId)` prepares the runtime before delivery.
- `dispatchTurn(input: DispatchInput)` resolves when the Agent accepts the turn. Throw `DispatchError('rejected', message)` only when it provably did not receive it; use `'unknown'` when it may have received it. An uncertain delivery must not be resent automatically.
- `interruptTurn({ sessionId, turnId })` requests interruption. Report `turn_ended` when it really ends; resolving the request alone does not end a turn.
- Optional `agentOptions(agentKind, { model? })` supplies model choices. Provide `dispose()` on the returned runtime when cleanup is needed.

Translate durable output into `AgentEvent` through the injected `report` callback, including stable item ids/revisions, resume ids and terminal events. Send transient text through the injected `stream` callback when supported. Follow the existing adapters' runtime-instance lifecycle helpers and token handling. Route native command/file approvals through `requestApproval`; preserve the shared auto-approval rules, including automatic acceptance of vis tool confirmations in every session. Gateway authorization remains the permission boundary.

[RFC 0026](../rfc/0026-agent-instructions.md) keeps shared instructions in `packages/workbench/core/src/instructions/index.ts`. Codex's `prompt.ts` is a short wrapper:

```ts
export function developerInstructions(work?: DispatchInput['workContext'], isolation: 'sandbox' | 'none' = 'sandbox'): string {
  return agentInstructions({ environment: { access: 'expanded', isolation }, work })
}
```

Use `agentInstructions({ environment, work })` for always-loaded text and `turnPrompt(input)` for each turn, selecting the actual access/isolation state. Keep Agent-specific text in the adapter's `prompt.ts` or overlay; DeepSeek adds a note about background jobs ending with the turn. Domain workflows are fetched through `guide.get` (CLI: `vis guide`), not copied into another prompt. Claude's older `prompt.ts` and restricted SDK launch remain deferred under RFC 0026 §8; do not copy them as the shared-instruction or sandbox pattern.

## 4. Wire registration and isolation

Add `"@vis/agent-<name>": "workspace:*"` to `services/studiod/package.json`, then rerun the workspace install to update `pnpm-lock.yaml`. Add runtime wiring in `services/studiod/src/<name>.ts`, following `codex.ts` or `deepseek.ts`: the `AgentRuntimeFactory` receives the database, work directory, event callbacks, approval callback and combined `forbiddenPaths`. Issue a per-space token through `issueAgentToken`; expose vis through the existing CLI/MCP wiring.

In `services/studiod/src/main.ts`, import the descriptor and factory, then add one entry to `registerAgents([...])`. This is the production registration list. `availability` is a synchronous, non-secret probe returning `{ available, reason? }`; without it, registration defaults to available. Check executable presence without starting a real turn. `agents.list` supplies all labels, icons, capability flags and choices to the UI. Do not add protocol/storage enums or UI lists.

Forward the factory's entire `forbiddenPaths` list to `prepareSandbox` in `packages/workbench/core/src/sandbox.ts`, together with your descriptor's `envPassthrough`, own `runtimeDirectory` and optional `runtimeHomeVariable`. The union comes from all registered descriptors. The helper exempts the running Agent's own runtime directory and denies the other credential paths; test with a fake home, including wildcard backups. Do not read credential files to discover or verify them.

On macOS, launch the complete process tree under the returned Seatbelt policy, as Codex and DeepSeek do. It blocks provider credentials, private studiod data and writes outside the allowed directories. Honor the read-only fallback when isolation cannot be prepared. Windows has no equivalent sandbox: use the filtered environment and approvals and do not claim OS isolation. Never pass provider keys, UI/admin tokens or an unfiltered process environment to the Agent. The application must never open Agent credential files; authentication remains the user's Agent setup. Claude's current SDK adapter does not yet use this sandbox helper.

Removing a registration keeps existing sessions and transcripts readable but prevents new turns (`unavailable`, reason `session.agent_unconfigured`). The board can still move their cards. Queued activations remain eligible if the adapter is reinstalled and do not block other Agents' queue entries.

## 5. Prove it without a real Agent

Use `services/studiod/src/agents.test.ts` for a browser-free rehearsal: copy the example descriptor with a fresh kind, register a scripted runtime, and check discovery, a dispatched turn and its events. Check duplicate/invalid kinds, missing executables, removed-kind history, shared instructions, environment filtering and cross-Agent credential denial with fake paths. Adapter transport tests should cover acceptance versus unknown delivery, resume, interruption and approvals without launching a real binary.

The fuller fixture is `apps/web/e2e/example-agent.ts`: it registers the example descriptor with `codexRuntime`, explicitly pointed at `apps/web/e2e/fake-codex.mjs` by `agent-registry.e2e.ts`. It is a fake Codex transport, not a fourth production adapter. To rehearse discovery, use a fresh descriptor kind in a throwaway copy of the fixture and update that test's kind expectations; do not change product UI lists. The browser case covers pickers, a turn, command approval, the board and removed-Agent history.

Run focused unit checks from the repository root:

```sh
npx --yes pnpm@10.34.9 exec vitest run services/studiod/src/agents.test.ts packages/workbench/core/src/sandbox.test.ts packages/workbench/core/src/instructions/instructions.test.ts
npx --yes pnpm@10.34.9 check
```

For a code contribution, have Chrome available (see the [README](../../README.md#development)), then build and run the full fake-only browser suite twice:

```sh
npx --yes pnpm@10.34.9 build
npx --yes pnpm@10.34.9 --filter @vis/web test:e2e
npx --yes pnpm@10.34.9 --filter @vis/web test:e2e
```

Remove throwaway fixtures. Keep tests for the actual adapter, update the relevant RFC and both README roadmaps, and commit the package, studiod wiring and lockfile together. Follow AGENTS.md for review and attribution; do not push or merge without the maintainer's instruction.
