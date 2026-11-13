# 0040 · Generation operations open the panel: choose model, settings and prompt before submitting

Status: implemented

Date: 2026-11-08

Builds on [0021](0021-node-components.md) (operation catalog, node toolbar, prompt panel), [0028](0028-agent-and-provider-registries.md) (provider and model registries) and [0039](0039-generation-provenance-and-regenerate.md) (provenance, toolbar Regenerate, model-owned parameter copy).

## Background

The maintainer's principle (2026-11-08): every generation step lets the author see the prompt, and change the model, its settings and the prompt in the node before submitting. Plain generation does this since 0039. The toolbar's generation operations (`image.upscale`, `image.outpaint`, `image.matting`, `image.multiview`, `video.upscale`, `video.removeSubtitles`, `video.reshoot`) do not:

- One click submits at once (`CanvasView.tsx` → `actions.onRunOperation(nodeId, operation)`); `operationChoice` (`apps/web/src/client/operations.ts`) silently picks the node's model or the first model that declares the operation. The author never chooses the model, never sees settings, and cannot write a prompt, even for outpaint or reshoot, where the prompt is the point.
- A model declares operations only by name (`operationsFor`). Their parameters are validated against the model's *generate* schema (`submit.ts`, `paramsSchemaOf`), which is wrong: an upscale factor or an outpaint ratio is not a generate setting.
- Today only the mock provider declares operations, so no author has hit this yet. It has to be settled before the first real adapter declares one.

The operation buttons stay (maintainer, 2026-11-08). What changes is what a click does.

## Decisions (maintainer, 2026-11-08)

- Clicking a generation operation opens the bottom panel for that operation instead of submitting.
- The author picks from the generation models that are configured and declare this operation.
- The operation buttons stay on the toolbar.

## Design

### 1. Each operation is declared with its own parameters and prompt rule

A model's declaration grows from a list of names to a per-operation description. In `ProviderAdapter`:

```ts
operationsFor?(kind, model): readonly GenerationOperation[]            // unchanged
operationSpecFor?(kind, model, operation): {
  paramsSchema: z.ZodType<Record<string, unknown>>                    // the operation's own settings
  prompt: 'none' | 'optional' | 'required'
} | undefined
```

- `generate` keeps using `paramsSchemaOf` and a required prompt; `operationSpecFor` is not consulted for it.
- An operation without a spec has no settings and `prompt: 'none'`.
- `providers.list` exposes, per model, `operationSpecs?: Partial<Record<GenerationOperation, { paramsSchema: JSONSchema, prompt }>>` beside `operations`, serialized like `paramsSchema` (`toJSONSchema({ io: 'input', unrepresentable: 'any' })`), so 0039 §4 annotations (`x-vis-label`, `x-vis-description`, `x-vis-options`) work unchanged.
- `generation.submit` with a non-`generate` operation validates `params` against that operation's schema and checks the prompt rule (`required` and empty → `invalid_params` `generation.prompt_required`, `none` and non-empty → `generation.prompt_unsupported`), before any quota is taken. The contract test of 0039 §4 is extended to walk every declared operation spec.
- Agents read the same specs through `providers.list`, so they submit valid operation settings too. Agent permissions do not change.

Adding an operation to a model is one entry in that adapter's `models.ts`; the canvas UI does not change.

### 2. The panel in operation mode

A click on a generation operation puts the selected node's bottom panel into **operation mode** (the same panel component, not a new dialog):

- Header: the operation name with the paid-operation marker used on the toolbar, and a close button that returns to the normal draft. `Escape` does the same. Leaving loses nothing: the node's own draft is untouched.
- Subject: the node's current main version, shown as reference 1 and fixed.
- Model: a list of the configured providers' models for this media kind that declare the operation (`operations` includes it), in catalog order. A model whose provider has no key is listed as unconfigured, as the model picker does today, and cannot submit. Preselected: the model used last time for this operation in this project (stored in the browser like the composer's last choice), else the node's model if it declares the operation, else the first listed model. No choice is ever made silently: the selected model is always visible before submit.
- Settings: the selected model's operation `paramsSchema`, with the existing schema controls and parameter summary.
- Prompt: shown only when the spec's `prompt` is `optional` or `required`; empty by default. Reference markers work as in generate.
- Submit: labelled with the operation name, disabled until the prompt rule is met. One press sends one `generation.submit` with a fresh `requestId` and the button disables until the receipt returns. The result is still a new node beside the original (0021 §4).
- When no configured model declares the operation, the toolbar does not show it (0021 rule, unchanged).

The operation's model and settings are never written into the node's `generation` choice: they belong to that operation, not to the node's draft.

### 3. Results: provenance, Regenerate, no seeding

