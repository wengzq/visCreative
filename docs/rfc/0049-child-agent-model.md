# RFC 0049: Agents choose the model and effort of the child sessions they dispatch

Status: accepted (maintainer, 2026-11-13). Revises RFC 0014's "Agents cannot set model or effort" for child sessions only.

## Problem

An author tells a root Agent: "dispatch a Codex child on GPT-6.1 Sol at xhigh". The Agent cannot do it. `work.dispatch` takes only `agentKind`; `session.setAgentConfig` and `session.agentOptions` are UI-only (RFC 0014), and `WorkSessionView` does not show a session's model or effort. The Agent correctly answered that it could not set or confirm the setting and sent the author to the UI. The author's instruction was clear, and the mechanism was missing.

## Goals

- An Agent can dispatch a child with a model, effort and service tier, and change them for a direct child's session later.
- An Agent can list the valid choices before it dispatches, and read back what each child session runs.
- The gateway validates every value against the Agent's own model list; a wrong id fails loudly instead of silently falling back to defaults.

## Non-goals

- An Agent changing its own session's model or effort. That stays UI-only, as RFC 0014 decided.
- Children inheriting the parent's settings. A child without settings uses its Agent's defaults, as today.
- Global or per-Agent default models.

## Contract (`packages/protocol`)

- `WorkSessionView` gains `agentConfig: { model, effort, serviceTier }`, the same shape and defaults as `SessionSummary.agentConfig`. `work.get` and `work.list` therefore show what each session runs to both the UI and Agents.
- `work.dispatch` gains optional `agentConfig: { model?: string | null, effort?: string | null, serviceTier?: string | null }`. Omitted fields are `null` (Agent default). The child's session is created with it.
- New `work.agentOptions({ agentKind })`, callers `both`: returns `{ models: AgentModelOption[] }` from the same per-kind catalog and cache as `session.agentOptions`. Agents use it to find valid ids.
- New `work.setAgentConfig({ requestId, workItemId, model, effort, serviceTier })`, callers `agent`: sets the config of the target work item's main session (first unarchived session, RFC 0009 routing). It takes effect from that session's next turn, as in RFC 0014. The UI keeps using `session.setAgentConfig`.
- Capability descriptions for the three Agent-visible methods say: set model or effort only when the author asked for it or a skill or workflow the author wrote says so; otherwise omit `agentConfig`.

## Gateway rules

- `work.dispatch` with `agentConfig`: same caller rules as today (any session of a root work item). `work.setAgentConfig`: the caller's work item must be the target's parent. Its own work item, siblings and grandchildren return `forbidden`.
- Validation is RFC 0014's: a non-null `model` must be in the catalog for that `agentKind`; a non-null `effort` must be in the chosen model's efforts (the Agent's default model when `model` is null); `serviceTier` follows RFC 0014's rules. Invalid values return `invalid_params` naming the field and listing the valid ids.
- When `agentConfig` has a non-null value and the catalog cannot be read (Agent not installed, not signed in), the call returns `unavailable` with the reason and creates nothing. An explicit request never silently becomes a default.
- Both calls are idempotent by `requestId`, run in one transaction, and emit the session change event the UI already handles, so open windows update the child's model picker.
- No other permission changes: the author can still change any session's settings from the UI at any time, and that wins until the next change.

## Agent guidance

Update each Agent's developer instructions (`prompt.ts`) with one short paragraph: when the author names a model or effort for a child, call `work.agentOptions` for that Agent kind, pass the exact ids to `work.dispatch` (or `work.setAgentConfig` for a child that already exists), and confirm by reading `agentConfig` back from `work.get`. If the name is ambiguous or not listed, show the author the options instead of guessing. Do not pick a model on your own initiative.

## UI

No new controls. The child session's existing model picker shows the value the parent set. The work item drawer's session row shows the model label next to the Agent kind when its configuration is not the default (including effort-only and service-tier-only settings), through `messages.ts` in both languages.

## Tests

- Contract: new fields and methods in `protocol.test.ts` and `capabilities.test.ts`; old records without `agentConfig` on `WorkSessionView` parse with nulls.
- Gateway and service: dispatch with a valid config creates the child session with it. An invalid model or effort returns `invalid_params` and nothing is created. An unreadable catalog returns `unavailable`. `setAgentConfig` works for a direct child and is forbidden for self, sibling and grandchild. Repeated `requestId` returns the same result.
- Adapter: the child's first turn passes the model and effort (Codex `turn/start`, ACP config options), using the existing RFC 0014 paths.
- e2e (fake Codex with a fixed model list): a root Agent dispatches a child with a model and effort. The child's model picker shows them, and `work.get` returns them.

## Rollout

One step. The new `agentConfig` fields on the contract default to null, so older clients and stored results keep working.

## Implementation notes (2026-11-13)

The session and work-item paths share one validator and the existing ten-minute per-kind catalog cache. Catalog reads happen before writes. The work service requires a caller resolver for dispatch and child configuration: it resolves the caller before the probe, then unconditionally resolves it again inside the write transaction and uses that fresh actor for permission and relationship checks. The gateway supplies the resolver without eagerly evaluating it. The UI-only session.setAgentConfig path has no active-turn requirement. A changed main session returns `busy` so the caller can retry against the new session. Request replays validate the stored fingerprint before reading catalogs or resolving the current main session, preserving later author changes.

Only root workspaces receive the child-configuration guidance, through shared Codex/DeepSeek/ACP instructions or the Claude developer prompt. Cards and drawers use one shared label helper: the Agent kind and per-kind index stay separate from the model, effort and service-tier display. Any non-null setting shows configuration, including effort-only or tier-only settings with the default model label. Session-button accessible names retain only the Agent kind and index. A shared per-kind client cache deduplicates catalog reads; the drawer renders before those reads finish and updates labels afterwards, falling back to the exact id or localized default-model copy when unavailable. The existing model picker shows the saved settings. No new controls or storage migrations are needed.

## Review corrections (2026-11-13)

Dispatch normalizes an omitted config, an empty object and an all-null config to the same omitted value before fingerprinting. Authenticated successful replay has a dedicated lookup path before target-session/relationship or recall/delete guards; fingerprint conflicts still fail and caller authentication still applies to retries. Known VisErrors from catalog reads retain their original reason and details. If the catalog has no default model, an effort-only or tier-only request names that field and asks for an explicit model, listing the valid model ids.

The client catalog cache retains successful reads for ten minutes and failed reads for thirty seconds, sharing pending requests across card/drawer mounts and review reloads. Catalog failures do not delay review data or actions. Regression tests cover both replay orders, pending recall/delete, fresh actor resolution for both writes, root-only instructions, labels and accessible names, and a drawer opening while its shared catalog response is held.
