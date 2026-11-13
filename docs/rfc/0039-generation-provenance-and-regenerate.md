# 0039 · Generation provenance in the prompt panel, one-click regenerate, model-owned parameter copy

Status: implemented

Date: 2026-11-08

Builds on [0003](0003-core-contracts.md) (`generation.regenerate`), [0006](0006-web-ui.md) and [0021](0021-node-components.md) (prompt panel, schema-driven parameters) and [0028](0028-agent-and-provider-registries.md) (provider and model registries).

## Background

The maintainer asked for three things on generated images and videos:

1. See the prompt that produced the picture.
2. A regenerate button the author can press directly.
3. Each model's official parameters in the composer, without coupling the model registry to the UI, so a provider can add models easily.

Most of the machinery exists:

- Every generated slot revision already records what made it. `slot.history` returns `SlotVersionView.source = { jobId, prompt, provider, model, params, inputNodeIds }` (`protocol/src/canvas.ts:42`). The only UI that reads it is the version tooltip, which shows the first 60 characters of the prompt (`canvas/ui/src/versions.ts:27`).
- `generation.regenerate { requestId, jobId }` reruns a terminal job with its original provider, model, params, prompt, pinned inputs and targets, and delivers to the same slot as a new revision (0003). The UI exposes it only in the context menu ("再来一版") and the failed-job banner.
- The prompt panel's parameter row is generated from each model's `paramsSchema` (0021): `ParamsSummary.tsx`, `params.ts`. Adding a model with a schema needs no UI change.

What is missing:

- **Agent-generated nodes have an empty prompt panel.** When a job targets a new node, delivery creates the node with only its media slot (`canvas/core/src/delivery.ts:49`). The node has no prompt slot, no `inputs` and no `generation` choice, so selecting it shows an empty composer even though the version record holds the full prompt. This is the case the maintainer hit.
- **A node's prompt can drift from its picture.** If the prompt slot or the model choice changed after the last generation, the panel shows the new draft, and nothing says the current picture came from something else.
- **No regenerate on the node.** The toolbar has no regenerate entry, and the context menu is easy to miss.
- **Parameter copy is owned by the UI.** Labels live in a hard-coded dictionary in `canvas/ui/src/messages.ts:412` keyed by parameter name. Descriptions arrive in Chinese from Ark's schema and are translated by a second dictionary keyed by the Chinese sentence (`messages.ts:500`). A new parameter such as Wan3.0's `audio` or `prompt_extend` shows as its raw key, and a provider cannot add one without editing canvas UI.

The maintainer's reference screenshot (another product's composer) shows the composer docked under the selected picture with the prompt, model, ratio and size. We take the interaction, not the look.

## Decisions (maintainer, 2026-11-08)

- Provenance is shown by **reusing the bottom prompt panel**, not a separate popover or side panel.
- **Regenerate delivers a new version into the same node.** Earlier versions stay in history, as with "再来一版" today.

## Design

### 1. Seed new nodes from their job

When delivery creates a node for a job, it also writes, in the same transaction:

- a `prompt` slot holding the job's **raw** prompt (with `{{ref:nodeId}}` markers, not the resolved text), written by `system`;
- `inputs` = the job's `inputNodeIds` that still exist;
- `generation` = `{ provider, model, params }` of the job, with params narrowed to the model's schema keys.

This only applies to nodes that delivery creates. Delivery never writes the prompt slot, inputs or generation choice of an existing node: those are the author's (product principle). A regenerate of a seeded node targets its slot, so seeding happens once.

Older nodes created before this change have no prompt slot. The panel falls back to the current revision's `source` for them (next section) and does not backfill storage.

### 2. The prompt panel shows the current version's provenance

**Which prompt is "the" prompt (maintainer, 2026-11-08): the one the generation really used.** A job holds up to four texts:

| Text | Where it lives today | Shown |
|---|---|---|
| Authored prompt, with `{{ref:nodeId}}` markers | `params.prompt` | Only as the text **Restore** writes back, because it keeps the reference links |
| Resolved prompt, markers replaced by "Image 1" … | `params.resolvedPrompt` | Fallback |
| Sent prompt, after the adapter's `prepareRequest` (for example DashScope folds extra text inputs in) | `params.actualPrompt` (`runner.ts:253`) | Fallback |
| Vendor-rewritten prompt, when the vendor extends or rewrites it and returns the result | not stored | **Preferred when present** |

The panel's provenance view shows the most real one available: vendor-rewritten → sent → resolved → authored, labelled with which it is ("Prompt the model used", "Prompt sent"). **Copy prompt** copies that same text.