- A new node from an operation keeps only its link to the subject. It gets no prompt slot or generation choice (as fixed in 0039's review), so its own Generate never reuses an operation-only model.
- Its prompt panel shows the version's provenance read-only: operation, model, settings, prompt if any, subject. **Restore this version's settings** is hidden for operation versions, because restoring them into a generate draft would mix two different schemas.
- The 0039 toolbar **Regenerate** works for operation versions: it repeats the same operation, model, settings and prompt on the same subject revision (`generation.regenerate` already keeps `operation`).

### 4. Mock

The mock model declares specs for every operation so the panel and validation can be tested: for example `image.upscale` `{ scale: 2 | 4 }` with `prompt: 'none'`, `image.outpaint` `{ ratio }` with `prompt: 'optional'`, `video.reshoot` with `prompt: 'required'`. Labels in both languages.

## Not in scope

- Declaring operations on real adapters. Each vendor's operation (for example a Wan or Kling outpaint/upscale endpoint) is added later in its own adapter with a fake-server test, without UI changes.
- Extra reference inputs for operations beyond the subject.
- Batch operations over several selected nodes.

## Resolved

- 2026-11-08: no one-click shortcut. Every generation operation goes through the panel; operations are paid, and a visible confirm step keeps the decision with the author.

## Steps

- **a. Contract and generation** (`protocol` providers and generation schemas, `generation` types/submit/mock, `studiod` providers.list): §1 and §4, unit and contract tests.

  **Implementation notes (step a, 2026-11-08).** `operationSpecOf` centralizes the strict empty-settings/no-prompt default for operations without a spec; generate keeps its existing schema and prompt contract without consulting the adapter's operation spec hook. The catalog emits `operationSpecs` only for declared non-generate operations and preserves input JSON Schema defaults and bilingual display annotations. The protocol rejects specs for generate or undeclared operations, and Agent submit documentation points to the catalog.

  Submit validates operation settings and required/unsupported prompts before quota checks or job writes, ignores saved generate-draft parameters for operations, and preserves previously validated operation settings, prompts and pinned subjects on regenerate without consulting a changed spec. The mock declares all seven specs, including default scale, ratio, view count and reshoot duration, while retaining its watermarked image/video placeholder output. Unit and contract coverage checks defaults, strict settings, prompt rules before global and exhausted local quotas, unchanged generate/regenerate behavior, annotation serialization and missing-label rejection across declared operation schemas.

  The panel and toolbar behavior remain for step b. The existing direct toolbar router returns only its selected provider/model, because its previous generate-draft parameters would fail the operation schema; submit fills the operation defaults. Direct mock upscale still accepts empty settings and prompt; reshoot now requires a prompt as declared. The only gateway fixture change uses outpaint with ratio settings so its existing prompt-reference/history assertions remain meaningful. No real adapters gain operations in this step.

- **b. Panel** (`canvas/ui` panel operation mode and toolbar wiring, `apps/web` actions replacing `onRunOperation`/`operationChoice`, messages): §2 and §3, e2e with the mock: click outpaint → panel with model list, settings and prompt → submit → new node beside the subject; prompt `required` blocks submit; close keeps the draft; Regenerate on the result repeats the operation.

  **Implementation notes (step b, 2026-11-08).** Generation toolbar entries open the selected node's existing bottom prompt panel in operation mode, including Shift-click. The operation composer keeps its prompt, model and settings locally, lists declaring models in catalog order (including unconfigured entries), uses each operation's schema and bilingual annotations, and saves a choice under a project-and-operation browser key only after a successful submission. Close, Escape and deselection return to the normal draft. Local processing retains its existing paths.

  Submission now takes an explicit operation choice, parameters and prompt rather than silently routing to a model. It rereads and pins the subject's current main revision, targets a new node beside it, and changes no subject draft fields. A synchronous panel guard and host receipt guard coalesce rapid presses while the request is pending; errors follow the existing notice path. Toolbar operations require a usable configured provider, while unconfigured alternatives remain visible in the operation model picker.

  History includes `source.operation` only for non-generate jobs. Operation provenance is read-only, renders settings from the operation schema, hides Restore and skips comparison with the Generate draft. Unseeded operation results mount their panel when provenance loads and expose an empty, editable normal Generate draft; its prompt slot is created only when the author commits text. Toolbar Regenerate still repeats the original operation and subject revision into the result node. The existing mock toolbar e2e now confirms through the panel, and the legacy empty-prompt operation Restore case now verifies read-only provenance and a separate usable Generate draft. No real adapters, paid calls, dependencies or storage migrations are added.

  A pre-existing scene-link browser unit assertion now waits for React's asynchronous fixture replacement before checking that no Update button exists. Bundle probes reproduced its stale previous-fixture button on both the base and step-b sources; its picture and event assertions are unchanged.

b follows a.
