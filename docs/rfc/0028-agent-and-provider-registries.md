# 0028 · Agent and provider registries; more generation services

Status: in progress (steps a–d implemented; real-API acceptance pending)

Date: 2026-11-03

> Render licensing follow-up (2026-11-07): GSAP has been removed from dependencies and packaged assets. The renderer ships anime.js 4.5.0 (MIT), preserving its bundle copyright header and full license notice. Optional author-installed browser libraries live directly in `<dataDir>/render-libs/`, outside normal project/session work directories, and are served without a restart after canonical path checks. Built-in names win. GSAP is separately licensed by Webflow and is supplied only by authors who read and accept its license; the product does not obtain or install it. The audit item below is historical, and existing gateway/approval boundaries remain in force.

Builds on [0005](0005-agent-adapters-and-mcp.md) (Agent adapters: Codex, DeepSeek dsh, Claude Code), [0007](0007-generation-providers.md) (generation providers and the paid-call rule), and [0026](0026-agent-instructions.md) (shared Agent instructions with per-Agent overlays).

## Background

- **Agents are a closed list.** `AgentKind` is `z.enum(['codex', 'deepseek', 'claude'])` in `protocol/src/session.ts`, the two `agent_kind` columns in `storage/src/schema/space.ts` carry the same enum, and display names are copied into at least four UI files (`SessionPanel.tsx`, `sessionPanelModel.ts`, `ScriptAgentControls.tsx`, `App.tsx`) plus `session-service.ts`. `sandbox.ts` only knows Codex and DeepSeek. The new-workspace dialog (`WorkspaceDialog.tsx`) offers only Codex and DeepSeek, so Claude Code cannot be chosen there today.
- The backend is already close to generic: `AgentRuntimePort` (`workbench/core/src/runtime-port.ts`) has no per-Agent branches, and studiod takes `runtimes: Partial<Record<AgentKind, AgentRuntimeFactory>>`.
- **Generation services are a closed list too.** `ProviderConfigSchema` accepts only `type: 'volcengine-ark'`, and the catalog type enum is `mock | render | volcengine-ark`. `ProviderAdapter` itself is already generic: capabilities, idempotency key per attempt, optional recovery by key, honest cancel, download.
- **The settings UI is an Ark form.** `ProviderSettings.tsx` lists the built-ins plus Ark entries, offers only "+ 添加火山方舟", and its hints point at the Ark console. `type === 'volcengine-ark'` doubles as "needs a key" in `ProviderSettings.tsx`, `providerLabels.ts` and `ModelPicker.tsx`.
- The runner already enforces the paid-call rule: a submit whose outcome is unknown is queried, never resent, and becomes `unknown` (`submit_unconfirmed`) when the adapter cannot look the job up.
- Ark (Volcengine) is the only paid service, and it serves mainland China. An open-source release will have users outside China, and users inside China who want other domestic video models.

## Goals

1. An **Agent registry**: adding an Agent means writing one adapter package and one descriptor, with no edits to protocol enums, storage enums or UI lists. This RFC adds no new Agent (maintainer, 2026-11-03: we guarantee a clean, decoupled seam; contributors add Agents after the open-source release).
2. A **provider-type registry**: adding a generation service means one adapter, one type descriptor and passing a shared contract test suite.
3. **Settings for any service**: the settings panel becomes a generic "generation services" page driven by type descriptors, not an Ark form.
4. Adapters for **Kling, Alibaba Wan (DashScope), MiniMax Hailuo, OpenAI images and Google Gemini** (images and video).
5. Contributor guides for adding an Agent and adding a generation service.

## Out of scope

- New Agents, OpenCode included. Research notes for OpenCode (2026-11-03) are kept in the appendix for whoever picks it up.
- Local ComfyUI. It needs workflow-graph parameters that do not fit `paramsSchema` cleanly; revisit after this RFC.
- Google Veo through Gemini Enterprise Agent Platform (formerly Vertex AI). It needs a Google Cloud project, OAuth service credentials and a GCS bucket, not an API key. The Gemini API route below covers Google video for now.
- OpenAI video. The Videos API and Sora 2 shut down on 2026-09-24.
- Billing reconciliation or showing provider prices in the UI.

## Design

### 1. Agent registry

**Descriptor.** Each adapter package exports one serializable descriptor. The runtime factory stays separate, because studiod builds it with its socket and environment options; studiod registers descriptor and runtime together, keyed by `kind`.

```ts
type AgentDescriptor = {
  kind: string                 // stable id, [a-z][a-z0-9-]*, stored in the database
  label: string                // brand name, not translated
  icon: readonly string[]      // SVG path data on a 24×24 stroke grid, drawn with currentColor; never raw markup
  homepage: string
  install: { hint: Record<'zh' | 'en', string>; command?: string }
  /** Environment variables passed through to the Agent process on top of the shared allowlist. */
  envPassthrough: readonly string[]
  /** Credential locations the app must never open; used by tests and listed in the contributor guide. */
  forbiddenPaths: readonly string[]
  capabilities: { resume: boolean; interrupt: boolean; models: boolean; effort: boolean; approvals: boolean }
}
```

**Protocol and storage.**
- `AgentKind` becomes an `Id`-shaped string (`/^[a-z][a-z0-9-]*$/`). The gateway rejects kinds that are not registered with the existing `unavailable` error (reason `session.agent_unconfigured`), as for missing executables.
- A new UI-callable method `agents.list` returns the descriptors plus `available` (executable found) and `reason`.
- The `agent_kind` columns drop their enum constraint. Drizzle's `text(..., { enum })` is only a TypeScript type, so this is a type change; generate a migration only if the snapshot differs. Existing rows keep their values.
- A session whose Agent is no longer registered (for example, a community adapter that was removed) stays visible read-only with its transcript and cannot start new turns (maintainer, 2026-11-03).

**UI.** Every Agent picker and label reads `agents.list`. `AgentIcon` draws the descriptor paths (a generic glyph when a kind is unknown); markup is never injected. The hard-coded label tables go away. This fixes the missing Claude Code option in the new-workspace dialog.

**Sandbox.** `buildSandboxPolicy` and the environment filter take the descriptor instead of `'codex' | 'deepseek'`. `DEEPSEEK_API_KEY` moves into the DeepSeek descriptor's `envPassthrough`; nothing else changes for existing Agents.

**Prompts.** Unchanged: 0026's shared instructions plus a per-Agent overlay in the adapter package.