To make the first row real, `ProviderTaskState` for `succeeded` gains an optional `revisedPrompt: string` (bounded, redacted like error messages). An adapter fills it only from a field the vendor documents as the prompt it actually used; the runner stores it as `params.revisedPrompt` on the job. Which vendors return one is checked against current documentation in step c (candidates: DashScope with `prompt_extend`, OpenAI image models that return `revised_prompt`); vendors that return nothing simply fall back to the sent prompt. `SlotVersionView.source` gains `usedPrompt: string` (the chosen text) and `usedPromptKind: 'revised' | 'sent' | 'resolved' | 'authored'`; `prompt` keeps meaning the authored text.

**What the panel does.** The prompt box in the panel is the node's editable draft for the *next* generation. The picture on screen came from a past generation. The two can differ, and the panel makes that visible. When the selected node's current media revision has a `source`, the panel reads it through `slot.history` (one call per selection, cached by slot and revision) and compares the authored prompt, provider, model, params and inputs with the draft:

- **Same:** nothing extra; the draft is what made the picture. A small **Prompt the model used** disclosure under the box shows the used prompt when it differs from the draft text (for example after vendor rewriting).
- **Draft empty** (old nodes, created before §1): the box shows the version's used prompt and settings greyed out, read-only, with one button, **Restore this version's settings**.
- **Different** (the author edited the prompt or switched model after generating): a one-line notice above the footer, "The picture on screen was made with different settings", with **Show** (expands the used prompt, model and parameter summary read-only, plus **Copy prompt**) and **Restore this version's settings**.

**Restore this version's settings** copies that version's authored prompt (with its reference links), model, parameters and references back into the draft, replacing what is there. It asks first if the draft has text that differs. It does not generate anything; the author then edits and presses send, or just presses send. The write is the author's action and goes through the normal `expectedRevision` path.

The source's references are shown as the same numbered thumbnails as the reference strip. A reference node that no longer exists shows as a placeholder; Restore drops it.

Videos and audio get the same behavior; the panel is shared.

Sending from the panel stays what it is: `generation.submit` with a fresh `requestId`, the draft prompt, choice and inputs, targeting the node's main slot. So "edit and regenerate" is simply: change the draft, press send. The result is a new version of the same node.

### 3. Regenerate on the node toolbar

The single-node toolbar (`NodeOperationsToolbar.tsx`) gets a **Regenerate** entry for media nodes whose current revision has a `source.jobId`, hidden while a job for the node is active. It calls the existing `generation.regenerate` with a fresh `requestId` per press: exact same settings as the version on screen, regardless of the panel draft. The context-menu item stays.

Regenerate is a UI-only, author-initiated paid action. It keeps today's rules: UI submissions are exempt from the Agent quota (0012), an `unknown` source job asks for confirmation first (`actions.ts:470`), and a double press cannot submit twice because the button disables until the receipt returns.

Tooltip states what will happen: "Regenerate with the same prompt and settings (new version)".

### 4. Parameter copy belongs to the model

Each adapter's parameter schema carries its own display copy through JSON Schema annotations, emitted by zod `.meta()` and passed through `providers.list` unchanged:

```ts
resolution: z.enum(['480P', '720P', '1080P']).default('1080P').meta({
  'x-vis-label': { zh: '分辨率', en: 'Resolution' },
  'x-vis-description': { zh: '输出视频分辨率', en: 'Output video resolution' },
  'x-vis-options': { '480P': { zh: '480P', en: '480P' } },   // only when a value needs a readable name
}),
```

- `packages/protocol` defines `ParamCopy` (the three optional keys, each a `{ zh, en }` record) so the UI parses them with one schema. `paramsSchema` stays a JSON Schema record; this adds no new method.
- The UI resolves a field's label as: `x-vis-label` for the current locale → the existing `parameterLabel` dictionary (kept as a fallback for older schemas) → `title` → the raw key. Descriptions and option names resolve the same way.
- Plain `description` stays English and Agent-facing: Agents read the schema through capabilities and need no Chinese copy. Ark's Chinese descriptions move into `x-vis-description`; the sentence-keyed translation dictionary is deleted.
- Every built-in adapter (Ark, Kling, OpenAI, Gemini, MiniMax, DashScope) annotates every exposed field. A contract test walks each registry model's schema and fails if a field lacks `x-vis-label` in both languages, so a new model cannot ship with raw keys.

Adding a model therefore stays one edit in the provider's own `models.ts`. A new parameter is one field with its copy beside it.

**Official parameters.** As part of the same step each adapter's tables are checked against the vendor's current documentation, and any documented parameter that fits the schema shapes the panel supports (string, number, integer, boolean, enums) is exposed. Shapes the panel cannot render (arrays, objects) stay out, as today; the RFC records which.

## Not in scope

- A cost or credit display in the composer.
- Declaring reference-image limits in `providers.list` (they stay a server-side check).
- Changing `generation.regenerate` to accept edited params: editing goes through the panel and `generation.submit`.
- Backfilling prompt slots of existing nodes.

