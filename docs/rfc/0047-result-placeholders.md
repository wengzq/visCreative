# RFC 0047: Result placeholder nodes

Status: implemented (2026-11-12). Accepted by the maintainer the same day, with decisions 1 and 2. Raised by the maintainer on 2026-11-12 after an Agent run: a video took 2.5 minutes to appear on the canvas, and an image job that failed left no node at all. Revises the `new_node` delivery rule in [RFC 0002](0002-sqlite-storage.md) ("Generation jobs and delivery") and the target contract in [RFC 0003](0003-core-contracts.md).

## Background

A generation output goes to one of two targets. A `slot` target fills an existing node's slot. A `new_node` target creates a node next to `nearNodeId`. The node for a `new_node` target is created only when the output is delivered (`packages/canvas/core/src/delivery.ts`). Until then the job shows only as a "generating" badge on the reference node, or as an unanchored count when there is no reference.

Most generation now uses `new_node`: Agent submissions without targets, the extend actions in the UI, previz and scene generation, and operations such as upscale. In practice this means:

- **Nothing on the canvas says where the result will land.** A video can run for minutes with the only sign being a badge on a different node.
- **The spot is not kept.** Placement runs at delivery, so nodes created in the meantime by the author or an Agent take the free space next to the reference, and the result lands somewhere else.
- **Failures have no node of their own.** A failed or unknown job shows as a problem on the reference node, which reads as if the reference itself were broken. A retry then targets the reference area again instead of the place the author was watching.

The slot path already does everything the author expects from a placeholder: an empty media node shows the generating state on itself, delivery fills it and refits its height, an author edit in the meantime wins (`conflict`), deleting the node keeps the output as an asset (`target_missing`), and failures appear on the node with recheck and regenerate actions.

## Goals

- When a job is submitted with a `new_node` target, its result node appears on the canvas in the same transaction, in the generating state, at the position it will keep.
- The output fills that node on delivery; failure, unknown and missing outputs show on that node.
- Delivery reuses the slot path, so conflict and deletion rules stay the same.
- Nothing changes for callers: `new_node` stays a valid target, and receipts and job views keep `kind: 'new_node'`, now with `nodeId` and `slotId` from the start.

## Out of scope

- Placeholders for slot targets: the node already exists.
- Placing results inside the reference node's frame. Placement keeps the current rule (beside the reference, then searching outward).
- Outputs beyond the requested count, such as a provider returning more images than `n`. They keep the current create-on-delivery path (`runner.ts` `bindingFor`).
- Changing which jobs use `new_node`.

## Product principle check

- **Mechanism, not taste.** Placement and the placeholder's look are mechanism. A placeholder carries the job's own prompt, model and parameters and nothing else.
- **The author's work is protected.** A placeholder is a system-created node and the author can move, resize, retitle or delete it at any time. Anything the author writes into its main slot before delivery wins: the output is kept as an asset and the node is left alone, as for slot targets today.
- **Choosing stays easy.** A failed placeholder keeps its prompt and generation settings, so the author can regenerate from the node or delete it.

## Design

### Submit (`packages/generation/src/submit.ts`)

For each output index that resolves to `new_node` (explicit, or the default when no target is given), the submit transaction now:

1. Creates a node through a new canvas port method, `CanvasDeliveryPort.reservePlaceholder(tx, { bindingId })` (`packages/domain/src/ports.ts`, implemented in `packages/canvas/core/src/delivery.ts`). It reads the binding and its job, so the node gets the job's kind, prompt, generation settings and input links. The port's placeholder methods are optional so test doubles that only deliver keep the old path; the canvas service implements both.
2. Stores the binding as `targetKind: 'new_node'` with `nodeId`, `slotId`, `expectedContentRevision` (the empty main slot's revision, 0) and `createdNodeId` filled in. `placement` keeps `{ nearNodeId }` for history. No schema migration is needed: those columns are already nullable for `new_node`.
3. Sets the placeholder slot's `acceptedBindingId` to this binding, the same as for slot targets.

The node is created with the same rules delivery uses today:

- **Kind** is the job's media kind; `purpose` is `artifact`.
- **Position** comes from `placeNewNode` beside `nearNodeId`, using live node rects at submit time.
- **Size** comes from `defaultNodeSize` with an aspect ratio from the job's parameters when one is present (`ratio` or `aspectRatio` such as `9:16`, `size` such as `1024x1536` or `720*1280`, or numeric `width` and `height`), else the kind's default. Delivery still refits the height to the real asset (`fitNodeToAsset`).
- **Prompt, generation settings and inputs** follow RFC 0039 §1: a plain `generate` job seeds its prompt, provider, model, params and input links; an operation result keeps only its subject link.

Creating the node is a system operation (actor `system`) with no undo entry, the same as delivery today. If submit fails validation, the transaction rolls back and no node is created. An identical retry with the same `requestId` returns the first receipt and creates nothing.

### Delivery (`packages/canvas/core/src/delivery.ts`)

A `new_node` binding that has a `slotId` is delivered exactly like a slot binding: `checkSlotDelivery`, `writeSlotRevision`, `fitNodeToAsset`, then `settle('delivered')`. The outcomes are the existing ones:

| Before delivery | Outcome |
| --- | --- |
| Placeholder untouched, moved, resized or retitled | `delivered` into the placeholder |
| Author wrote media into the main slot | `conflict`: output kept as an asset, node unchanged |
| Placeholder deleted | `target_missing`: output kept as an asset |

A pending `new_node` binding without a `slotId`, created before this change, keeps the old create-on-delivery path. That code can be removed once no such bindings remain.

### Failure, unknown, cancel and missing outputs

- **Failed or unknown:** the placeholder stays empty and shows the job's problem on itself, with recheck when `recheckable` and regenerate. Regenerating maps each result node to a slot target (`service.ts`), so the retry fills the same placeholder. A result node that was deleted, including a placeholder removed on cancel, now gets a fresh placeholder instead of failing with `target_slot_not_found`.
- **Missing outputs** (`succeeded` with `missingOutputIndexes`): each missing index's placeholder stays empty and shows `no_output`.
- **Cancelled:** a direct `generation.cancel` removes an empty placeholder in its transaction (the gateway passes `releasePlaceholders` to `GenerationService.cancel`). One the author wrote into, or one a later job now targets, stays. Recall, stop, work deletion, batch cancel and provider-side cancellation keep it, as Decision 1 explains.

### Views and UI

- `GenerationTarget` views and the `gen_submit` receipt return `nodeId` and `slotId` for `new_node` targets from submit onward. The protocol comment "has nodeId after delivery" changes to "has nodeId once its placeholder exists".
- The store anchors a job's running state and problems on `nodeId` when present, else `nearNodeId` (`apps/web/src/client/store.ts`). The placeholder renders as the existing empty media node (`Empty`) with the generating badge and cancel button; no new component is needed.

### Agent guidance

The `generation` guide says the result node appears at submit and its ID is in the receipt, so an Agent can title it, connect it or put it in a frame right away. To retry a failed job, the Agent targets the placeholder's main slot instead of creating another node. It leaves empty placeholders from failed jobs to the author unless asked to remove them.

## Decisions

1. **Cancelling removes an empty placeholder** (maintainer, 2026-11-12). When the job is cancelled and the placeholder's main slot is still empty, the placeholder is removed in the same transaction (system operation, no undo entry): cancelling says "I don't want this result", and an empty node would only be noise. If the author already wrote into the slot, the node stays. This applies to a direct cancel of that job (`generation.cancel` from the UI or an Agent). Cancellations caused by recall, stop, work deletion, batch cancel or the provider leave the placeholder in place, showing the cancellation: those actions never remove canvas nodes (RFC 0009).
2. **Placeholders are not undoable** (maintainer, 2026-11-12). Creating one adds no undo entry, like delivery: undoing a placeholder while its job runs would turn into `target_missing`, which is surprising.

## Steps

Implemented in one step (2026-11-12): contract and port, submit, delivery, store anchoring, guide text, then tests.

- **Unit:** submit creates one placeholder per `new_node` output and none for slot targets; an identical retry creates none; a validation failure creates none; delivery fills the placeholder; an author write gives `conflict`; deletion gives `target_missing`; cancelling removes an empty placeholder and keeps one the author wrote into; the aspect hint follows `ratio` and `size`; legacy bindings without `slotId` still deliver.
- **e2e:** with a delayed Mock provider, a submitted image shows an empty node in the generating state beside its reference before the job finishes, and the same node holds the image afterwards. A failing Mock job leaves the placeholder with its problem and a working regenerate. Deleting the placeholder mid-run keeps the output as an asset.