**Proving the seam.** Since no real fourth Agent lands here, a test-only `example` Agent (descriptor plus a scripted fake runtime, under the e2e fixtures) is registered in e2e. It must show up in every picker, run a turn, approve a command and appear in the board, with no edits outside its own files. A boundary check fails the build if `'codex' | 'deepseek' | 'claude'` literals reappear outside the adapter packages and tests.

### 2. Provider-type registry

```ts
type ProviderType = {
  type: string                         // 'volcengine-ark', 'kling', 'dashscope', 'minimax', 'openai', 'gemini', ...
  label: Record<'zh' | 'en', string>
  settingsSchema?: z.ZodType           // extra non-secret, type-specific fields; most types need none
  needsKey: boolean
  kinds: readonly MediaKind[]
  /** Hosts the user picks from; allowCustomBaseUrl permits any URL passing the existing BaseUrl rule. */
  regions: readonly { id: string; label: Record<'zh' | 'en', string>; baseUrl: string }[]
  allowCustomBaseUrl: boolean
  /** Models the adapter knows, offered as one-click additions; users may still type other ids. */
  knownModels: readonly { id: string; kind: MediaKind; label: string }[]
  /** Where a key or model id comes from; shown as help text and a console link. */
  help: { consoleUrl: string; key: Record<'zh' | 'en', string>; model?: Record<'zh' | 'en', string> }
  /** Shown in settings, never enforced: e.g. "not available in mainland China". */
  availability?: Record<'zh' | 'en', string>
  /** False until real-API acceptance passes; settings marks the type as not yet verified. */
  verified: boolean
  create(config, deps: { getKey(): Promise<string | undefined>; dataDir: string; media: MediaTools }): ProviderAdapter
}
```

- The protocol cannot know which types are registered, so `ProviderConfigSchema.providers[]` keeps one shape for every type: `id`, `type` (any registered type id), `label`, `baseUrl`, `region?`, the three model lists, and `settings?` (a record). studiod rejects an unregistered `type` and validates `settings` with the type's `settingsSchema`. Existing `providers.json` files stay valid unchanged.
- Keys stay in the system credential store, keyed by provider id, exactly as today.
- The catalog gains `providerTypes` (descriptors without `create`, with `settingsSchema` as JSON Schema) and `needsKey` on each provider. The catalog `type` enum becomes a string.
- Type descriptors carry their own bilingual strings because they are owned by the adapter, not the web client; `check:i18n` does not scan backend packages. Generic copy (buttons, headings, errors) stays in `messages.ts`.
- **Shared contract tests** (`packages/generation/src/providers/contract.ts`) that every paid adapter runs against a recorded fake server: same idempotency key → same external task; lost submit response → `unknown` unless the adapter can find the task by key; cancel returns `cancelled: true` only when the provider confirms; download validates mime and size; moderation failures map to `rejected` with a reason; no key or `Authorization` header appears in errors, logs or events.

**Synchronous APIs** (OpenAI Images, Nano Banana images, MiniMax `image-01`). `submit` makes the call, writes the decoded output to `workDir/<idempotencyKey>` and returns a synthetic task id; `getTask` reports `succeeded`; `download` reads the staged file. A timeout during that call is a lost response: the runner marks the job `unknown`. The client timeout must exceed the documented latency (OpenAI: up to 2 minutes).

**Output URLs.** Several services return short-lived URLs (MiniMax time-limited with a fresh URL on requery, DashScope task and URL 24 hours). Adapters download as soon as a task succeeds; DashScope's `UNKNOWN` status after expiry maps to `unknown`, never to failed or safe-to-resubmit.

**Model documentation (added by [RFC 0045](0045-model-doc-links.md), 2026-11-11).** `knownModels[].docs` links each model to its vendor's official prompt guide and API reference, and `modelDocs` gives per-kind pages for IDs outside `knownModels`. `providers.list` returns them on each model as `docs`, and Agents open them before writing a prompt.

### 3. Settings: generation services

The page title becomes 生成服务 / Generation services. Layout stays a list on the left and a form on the right.

- **List.** Built-ins (mock, render) first, then configured services with their type icon and a status dot (configured / key missing). The add button is "+ 添加服务", which opens a chooser of registered types: label, media kinds and availability note. Ark is one card among them.
- **Form, generated from the type descriptor.** Name; region (select from `regions`, plus custom URL when the type allows it); API key (write-only field, as today, with the Windows disclosure from 0022); models per media kind, where `knownModels` appear as chips to add with one click and "custom id" opens a text field with the type's `help.model` hint. Ark keeps free-form endpoint ids, so its `knownModels` may be empty.
- **Defaults and limits** (default model per media kind, daily limits) move to their own section below the list, since they span services.
- `needsKey && !hasKey` replaces every `type === 'volcengine-ark'` check, including the model picker's "key not configured" state.
- Removing a service that pending jobs pinned keeps today's behavior (jobs settle `unknown` with `provider_missing`); the form warns before removal.

UI spec details (spacing, states, empty page) are written with step c's task, following `0009-ui-spec.md` conventions.

### 4. Services

| | Kling | DashScope (Wan) | MiniMax | OpenAI | Gemini API |
|---|---|---|---|---|---|
| Media | video, image | video, image | video, image | image | image (Nano Banana), video (Omni Flash) |
| Recover lost submit | **yes**: `external_task_id`, query by it | no | no | no | no |
| Cancel | none | `PENDING` only | none: the same DELETE on a finished task deletes it, and no atomic guard exists (see second-wave notes) | none (Images API) | background interactions; trust only a later `cancelled` status |
| Regions | Beijing and Singapore hosts | Beijing and Singapore (key bound to region); US and EU deferred, see second-wave notes | China and international hosts | not mainland China, Hong Kong, Macau | not mainland China, Hong Kong, Macau |

- **Kling** first: its client task id gives real `findTaskByIdempotencyKey`, which exercises the full recovery path. API-key auth (the AK/SK JWT is legacy).
- **DashScope:** `wan2.7-*` and `wan3.0-video(-prime)` models, `X-DashScope-Async: enable`, poll about every 15 s. Region chooses the host; Wan3.0 is served only from workspace hosts, entered as a custom URL.
- **MiniMax:** the v2 API (`MiniMax-H3` family) only; v1 Hailuo has no listing, cancel or recovery. `image-01` is synchronous.
- **OpenAI:** `gpt-image-2.5-*` and `gpt-image-2` through the Images API; base64 output, no URLs. Background mode through the Responses API is a later improvement if it supports the image tool.
- **Gemini API:** Nano Banana image models (synchronous) and `gemini-omni-1.1-flash` video through Interactions with `background: true`.