## Steps

- **a. Seeding and provenance** (`protocol` `SlotVersionView.source.usedPrompt`, `generation` `revisedPrompt` in task state and runner, `canvas/core` delivery and views, `canvas/ui` prompt panel, messages): §1 and §2, with unit tests for delivery seeding (new node only, existing node untouched, raw prompt with markers, missing reference nodes dropped) and e2e: an Agent-generated image shows its prompt when selected; editing the prompt shows the "different settings" notice; **Restore this version's settings** restores it; the provenance view shows the sent prompt, or the mock provider's `revisedPrompt` when it returns one.

  **Implementation notes (step a, 2026-11-08).** New-node delivery seeds the authored prompt (markers intact), surviving ordered job input nodes and provider/model settings in the delivery transaction and its creation event; an empty prompt adds no prompt slot. Existing-node delivery changes none of those draft fields. Provider-only settings exclude all prompt variants, frame references and provider configuration. History selects revised → sent → resolved → authored, retaining the separate authored text and excluding internal fields from visible parameters. The runner stores a returned vendor rewrite after trimming and limiting it to 20,000 characters, including during finalization recovery, and removes previous used-prompt fields from regenerate jobs and provider requests. The mock accepts an optional `revisedPrompt` fixture without changing its default behavior.

  The shared prompt panel uses the existing slot/revision history cache, including its revision-triggered refresh, to show provenance for the displayed media version. Only delivered asset revisions carry job provenance; the seeded text slot does not inherit it through the shared operation. The panel compares the authored draft, model choice, parameters and ordered inputs; disclosures display and copy the used text, with bounded scrolling overlays that keep the footer in place. Panel placement keeps canvas controls, version controls, node titles and connection buttons reachable; the draft panel temporarily hides during canvas reference picking so it cannot cover a target. Legacy nodes show read-only provenance without a storage backfill. Restore is an atomic author `canvas.apply` batch, preserves authored markers, replaces settings and drops missing/self references, and never submits generation. Differing nonempty draft text requires the localized Replace/Cancel dialog.

  One contract extension was required for legacy Restore: `node.setPrompt { nodeId, body, expectedRevision }` creates a missing media prompt slot only when the expected revision is zero and otherwise checks the existing revision. This operation is UI-only, rejected by the gateway for Agent callers, and omitted from Agent capability schemas; existing Agent prompt writes remain available through their prior paths. Creation emits a full node update as well as the slot revision so subscribed clients see the new slot. Undo clears the created prompt slot and redo restores its text using ordinary slot history, retaining the empty slot rather than deleting its identity. Unit coverage checks seeding, fallback precedence, rewrite bounds and request stripping, authorization, optimistic conflicts and undo/redo; browser coverage exercises fake-Agent MCP generation, drift and confirmed restore, rewrite copying and cache refresh, existing-node protection and legacy restoration.

- **b. Toolbar regenerate** (`canvas/ui` toolbar, `apps/web` actions): §3, e2e with the mock provider: press Regenerate, a second version appears in the same node, the old one is in history.

  **Implementation notes (step b, 2026-11-08).** The single selected media node's toolbar reads the displayed version's job provenance, including a selected historical version. Its bilingual Regenerate button is absent without a source job or while generation for the node is queued, running or finalizing. A synchronous click guard and pending disabled state cover the confirmation and submission through the receipt or error; the shared client job-action path retains unknown-result confirmation, localized errors and fresh request IDs for subsequent presses. Regenerate uses the displayed source even when the editable draft differs, preserving the draft and earlier versions.

  `generation.regenerate` now accepts optional `targetNodeId`. When present, it validates a live node of the original job's media kind with an active main slot, creates only output index zero targeting that slot at its current revision, and reduces a stored `n > 1` to `n: 1`. All other original settings, pinned inputs, frames, provider configuration and model are retained through the existing regenerate path. Without the field, all original binding behavior remains unchanged. The method remains UI-only and idempotent by `requestId`; Agent quota logic is unchanged. Missing/deleted nodes, kind mismatches and unavailable main slots return specific localized `invalid_params` reasons. Error reason translations live in `packages/ui-kit`, so the coordinator approved that correction to the step's file scope.

  Unit coverage checks the optional contract and Agent capability exclusion, all three media kinds, count reduction and sibling binding preservation, pinned inputs/frames, invalid targets, idempotent receipts, toolbar visibility and both locales, confirmation, pending-action deduplication and retry after errors. Mock-only browser coverage checks panel generation followed by toolbar regeneration, draft preservation, reachable history and regeneration of a historical version, double-click suppression while a request is held, active-job hiding, a single-node retry from three outputs, dismissed unknown-result confirmation and the locale switch. No paid provider or real Agent is used.

  Full-suite verification exposed a clamped-toolbar collision: the added button made a generated video's bar too wide to fit beside the fixed canvas header, so the previous fallback covered its own video and intercepted hover. With coordinator-approved scope, shared floating-toolbar placement now chooses the nearest available position clear of fixed controls, its anchor card/title and the version strip, preferring the least overlap only when no clear candidate fits. Two geometry tests cover the header/card/strip case and a canvas with no room below. Existing browser assertions are unchanged.

- **c. Parameter copy** (`protocol`, every adapter's `models.ts`, `canvas/ui/src/params.ts`, messages): §4 including the contract test, the per-vendor parameter check, and filling `revisedPrompt` in the adapters whose vendor documents a used-prompt field.

a and c can run in parallel with a file split: a owns `protocol/src/canvas.ts`, `generation/src/types.ts` and `runner.ts` (it adds `revisedPrompt` to the contract first and lands that commit early); c owns `protocol/src/providers.ts` and the adapter directories, and fills `revisedPrompt` once a's contract commit is merged. b follows a because both change the selected-node UI.

## Resolved

- 2026-11-08: show the prompt the generation really used, including the vendor's rewritten prompt where the vendor returns it (§2).
- 2026-11-08: **Restore this version's settings** replaces the node's references with the version's, after the same confirm as the prompt.

## Implementation notes (step c, 2026-11-08)

- `ParamCopy` validates optional bilingual `x-vis-label`, `x-vis-description` and value-keyed `x-vis-options`. Every exposed built-in parameter has non-empty labels. UI parsing discards malformed annotations individually, then resolves schema copy before the legacy parameter/option dictionaries, titles and raw values. The sentence-keyed description dictionary and unused image-mode dictionary are removed. Plain Ark/mock descriptions are English.
- Zod's `toJSONSchema({ io: 'input', unrepresentable: 'any' })` preserves custom `.meta()` properties through optional/default wrappers and a field-level `anyOf`; the contract suite verifies both wrapper orders and the union. No adapter post-processing is needed. Ark's model schemas now live in its own `models.ts`, with its existing exports preserved from `index.ts`. Render annotates its adapter schema derived from the shared protocol schema.
- The contract suite creates every registered adapter without reading a key, walks each declared model and kind plus mock/render and Ark's capability table/custom endpoints, and validates every exposed property. It rejects missing bilingual labels, unsupported option values and Chinese plain descriptions. Negative tests exercise a missing label and an option outside its enum. Component tests cover Wan3.0's audio/prompt extension names in both locales, descriptions, precedence and malformed-copy fallbacks. The locale e2e case transports actual Ark/Wan schema annotations through a mock catalog and switches between English and Chinese without submitting generation.
- Official documentation was checked on 2026-11-08 without authenticated calls. Parameter changes and exclusions are recorded in RFC 0028's model-table notes. Added controls include Ark image output/optimization and video last-frame/expiry settings, OpenAI moderation/planning complexity, Gemini image sampling controls/expanded ratios/512px where supported, and DashScope image thinking/custom dimensions and Wan3.0's random-seed sentinel. Corrected Seedream pro/flash dimensions and removed unsupported Seedance 2.0 seed/fixed-camera controls; OpenAI/Kling image counts follow the documented bounds. Existing model-selected-duration paths are retained; no new such path is introduced.
- Used-prompt findings are reported for integration, with no task-contract changes here: DashScope Wan2.7 documents `output.actual_prompt`; Wan3.0 only documents `output.orig_prompt`. OpenAI's Images reference says `data[].revised_prompt` is not returned by GPT Image models; the Responses guide's `image_generation_call.revised_prompt` belongs to a different API. MiniMax documents `task.content.prompt` only for a separate `h3_context_ir` task, not these video generation jobs. No documented used-prompt response was found for Ark, Kling or Gemini. The coordinator owns any task-contract integration.
- Integration (2026-11-08): the DashScope adapter returns `output.actual_prompt` as `revisedPrompt` for video tasks only, redacted and trimmed; blank or non-string values are ignored. Wan3.0's `orig_prompt` is the author's input, not a rewrite, so it is not used. No other adapter fills `revisedPrompt`; those versions show the sent prompt.
- Review fixes (2026-11-08): seeding applies to plain `generate` jobs only; a new node from a media operation keeps just its subject link, so its Generate never reuses an operation-only model. The "different settings" check fills the model's schema defaults on both sides and compares inputs with what Restore would write (deleted and self references dropped), so sparse saved choices and restored drafts no longer read as different. A legacy node's panel mounts only once its version provenance is loaded, so it is never shown locked without Restore. Only a vendor rewrite is labelled as the prompt the model used; other kinds read as the prompt sent. Provenance parameters use the schema's bilingual labels and option names. Panel placement runs once per animation frame and skips off-screen cards.