Model ids, parameters and frame modes come from each adapter's model table, as for Ark today. The research behind this table (2026-11-03, docs only) has gaps marked unverified, which each adapter's task must settle against current docs.

**Cost.** No test or development run calls a real service. Real acceptance needs the maintainer's approval per service, an isolated data directory and tight daily limits. Adapters can merge on fake-server tests; each service is marked "untested against the real API" in the settings chooser and README until its acceptance passes (maintainer, 2026-11-03: test keys will come later).

## Steps

- **a. Agent registry** (done). Descriptor, `agents.list`, open `AgentKind`, UI and sandbox from descriptors, the test-only example Agent and the literal check; existing three Agents ported with no behavior change except the new-workspace dialog gaining Claude Code.
- **b. Provider-type registry and settings** (done). Config union, type descriptors, catalog changes, the generic settings page, shared contract tests; Ark ported onto it.
- **c. Services** (done: all five adapters merged, none accepted against a real API). One task each, parallel after b.
- **d. Contributor guides** (done). [Adding an Agent](../contributing/adding-an-agent.md) and [adding a provider](../contributing/adding-a-provider.md), built from a–c and checked against the implementation with throwaway test-only extensions.

a and b are independent and run in parallel; c needs b.

## Not done yet (as of 2026-11-08)

Steps a–d are implemented. The unchecked items below remain open; this RFC stays in progress until they are closed.

**Real-API acceptance: MiniMax accepted; the others partial or not started.** It needs the maintainer's approval per service, test keys, an isolated data directory and tight daily limits. `verified` stays `false` until a service passes.
- [ ] Kling. Adapter tested against a fake server only.
- [ ] OpenAI Images. 2026-11-08: the maintainer generated images successfully through a custom gateway, which confirms the request and response handling; the official `api.openai.com` host has not been run yet, so `verified` stays `false`.
- [ ] DashScope. Adapter tested against a fake server only. Check that the request id string really confirms a cancel. Wan3.0 needs a run through a workspace host.
- [x] MiniMax. Accepted 2026-11-08: the maintainer generated `MiniMax-H3` video and `image-01` images in the China region (`api.minimax.cn`); `image-01` finished inside the five-minute timeout. `verified` is now `true`. The international host was not run; it serves the same API.
- [ ] Gemini. Adapter tested against a fake server only. Measure studiod memory on a large inline base64 video: the response is parsed whole, bounded at about 340 MiB of body, and the peak is estimated, not measured, at around 1 GB.

**Open questions that need a real account.**
- [ ] Kling: the actual response to a duplicate `external_task_id`, and whether it is billed. The adapter does not depend on the answer.
- [ ] Kling: whether a key created on one platform (Beijing or Singapore) works on the other.
- [ ] Kling: whether 1302/1303 at create can ever leave a task behind. The adapter retries only after a lookup confirms absence.
- [ ] Kling: any length or charset limit on `external_task_id`. None is documented; we send 64 hex characters.
- [ ] OpenAI: whether an output-stage moderation block is billed. The job says the image was generated and then blocked, and makes no billing claim.

**Follow-ups from the second wave.**
- [x] DashScope US and EU: a workspace-specific host is entered as a custom URL (see Custom endpoints below); unverified against a real workspace. Whether Beijing and Singapore move to workspace hosts stays open.
- [ ] MiniMax: `help.consoleUrl` points at the international console; a descriptor has one URL, so China users get the wrong link.
- [ ] Gemini: whether Nano Banana models support background mode.

**Prompt reference labels (found 2026-11-11 while fixing Seedance, RFC 0043).** Picked references are sent as `图片 1` / `视频 1` (numbered per media type) to every provider without its own format. Documentation suggests two mismatches, unverified against the real APIs:
- [ ] Kling: 3.0/4.0 Omni video documents `@image_1`, and Image 3.0 Omni documents `<<<image_1>>>`.
- [ ] DashScope Wan: Wan2.7 R2V and Wan3.0 document `Image 1` / `Video 1`.

MiniMax, OpenAI and Gemini document no required syntax and keep the default label.

**Agents.**
- [ ] Claude Code real-Agent acceptance is still deferred, so the new-workspace option has not been run against a real Claude Code session.

**Step d: contributor guides complete.**
- [x] [Adding an Agent](../contributing/adding-an-agent.md)
- [x] [Adding a provider](../contributing/adding-a-provider.md)

**Open-source readiness: CI, contribution guide and GitHub entry points implemented; license audit and first-run path open.** The GitHub Actions workflow and `CONTRIBUTING.md` are in place, and hosted Linux check, build and e2e have passed since one e2e file runs at a time (run 41860646714). `SECURITY.md`, the code of conduct, issue and PR templates and the publishing path that keeps the archive history private landed with [RFC 0042](0042-open-source-practices.md). The license audit and the first-run path remain open; see the parallel track below.

**Known limitations, accepted for now.**
- `validateInputs` is synchronous and sees no file size or dimensions, so those checks run in `submit`, before the paid call.
- OpenAI background mode through the Responses API is not implemented; a timed-out call stays unknown.
- Sync tombstones and unknown job records are kept permanently, with no garbage collection.

## Decisions (maintainer, 2026-11-03)

- No new Agent in this RFC; registry and decoupling only.
- Generation services stay in scope; the settings UI is redesigned around service types.
- Real-API acceptance waits until the maintainer has test keys.
- Unregistered Agents' sessions stay visible read-only.

## Implementation notes (steps a and b, 2026-11-03)

**Agent registry.**
- Each adapter package exports an `AgentDescriptor` from `src/descriptor.ts`. Runtime factories stay separate. studiod pairs each descriptor with its runtime in `registerAgents()`, keyed by `descriptor.kind`. `main.ts` is the only registration list.
- Labels keep the existing brands: `Codex`, `DeepSeek`, `Claude`.
- Capabilities:
  - Claude: resume and interrupt only. It has no models, effort or interactive approvals, matching what the SDK adapter does today.
  - Codex and DeepSeek: all capabilities.
- `forbiddenPaths`:
  - Codex: `~/.codex`. This was widened from `~/.codex/auth.json` to match AGENTS.md.
  - DeepSeek: `~/.dsh`.
  - Claude: `~/.claude`, `~/.claude.json` and `~/.claude.json.*`.
- `envPassthrough` is empty for every Agent except DeepSeek (`DEEPSEEK_API_KEY`).
- Sandbox deny lists are the union of every registered Agent's `forbiddenPaths`, minus the running Agent's own runtime directory. New adapters must forward the list they receive to their sandbox helper. The Codex and DeepSeek policy strings are pinned byte for byte by tests.
- Storage: `agent_kind` lost its TypeScript-only enum. `db:generate` produced no migration.
- Unregistered kinds:
  - They are rejected with the existing `unavailable` / `session.agent_unconfigured` error. No new `agent_unavailable` code was added.
  - The gateway only checks registration; it never runs availability probes. Only `agents.list` probes executables.
  - `work.move` is exempt, so the user is never blocked. The card changes status, the session queue is paused, and no slot is reserved. Startup recovery does the same.
  - A queued activation for a removed Agent stays queued, so reinstalling the Agent makes it eligible again. It never blocks the global FIFO.
- UI loading: the UI treats "registry not loaded yet" differently from "loaded, kind missing". While the list loads, nothing is locked. The workspace dialogs apply the saved preference once the list arrives, unless the user has already picked.
- `scripts/check-agent-literals.mjs` (`check:agents`) rejects `'codex'`, `'deepseek'` and `'claude'` outside these places:
  - the adapter packages;
  - studiod `main.ts` and the `codex.ts`, `deepseek.ts` and `claude.ts` runtime wiring files;
  - `apps/web/agent-eval/{runner,safety}.ts`;
  - the `DEFAULT_AGENT_KIND` line;
  - tests.
- The e2e-only `example` Agent proves the seam with no product code naming it. Its files are `apps/web/e2e/example-agent.ts` and `agent-registry.e2e.ts`.

**Provider-type registry.**
- `ProviderType` is as designed, with these changes:
  - `getKey` may return `undefined`.
  - An optional `settingsFields` adds localized labels for `settingsSchema` properties. JSON Schema `title` and `description` are the fallback.
- Registry construction:
  - `createProviderTypeRegistry` validates descriptors and rejects duplicates and the reserved `mock` and `render` ids. It caches the described types.
  - `builtinProviderTypes` holds Ark only.
  - `StudiodOptions.providerTypes` lets tests and embedders add types.
- Ark compatibility:
  - Only `volcengine-ark` entries may omit `baseUrl`; Beijing is implied. Every other type must store an endpoint, so no vendor can inherit the Ark host and receive the wrong key.
  - Today's files parse and save byte-identically.
- One validation function runs on update, on load and when a pinned job snapshot is rebuilt. It checks settings, region against URL, custom URLs and media kinds.
  - A stored entry that fails validation stays in the file and is listed as unavailable with a reason. It never builds an adapter.
  - A pinned snapshot that fails validation settles its job `unknown` with `provider_config_invalid`.
  - Unknown types are `provider_missing` as before.
  - Adapters receive the parsed settings, with defaults applied.
- Defaults that point at an unavailable service fall back to an available one, or are omitted. The catalog reports these in `unavailableDefaults` so settings can warn.
- Job errors gained optional `data.reason` and `data.params`. A moderation rejection keeps the `provider_rejected` code and now carries its reason through the runner.
- Downloads: Ark downloads are now streamed with a 256 MiB limit.
- Contract suite:
  - Each paid adapter's test calls `providerContract(name, scenario => harness)` from `packages/generation/src/providers/contract.ts`. The scenarios are `normal`, `lost`, `cancel-confirmed`, `cancel-unconfirmed`, `wrong-mime`, `oversized`, `moderation` and `secret-error`.
  - The suite checks the real runner, emitted events, logs and persisted jobs for the fake key.
  - It is test-only and not exported from the package entry.
- `stageSyncOutput` for synchronous APIs:
  - It records the intent durably before calling, stages the decoded output, and deduplicates in-flight calls across adapter instances. It is keyed by data directory, provider and idempotency key.
  - Output that is unusable after a paid call settles `failed` with `sync_output_invalid`, which says the call completed. It never claims nothing ran.
  - Staging I/O errors are `unknown`.
  - A new optional `ProviderAdapter.cleanup` runs only after a durable terminal state. It deletes the staged bytes and keeps a small permanent tombstone, so a repeated key never pays twice. Unknown jobs keep their staging.
  - Startup retries interrupted cleanup.
- Settings UI:
  - The page is now "生成服务 / Generation services", with a keyboard-accessible type chooser and a form built from the descriptor.
  - Choosing a custom URL removes `region` instead of storing `'custom'`.
  - Unregistered or invalid services are read-only with their reason; removal stays enabled.
  - Defaults and limits have their own entry.
  - `needsKey && !hasKey` replaced every `volcengine-ark` key check. `isBuiltinProviderType` lives in protocol.

## Implementation notes (step c, first wave: Kling and OpenAI Images, 2026-11-04)

Both are built-in types with `verified: false` until real-API acceptance. Docs were checked 2026-11-04 with documentation requests only; each adapter's model table cites its sources.

**Kling** (`providers/kling`).
- Hosts: Beijing first, then Singapore. No custom URL at first, so the key only reached Kling; superseded by Custom endpoints below. Auth is an API key as a Bearer token; the AK/SK JWT is not implemented.
- Models:
  - video `kling-3.0`: text, first frame, first and last frames;
  - video `kling-3.0-omni`: adds up to 7 reference images;
  - video `kling-4.0`: 3–30 s, up to 10 reference images;
  - image `kling-v3-omni`: up to 10 references, `n` at most 4.
  - Video and audio references, multi-prompt shots and the other 4.0 variants are not exposed.
- Paths:
  - Video uses the per-model paths (`/text-to-video/…`, `/image-to-video/…`, `/omni-video/…`) and the unified `/tasks` query.
  - Image uses the documented `/v1/images/omni-image`, whose `external_task_id` is a flat field.
  - Task ids are stored as `video:<id>` or `image:<id>` so polling routes correctly after a restart.
- Recovery:
  - `external_task_id` is the SHA-256 hex of the idempotency key.
  - A durable intent file, which records the media kind, is flushed before any create.
  - `findTaskByIdempotencyKey` reads in this order:
    1. the stored task id;
    2. no intent → null, with no network call;
    3. an intent → that kind's remote lookup.
  - An intent whose task cannot be found is never resubmitted.
  - A definite create rejection is reconciled by lookup before the intent is released.
  - Rate and concurrency errors (1302/1303) become retryable only after the lookup confirms absence. The retry reuses the same account-unique id.
- Inputs use `input.mime`. Asset blobs have no extension, so they are probed through a temporary copy that has one. Outputs are checked by magic bytes and probed.
- Still unverified: Kling's actual duplicate-id response and its billing, and whether keys work across regions.

**OpenAI Images** (`providers/openai`).
- Endpoint and models:
  - One `global` region, `https://api.openai.com/v1`. A custom URL is allowed for compatible gateways; the availability note says the key then goes to that host.
  - Models: `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` and `gpt-image-2`, each also as its dated snapshot.
  - No image inputs → `/images/generations` (JSON). Image inputs → `/images/edits` (multipart, up to 4 references).
- Synchronous through `stageSyncOutput`, with a 5-minute timeout. No `findTaskByIdempotencyKey`, no `cancel`.
- `sync.ts` `call` may now return a completed failure, `{ state: 'failed', error: { code, message, reason? } }`. It is persisted like `sync_output_invalid`, and the reason reaches the job's `data.reason`.
- Moderation:
  - Input-stage → `rejected` with `generation.moderation_rejected`.
  - Output-stage or unknown stage → `failed`, with the same reason and a message saying the image was generated and blocked, or that billing cannot be confirmed.
- Status mapping:
  - The key is read and checked (no CR/LF) before any intent is written.
  - HTTP status is classified before the body is parsed, so a proxy's HTML 4xx is still definite.
  - A parsed 200 with unusable data → `sync_output_invalid`.
  - Truncated responses, 5xx and transport errors → unknown.
- `download.ts` exports `OutputSizeLimitError`.

**Shared.**
- `providers/http.ts` holds `isObject`, `redact`, `containsKey` and `outputUrl`; Ark, Kling and OpenAI use it.
- New vendor-neutral reasons:
  - `generation.provider_balance`
  - `generation.provider_auth_failed`
  - `generation.provider_key_unreadable`
  - `generation.provider_request_too_large`
  - `generation.provider_verification_required`
  - `generation.output_type_invalid`
  - and related ones.

**Next wave** (DashScope, MiniMax v2, Gemini):
- DashScope and MiniMax video follow Kling, without key recovery.
- MiniMax `image-01` and Nano Banana follow OpenAI.

## Implementation notes (step c, second wave: DashScope, MiniMax and Gemini, 2026-11-04)

All three are built-in types with `verified: false` and, at this wave, `allowCustomBaseUrl: false` (superseded by Custom endpoints below). Docs were checked 2026-11-04 with documentation requests only; each model table cites its sources. Every adapter persists an intent before a paid call and has no `findTaskByIdempotencyKey`, so a lost or ambiguous submit stays unknown and is never resubmitted.

**Deviations from the design above.**
- DashScope ships Beijing and Singapore only. The current regions table gives US (Virginia) and EU (Frankfurt) no fixed host, only `{WorkspaceId}.<region>.maas.aliyuncs.com`. Supporting them needs a `workspaceId` setting and a host derived from user input, which widens where the key can go, so that needs its own decision here first.
- MiniMax has no cancel. The v2 DELETE acts on the state at execution: `queued` cancels, running errors, succeeded or failed deletes the record. It has no expected-state condition, so a read-then-DELETE can destroy a paid output. A cancelled job reports `providerCancelled: false`, and the settings note says generation and billing may continue (maintainer, 2026-11-04).
- MiniMax v2 documents no one-hour URL lifetime; that figure belongs to the v1 download path. v2 says to query again for a fresh URL.

**Shared.** `ProviderAdapter` gains optional `pollIntervalMs`. The runner uses it in place of the global interval for pending, running and concurrency-limit waits; retry backoff is unchanged.

**DashScope** (`providers/dashscope`).
- Hosts: `dashscope.aliyuncs.com` and `dashscope-intl.aliyuncs.com`. Keys are region-bound.
- Models: `wan2.7-t2v`, `wan2.7-i2v`, `wan2.7-r2v` with dated snapshots; `wan2.7-image`, `wan2.7-image-pro`. Both kinds are asynchronous with `X-DashScope-Async: enable`, polled every 15 s.
- `wan2.7-r2v` allows 15 s with image references, 10 s with video references. Video and audio references need public URLs, so they are not exposed and the adapter's range is 2–15 s.
- Added 2026-11-08: `wan3.0-video` and `wan3.0-video-prime` (preview). One model covers text-to-video, first frame, first and last frame, and up to 10 reference images; frames and references cannot be mixed. Parameters: `resolution` 480P/720P/1080P (default 1080P), `ratio` adaptive (default) or 21:9/16:9/4:3/1:1/3:4/9:16, kept with frames, `duration` 2–30 s, `audio` (default on, same price), `prompt_extend`, `watermark`, `seed`; no `negative_prompt`. Duration -1 (the model picks) is not exposed so the billed length stays known. Prompts may run to 20,000 characters. Wan3.0 is offered only on `{WorkspaceId}.<region>.maas.aliyuncs.com`, never on `dashscope.aliyuncs.com`, so it needs the workspace host as a custom URL; the settings help says so. Video, audio, file and link inputs are not exposed. Source: https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference (checked without authenticated calls). Not yet run against the real API.
- Moderation: `DataInspectionFailed` / `data_inspection_failed` at submit is `rejected`; in `output.code` or partial `output.results` it is `failed` with `generation.moderation_rejected`.
- `UNKNOWN` maps to `not_found`, which the runner settles as `unknown`.
- Cancel reads state first and posts only for `PENDING`. The documented success response is a request id string, which is taken as confirmation; real acceptance must check this.

**MiniMax** (`providers/minimax`).
- Hosts: `api.minimax.cn` (settled by the current China OpenAPI) and `api.minimax.io`.
- Video: v2 only, `MiniMax-H3`, `-Highspeed`, `-Lite`, `-Max`; text, first and last frames, up to nine image references.
- Images: synchronous `image-01`, base64 output, through `stageSyncOutput`. The docs publish no latency bound, so the five-minute timeout is a conservative choice.
- Output refs hold the task id, not a URL. The adapter refreshes the URL after 55 minutes, or once after 401/403/404/410; a still-missing output is `unknown`.

**Gemini** (`providers/gemini`).
- One `global` region. The key travels only in `x-goog-api-key`, and file URIs must match the API origin and a fixed path before the key is sent.
- Images: Nano Banana models through synchronous `generateContent`. Background mode is documented for Gemini models generally, with nothing specific to these, so images stay synchronous.
- Video: `gemini-omni-1.1-flash` through Interactions with `background: true`. GET returns inline base64 even when URI delivery was requested, so polled bytes are validated and staged too. Files expire after 48 hours; expiry never licenses a retry.
- Cancel is confirmed only by a later read showing `cancelled`.
- Safety follows timing: a block on the create request is `rejected`; one seen after acceptance is `failed` with the same reason and no billing claim. Whether a background create can return a block is undocumented, so that branch is defensive.

## Implementation notes (step d, 2026-11-04)

The [Agent](../contributing/adding-an-agent.md) and [provider](../contributing/adding-a-provider.md) guides use current source signatures and test-only examples. Two browser-free throwaway extensions exercised the steps: a new `@vis/agent-*` package with a copied example descriptor, scripted runtime, studiod dependency and registration; and a copied provider contract plus a fresh type registered with the example fake server. Discovery, a scripted turn, removed-Agent history, descriptor settings defaults, duplicate-submit prevention and output download passed; the temporary Agent package and studiod typechecked and bundled. The throwaway changes were removed. No real Agent, vendor API or production credential was used.

Details to retain when reading the earlier design and implementation notes:

- A new Agent needs the ordinary studiod package dependency and lockfile update as well as its registration. The `agent-*` boundary rule is automatic; no protocol, storage or UI list needs editing.
- `builtinProviderTypes` now includes all six paid service types, not only Ark. Injected `providerTypes` replaces that default list.
- Synchronous output is staged under the private `dataDir/generation-sync/`, not the design sketch's `workDir`.
- The example provider demonstrates registration and the contract harness, but does not persist production-safe submit intent or fully validate media; paid adapters supply those patterns.
- `ProviderTaskState` currently types a failed task's error as only `{ code, message }`, although existing adapters return extra `data.reason` and the runner preserves it. The guides report this port typing gap; this documentation change does not alter source.
- Claude's shared-instruction and sandbox migration remains deferred under RFC 0026 §8. Its descriptor does not imply that it uses the Codex/DeepSeek launch path.

## Custom endpoints (maintainer, 2026-11-06)

Users may hold their own vendor contracts, gateways or dedicated hosts, so every paid type now sets `allowCustomBaseUrl: true`. The earlier "key only reaches the vendor" rule protected a choice that belongs to the user: where their own key goes. Settings says a custom URL sends the key to that host.

- Mechanism stays: `ProviderBaseUrl` still requires HTTPS (HTTP for localhost only) and forbids URL credentials, query parameters and fragments. Adapters repeat it through `providerEndpoint`, and a stored `region` must still match its listed host.
- A custom URL must speak the selected type's API. This is not a generic HTTP adapter. Query-string keys, AK/SK signing and custom headers remain unsupported.
- **Per-operation paths.** A vendor's paths need not follow the type's layout, so each type declares `endpoints` (`id`, bilingual label, default path) and a custom-URL entry may store overrides in `endpoints`. Adapters resolve every API path through `providerPaths`; settings shows the fields only for a custom URL.
  - We cannot assume a vendor's layout, so once `endpoints` is present an unset path means the base URL itself, with nothing appended. A new custom URL starts with `endpoints: {}`. An entry saved earlier has no `endpoints` and keeps the declared paths; settings shows them, and the first edit stores them explicitly.
  - Rules live in `ProviderEndpointPath` and `endpointOverrideValid`: a path below the base URL, with no query, fragment, percent escape, backslash, empty or dot segment. Paths therefore cannot change the host or carry `?ak=` into `providers.json`.
  - An override keeps exactly the declared `{model}` and `{id}` variables: a task path must name its task, and Kling video and Gemini images carry the model only in the path. Adapter-owned query parameters such as Kling's `task_ids` stay in the adapter.
  - The base URL alone cannot carry those variables. An unset path with variables is refused before the request (`generation.provider_endpoint_missing`), and unset paths marked `requiredFor` a configured media kind are refused at save time (`provider.endpoint_required`), because a job that cannot be queried would be paid for and lost. An unset Gemini cancel path reports `cancelled: false`.
  - studiod rejects overrides on a listed region or host with `provider.endpoint_invalid`, and adapters repeat the path check. Overrides are part of the pinned job configuration, so a running job keeps the paths it was submitted with.
  - Gemini builds file status and download URLs from the `file` and `fileDownload` paths. A relayed file URI is still accepted only in the default `/files/<id>` shape, under the configured or official base.
- **Asynchronous vendors.** The runner is generic: `submit`, poll `getTask` every `pollIntervalMs`, then `download`. What is not generic is each adapter's parsing of the task ID, status values and output location. Path overrides fit a vendor that keeps a type's shapes. A vendor with its own async shape, or a callback-only API, needs its own adapter. OpenAI Images is synchronous and has no task paths, so it cannot front an async vendor.
- Gemini sends every keyed request to the configured base. A gateway may relay Google's file URI unchanged, so `fileUrl` accepts the configured base or the official base and always rewrites to the configured one; any other host is refused before a key is read. Output downloads for Kling, DashScope and MiniMax carry no key.
- `verified` is unchanged: a working gateway does not verify the vendor's API. An OpenAI Images gateway was accepted by the maintainer on 2026-11-06 (Bearer key, `b64_json`, text-to-image only; `/images/edits` not checked).

## Parallel track: open-source readiness

Not part of this RFC's contract; tracked here so it lands with it.

- [x] CI workflow: `pnpm check`, `pnpm build` and one full browser e2e round on Linux for pull requests and pushes to `main`; Windows and macOS check and build on pushes to `main` and `workflow_dispatch` only, to limit private-repository minutes. Manual runs include Linux e2e. Node 24, pnpm from `packageManager`, frozen lockfile, pnpm-store caching, superseded-run cancellation, `contents: read`, SHA-pinned actions and failure artifacts are configured in [ci.yml](../../.github/workflows/ci.yml). No provider keys, vendor API calls or real Agents are needed. The first hosted Linux run passed check/build; the maintainer must push and inspect the e2e corrections described below.
- [x] [CONTRIBUTING.md](../../CONTRIBUTING.md): commands, the unchanged two-consecutive-e2e definition of done, the RFC process, English code and links to integration guides.
- [x] `SECURITY.md` (key handling, how to report), a code of conduct, issue and PR templates: landed with [RFC 0042](0042-open-source-practices.md).
- [ ] Third-party license audit: ffmpeg build (LGPL vs GPL), bundled fonts (OFL, fetched not committed), the bundled anime.js (which replaced GSAP on 2026-11-07) and rough.js, npm dependencies.
- [ ] First-run path for someone with no paid keys: mock and render providers, a sample project, and README steps for each Agent's install and login.
- [x] Scrub history and docs for machine paths and anything private before making the repository public: the public repository receives only squashed snapshots, and the [RFC 0042](0042-open-source-practices.md) privacy check covers the tree, the message and the identity of every snapshot.

**Linux CI audit (2026-11-04).** Linux is a test target, not a new supported product platform. The system secret store chooses Keychain outside Windows and explicitly rejects operations outside macOS; fixtures use memory stores or fake command runners, so no Linux key backend is needed for CI. `prepareSandbox` fails closed without macOS Seatbelt, filters the environment and keeps permission expansion disabled. Fake-Agent canvas/work-item RPC coverage still runs; native command-approval cases in `web.e2e.ts`, `agent-registry.e2e.ts` and `session-panel.e2e.ts` share `supportsNativeApprovals` and skip on Linux because the adapter deliberately denies those approvals. Registry discovery/activation and attachment/mode checks are split from native approvals and still run on Linux. No product permissions were changed. macOS sandbox enforcement and Windows-only runtime/credential tests keep their existing platform guards; the optional installed-dsh handshake is disabled in CI so no real Agent starts.

`chromePath()` already searches Linux Chrome/Chromium locations and accepts `VIS_CHROME_PATH`; the local render provider also has Linux discovery. CI requires the runner's Chrome to exist and logs its version, so browser tests cannot silently all skip for a missing executable. Media tools use PATH-based ffmpeg/ffprobe and probe encoders at runtime. CI fetches the four checksum-verified fonts and provisions ffmpeg; it records ASS availability in the job summary. If ASS is absent, `packages/assets/src/timeline-captions.integration.test.ts` and Linux browser `apps/web/e2e/timeline-text.e2e.ts` skip real caption rendering with their existing reasons. Encoder-specific libopenh264 tests skip if unavailable, benchmarks remain opt-in, and the CLI integration test skips until build output exists. Windows/macOS browser e2e remain local acceptance work. The first hosted Linux run exercised software WebGL and caption rendering; runner PasswordVault behavior and platform timing remain risks; see [known issues](../known-issues.md).

**First hosted run follow-up (run 41839803978, PR 25).** Linux check and build passed; browser e2e reported 13 failures in six files, with 246 passes and one known native-approval skip. Two failures were additional native-approval sections, now isolated behind the shared platform helper. Four concurrent studiod/Chrome pairs oversubscribed the private two-CPU runner, so CI now runs two e2e files at a time, retaining four locally and the existing timeout budgets. Composer/asset/session-label and activation checks wait for the specific UI state before their original assertions. A failed project-creation check restores the previous project in `finally` so later workspace cases cannot inherit the wrong project. The frame-drag fixture removes unrelated earlier nodes that intercepted its title bar. The model-parameter overflow fixture uses a deliberately smaller viewport and waits for resize layout; the hosted screenshots also revealed missing Chinese glyphs, so a temporary Fontconfig configuration exposes the already-fetched CJK fonts to Linux Chrome without a system-wide installation. No product implementation or permission change was needed; a hosted rerun is required.

**Third hosted run follow-up (run 41851608437, PR merge with main).** Check/build and 34 of 36 e2e files passed; the editor-focus and inbox-refresh fixes held. The board/review case still reached the default 20-second whole-test limit on the two-CPU runner, so the maintainer approved a CI-only 40-second default beside the two-worker setting; local defaults remain 20 seconds/four workers, and assertion waits and explicit per-test budgets are unchanged. The newly merged chapter-adaptation acceptance case now waits for its own fake-Agent completion response before checking two shots. Its transcript cursor distinguishes that response from the identical earlier passage-adaptation reply. The exact shot count, source quote and single-script assertions remain intact; no product code changed beyond merging main, and hosted acceptance remains pending.

**Fourth hosted run follow-up (run 41857094415).** Check and build passed; 34 of 36 e2e files passed, but different files failed again (`library-media`, `previz-panels`). Four runs failed four different sets, so the cause is concurrency on two CPUs rather than individual tests. CI e2e now runs one file at a time.

**Fifth run and first matrix run.** One file at a time turned hosted Linux green (run 41860646714, e2e about 14 minutes), and it passed again on `main`. The first matrix run (41866319065) reached no Windows or macOS tests: `setup-ffmpeg` failed with `Cannot get latest release` on Windows, and `macos-15-intel` got no runner in 15 minutes. Windows now installs `ffmpeg-full` through Chocolatey, and macOS runs on `macos-15` (Apple silicon) with Homebrew's `ffmpeg-full`.

**Second matrix run (41870147163).** Linux passed. `macos-15` again got no runner: GitHub reported capacity constraints, so macOS now runs only on manual dispatch. `windows-2025` ships Visual Studio 18, which node-gyp cannot use to build better-sqlite3, so CI uses `windows-2022`.

**Third matrix run (41874304112).** Linux passed. On `windows-2022`, install and all but one of 2,854 unit tests passed; a gateway permission matrix exceeded the 5 s default, so unit tests get 20 s on CI only. Artifact upload failed because the paths had no common root on Windows, so failure files are now collected into one directory first.

## Appendix: OpenCode notes for a future contributor (2026-11-03, docs only)

- Two incompatible lines: V1 (`opencode-ai` on npm) and V2 (`@opencode/cli`), both installing `opencode`. Pin one major and check `opencode --version`.
- Drive the HTTP server (`opencode serve`; V2 `--standalone` to avoid the user's shared server), not `run --format json`, whose events are undocumented and lossy.
- Inject MCP and instructions through the config override (`OPENCODE_CONFIG_CONTENT` on V1); set `OPENCODE_DISABLE_CLAUDE_CODE=1` and `autoupdate: false`.
- Permissions default to allow; set `ask` for shell, edit and external directories and answer `permission` events through our approval flow. V2 no longer asks for paths outside the project by default.
- Never open `~/.local/share/opencode/auth.json`, `mcp-auth.json` or `opencode.db`, and never call `PUT /auth/:id` or the provider OAuth routes.
- Unverified: V2 endpoint paths, per-message model variant (effort), permission event names per version, V2 config override.

## UI polish (2026-11-05)

English settings consistently call configured generation integrations “services”, use “Model ID”, and give the service Name field the full form width. Internal provider IDs and protocol names are unchanged.

## Model-table parameter notes (RFC 0039 step c, checked 2026-11-08)

The following checks used official documentation pages only, without credentials or generation requests. Bilingual display annotations live on each model schema, and ordinary descriptions remain English. Fake-server tests cover every added or corrected request parameter.

| Adapter | Added or corrected | Deliberately left out |
| --- | --- | --- |
| Volcengine Ark | Seedream 5.0 pro/flash: size 1K/1.5K/2K, or custom dimensions with 921600–4624220 pixels and ratio 1:16–16:1; remove 4K for those models. `outputFormat` maps to `output_format` png/jpeg; `optimizePromptMode` maps to `optimize_prompt_options.mode`, standard/fast on pro and standard only on flash. Video `returnLastFrame` and `executionExpiresAfter` map to `return_last_frame` and `execution_expires_after` (3600–259200 seconds). Seedance 2.0 schemas omit `seed`/`cameraFixed`, now documented only for 1.0. | Layer decomposition returns an unbounded layer collection that the current output handling does not support; background transparency requires alpha-image validation not supplied by this adapter; `frames` conflicts with duration-based billing accounting; `service_tier` is not supported by the registered Seedance 2.0 family. Callback, streaming and response transport settings stay adapter-owned. Existing generic/endpoint schemas retain compatibility ranges. |
| Kling | IMAGE 3.0 Omni `n` corrected from 1–4 to documented 1–9. VIDEO 3.0 duration 3–15, audio native/off, multi_shot true default and 720p/1080p/4k; VIDEO 4.0 duration 3–30 and 720p/1080p remain as documented. | `watermark_info`, elements and media-content structures are objects/arrays; callbacks/external IDs are transport/idempotency mechanisms. Series mode and automatic series count are not exposed; result_type remains single with explicit n. Existing optional 4.0 duration is preserved. |
| OpenAI Images | `n` corrected to documented 1–10; optional moderation auto/low and complexity low/medium/high are sent in JSON and multipart. Existing per-model quality, size, raster output, compression and background settings retained. | GIF/SVG need output/media handling the adapter does not provide; SVG model/reasoning settings are objects. Streaming and partial images need a streaming parser and incur extra billing; masks/markup are file workflows rather than scalar controls. `input_fidelity` is not configurable for the registered GPT Image 2 family. User and response-format fields are transport metadata. |
| Gemini | Image generationConfig seed, temperature 0–2 and topP 0–1 are optional, with vendor defaults. Nano Banana 2.1 and 3.1 Flash Image add 1:4/4:1/1:8/8:1 ratios; only 3.1 Flash Image adds 512px (the docs explicitly exclude 2.1). Pro/legacy/Lite keep their model-specific limits. | Tools/grounding, safety/thinking configuration and response modalities are objects/arrays; topK support depends on per-model metadata not established by the image docs. Candidate count/output-token limits are response-budget controls beyond the current fixed image-output flow. The current Omni duration examples target 1.2; this table still registers 1.1, so its existing aspect/resolution controls are retained without inferring 1.2 support. Video/audio references and editing are separate operations. |
| MiniMax | Rechecked H3/Highspeed/Lite/Max duration and resolution variants, six explicit text-to-video ratios, frame/reference translation, Max prompt expansion modes, image-01 ratios, width/height multiples of eight in 512–2048, n 1–9, seed and prompt_optimizer. No scalar range correction needed. | Reference media/subject entries are arrays/objects; callback and response_format are transport settings. Adaptive ratio is selected by the adapter for frames and cannot be a valid text-only choice. Image aspect/dimension conflict remains explicitly rejected rather than relying on the vendor's precedence rule. |
| DashScope | Wan2.7 images add thinking_mode and width*height strings: 768²–2048² pixels (up to 4096² for pro text-only), ratio 1:8–8:1. Reference inputs reject output above 2048². Wan3.0 seed now accepts -1, matching automatic random seed selection. Existing explicit duration 2–30 and audio/prompt_extend controls retained. | Sequential image sets and model-selected duration make the billed output count/length unknown; color_palette and edit areas are object arrays. Video/audio/file/link references require unsupported input paths. shot_type is documented as ineffective for Wan2.7, so is not exposed. |

Sources, all checked 2026-11-08:

- Ark: https://www.volcengine.com/docs/82379/1541523 and https://www.volcengine.com/docs/82379/1520757
- Kling: https://kling.ai/document-api/api/image/3-0-omni/image-omni and https://kling.ai/document-api/api/video/3-0-omni/text-to-video and https://kling.ai/document-api/api/video/4-0/text-to-video (official documentation's published JS data bundles were read because the page shell contains no parameter text).
- OpenAI: https://developers.openai.com/api/reference/resources/images/methods/generate and https://developers.openai.com/api/reference/resources/images/methods/edit and https://developers.openai.com/api/docs/guides/image-generation
- Gemini: https://ai.google.dev/gemini-api/docs/image-generation and https://ai.google.dev/api/generate-content and https://ai.google.dev/gemini-api/docs/omni
- MiniMax: https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md and https://platform.minimax.io/docs/api-reference/image-generation-t2i.md and https://platform.minimax.io/docs/api-reference/video-generation-v2-query.md
- DashScope: https://www.alibabacloud.com/help/en/model-studio/wan-image-generation-and-editing-api-reference and https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference and https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference

Ark's `returnLastFrame` is an output retrieval option: it returns the last JPEG frame of the existing generated video, without another generation submission or additional video duration. The published video billing formula uses model rate, input/output video duration, dimensions and frame rate, with no last-frame surcharge or billing dimension; this documentation check indicates that requesting the frame does not change billing. Sources: https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh and https://docs.volcengine.com/docs/ark/model-pricing?lang=zh (checked 2026-11-08). The fake-server test checks `return_last_frame: true` in the existing video request; no real billing call was made.

Boolean defaults are explicit where the vendor defaults to on: Wan2.7 image `thinking_mode` and registered Seedance 2.0 `generateAudio` both default to true. This makes their switches match the existing vendor behavior rather than showing an unset boolean as off; fake-server tests cover the default fields as well as explicit off values. Sources: the Ark video and DashScope image references above (checked 2026-11-08).
