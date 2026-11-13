# RFC 0044: Scene change proposals

Status: accepted (maintainer, 2026-11-11), with the decisions at the end. Extends [RFC 0037 step d](0037-interactive-scene-nodes.md#step-d-agents).

## Background

RFC 0037 step d protects scene objects and views that the author made or touched: an Agent write that changes one is refused with `scene.object_protected` or `scene.view_protected`, and the Agent describes the change in its session for the author to make by hand.

Manual acceptance on 2026-11-11 confirmed the rule works: after the author moved a Codex-built bench, Codex could no longer move it and said so. It also showed the gap. Agreeing to the Agent's suggestion means redoing it by hand, reading numbers out of a chat message into the inspector. For a pose or a camera move with several keys, that is impractical.

Manuscripts already solved the same problem: `text.propose` (RFC 0031) stores an Agent's edits as a proposal, and the writer accepts or rejects each edit; acceptance is a user write. This RFC gives scenes the same mechanism.

## Goals

- An Agent can propose changes to protected objects, views and the scene duration instead of only describing them.
- The author sees each proposed change, can preview it in the viewport, and accepts or rejects it per item.
- Acceptance is the author's write: it goes through the same stamping as an editor save, so the item stays protected afterwards.
- A proposal never applies to something it was not made against: if the author changes the item first, the change goes stale.

## Out of scope

- Proposals for items the Agent may already change directly. Those stay direct writes, as in step d.
- Deleting a scene node, `panel.blockout` and `sceneRef`. They stay user-only.
- A per-object "let Agents edit this" release. Considered and rejected below.
- Notifying the Agent's session when the author resolves a proposal (see Decisions).

## Product principle check

- **The author's work is protected.** Nothing in a scene the author made or touched changes without the author's click. The gateway enforces it: `scene.proposal.resolve` is UI-only, and no session approval mode, auto-accept of vis tool confirmations or session-wide grant can call it.
- **Agents propose, the author decides.** This turns the existing "describe it in the session" instruction into a reviewable form. It adds no opinion about what a good scene is.
- **Choosing stays easy.** A proposal can be accepted in the chat where the Agent mentions it, and previewed where the work is, in the scene editor's viewport.

## Alternative considered: release an object to Agents

The author could clear an object's `userTouched` flag ("let Agents edit this"), after which the Agent changes it directly. It is simpler, but it hands over every future change rather than one, so a later turn can change the object without asking. Per-change approval matches what the author is actually agreeing to. A release toggle can still be added later on top of this RFC if authors ask for it.

## Design

### Contract

New in `packages/protocol/src/scene.ts`:

```ts
type SceneChange =
  | { changeId: string; target: 'object'; id: string; action: 'update'; item: SceneObjectContent; base: SceneObjectContent }
  | { changeId: string; target: 'object'; id: string; action: 'delete'; base: SceneObjectContent }
  | { changeId: string; target: 'view'; id: string; action: 'update'; item: SceneViewContent; base: SceneViewContent }
  | { changeId: string; target: 'view'; id: string; action: 'delete'; base: SceneViewContent }
  | { changeId: string; target: 'duration'; durationS: number | null; base: number | null }
// plus status: 'pending' | 'accepted' | 'rejected' | 'stale' | 'superseded'

type SceneProposal = {
  proposalId: string; nodeId: string; slotId: string; baseRevision: number; sessionId: string
  summary: string; changes: SceneChange[]; status: 'open' | 'resolved'; createdAt: number
}
```

- `SceneObjectContent` is `SceneObject` without `createdBy` and `userTouched`. `SceneViewContent` is `SceneView` without those and without `still`. This is the content RFC 0037 compares, so a proposal can never carry ownership flags or a still.
- `base` is the item's content when the proposal was made. The server fills it in; the Agent does not send it.
- Changes target existing items only. New objects and views are direct writes, as today. A change may target an item the Agent could change directly; that is allowed so one proposal can keep related edits together (the bench and the figure sitting on it), and acceptance stamps all of them as touched.
- At most one change per item, and at most one duration change, per proposal.

Methods, registered in `methods.ts`:

| Method | Callers | Purpose |
|---|---|---|
| `scene.propose` | agent | `requestId`, `slotId`, `baseRevision`, `summary` (1–2000), `changes` (1–97: up to 64 objects, 32 views and the duration). Returns the `SceneProposal`. |
| `scene.proposal.list` | both | Optional `slotId`, `status` `open` / `resolved` / `all` (default `open`). |
| `scene.proposal.resolve` | ui | `requestId`, `slotId`, `action` `accept` / `reject`, `changes` (refs `{ proposalId, changeId }`). Accept also takes `expectedRevision`. |

New event `scene.proposalChanged` with payload `{ proposalId, slotId }`, deduplicated by `seq` like `text.proposalChanged`.

Errors (reasons get both locales in `error-messages.ts`):

- `scene.change_target_missing`: an `update` or `delete` names an ID that is not in the scene.
- `scene.change_duplicate`: two changes in one proposal target the same item, or there are two duration changes.
- `scene.change_id_mismatch`: update content must retain the target ID.
- `scene.change_noop`: the proposed content equals the current content.
- `scene.change_invalid`: applying every change of the proposal to the current document fails `SceneDoc` validation, for example a key past the end.
- `scene.change_not_pending`, `scene.change_stale`: on resolve, as for text.
- `scene.proposals_full`: more than 20 open proposals on one scene slot.

### Proposing

`scene.propose` follows `text.propose`:

- Same caller rules as an Agent `scene.set`: a linked, unarchived session and the work-item relationships the gateway already checks for canvas writes.
- `baseRevision` must equal the slot's current revision; otherwise `revision_conflict`, and the Agent rereads.
- The server validates the whole proposal against the current document, stores it in `space.db` (new `scene_proposals` table, generated migration), records each change's `base`, and emits `scene.proposalChanged`. Idempotent by `requestId`.
- **Superseding.** A new proposal from any session that targets an item with a pending change marks that older change `superseded`. "Move it a bit further left" therefore replaces the earlier proposal instead of stacking a second one.

### Staleness

A pending change goes stale when its item no longer matches `base`: the author edited or deleted it, or another accepted proposal changed it. A duration change goes stale when `durationS` differs from its `base`. Unrelated edits elsewhere in the scene do not stale it, which is why staleness is per item and not per slot revision.

A `refreshSceneProposals(tx)` step runs inside every canvas mutation, including undo and redo, beside `refreshTextProposals`. Staleness is permanent: undoing the author's edit does not revive a change, matching RFC 0031. Deleting the scene node resolves its open proposals as stale.

### Accepting and rejecting

- **Reject** writes metadata only.
- **Accept** takes the selected pending changes, checks `expectedRevision`, applies them to the current document in proposal order, and validates the result. It then commits a user `scene.set` through `stampUserScene`, updates change states and emits events, all in one SQLite transaction. A failure rolls everything back. Identical retries replay.
- The server computes the new document. The editor does not send one, unlike text acceptance, because a scene change replaces whole items and has no anchor to verify. Before calling accept, the editor flushes its draft (`draft.flush()`) so the author's unsaved edits are saved first. If those edits touched a proposed item, the change goes stale and accept is disabled for it.
- Accepting changes in several proposals at once is allowed. The combined result must validate; otherwise `scene.change_invalid`, and the author accepts them one at a time.
- Acceptance is an ordinary revision, so editor undo and canvas undo reverse it.
- A proposal becomes `resolved` when no change in it is pending.

### UI

- **Scene editor.** A Proposals section in the inspector lists open proposals: the summary, the session's name and, for each change, a line naming the item and what differs, for example "Bench: position, 2 keys". It offers Accept and Reject per change, plus Accept all and Reject all per proposal. Stale and superseded changes show their state and can only be dismissed. The section header shows the pending count.
- **Preview.** Hovering or focusing a change, or pressing Preview, shows the scene at the playhead with that proposal's pending changes applied. Changed items are outlined in the viewport. Preview is read-only and leaves the draft untouched; any edit or Escape ends it. Under `prefers-reduced-motion` there is no transition into or out of preview.
- **Session card** (maintainer decision, 2026-11-11). The proposal also appears in the chat, as a card under the Agent's `scene.propose` call, following the skill draft card (RFC 0033). The card is built from the tool result, which carries the `SceneProposal` as a structured `sceneProposal` field. It reads the proposal's current state through `scene.proposal.list` and refreshes on `scene.proposalChanged`, so a decision made in the editor shows in the chat and the other way round. It shows the summary, one line per change with its state, Accept all, Reject all, and **Open in scene editor**, which opens the editor with that proposal in preview. Accepting one change at a time and previewing happen in the editor. A 3D change needs the viewport to judge, and the chat card is for the common case, where the author already knows from the conversation what they asked for.
- Before accepting from the chat, the host flushes the scene editor's draft if that scene is open, so the editor's unsaved edits are saved first, exactly as with Accept in the editor.
- **Canvas card.** The scene card shows a pending-proposal count, as manuscript cards do. The canvas reads proposal counts through the host cache, without importing scene-ui.
- All copy lives in `messages.ts`, in Chinese and English.

### Agent guide

The `scene` guide's protection paragraph changes from "describe the proposed change in the session" to: on `scene.object_protected`, `scene.view_protected` or `scene.duration_protected`, call `scene.propose` with the intended content and a one-sentence summary, tell the author a proposal is waiting in the scene editor, and do not retry the write. Agents still never change flags, replace IDs or delete the scene to get around protection. The refusal errors gain a `details.hint` naming `scene.propose`, so an Agent that skipped the guide still finds the path.

## Steps

- **a. Contract, storage and service.** Schemas, method registration, migration, `scene-proposals.ts` in studiod, refresh in canvas mutations, gateway routing, error reasons. Unit tests for propose validation, superseding, per-item staleness, permanent staleness after undo, atomic accept, replay, and refusal of `scene.proposal.resolve` from an Agent caller and from auto-approval.
- **b. UI.** Inspector section, preview, session card, canvas card count, messages. Browser e2e with the fake Codex: a protected bench, a proposal moving it, preview, accept in the editor (the bench moves and stays protected), accept all from the session card with the editor open on unsaved edits, reject, the chat and editor showing the same state, and stale after the author moves the bench first.
- **c. Guide and evaluation.** Guide wording and refusal hint; the RFC 0037 evaluation scenario "change an object the author touched" now expects a `scene.propose` call and an unchanged scene.

## Decisions (maintainer, 2026-11-11)

1. **No notice to the Agent.** Resolving a proposal sends nothing to the proposing session, because a message could start a turn the author did not ask for. The session card shows the outcome to the author. The Agent learns it from `scene.proposal.list` or by rereading the scene when it next works on it.
2. **No expiry.** As with text proposals. Open proposals are capped at 20 per scene.
3. **Preview at the playhead only.** Playing back a proposed camera move can be a follow-up.
4. **Approve from the chat too.** A session card offers Accept all, Reject all and Open in scene editor (see UI).

## As built — steps a and c

The contract, generated `scene_proposals` migration, transactional service, gateway routing, transcript receipts, guide and synthetic evaluation checks are implemented. Step b remains separate; the only UI integration here is the four bilingual tool-activity labels required by the existing capability-label invariant. `scene.propose` takes `{ requestId, slotId, baseRevision, summary, changes: SceneChangeInput[] }` and returns `SceneProposal`; input changes contain neither `base`, `changeId`, review state nor ownership/still fields. `scene.proposal.list` takes optional `slotId` and `status` (default `open`) and returns `{ proposals }`. `scene.proposal.resolve` takes `{ requestId, slotId, action, changes: [{ proposalId, changeId }] }`, plus `expectedRevision` for acceptance, and returns `{ proposals, revision? }`. Accept computes the document, validates it and commits the same user stamping and `scene.set` operation used by editor saves. Successful tool results preserve a complete structured `sceneProposal` in transcript payloads before display-text truncation in Codex, Claude and ACP adapters.

Clarifications: the detailed contract's permission to include editable items in a proposal takes precedence over the earlier out-of-scope bullet; mixed related edits are supported. A proposal is resolved whenever it has no pending changes, including when all remaining changes became stale or superseded; those terminal changes may still be dismissed with Reject, without a content revision. The 20-open limit is checked after transactional superseding, allowing a replacement proposal at the limit. Updates preserve the target ID, and resolve selection refs are unique and capped at 1,940 (20 proposals × 97 changes). Accept processes proposals by creation time/ID and their changes in stored order. No Agent turn or message is started by resolution, and the evaluation scorer requires a successful `scene.propose` call while separately checking that protected content remains unchanged.

### Review fixes for steps a and c

Propose now runs the same exported canvas scene validator as acceptance, including project asset existence and kind checks, before storing or superseding proposals. An update with a different content ID reports `scene.change_id_mismatch` in both locales. On acceptance, superseded changes report `scene.change_not_pending` before content comparisons; explicitly stale changes retain `scene.change_stale`.

`refreshReviews(tx, at)` now owns all three review refreshers in studiod, without service import cycles. Canvas apply/undo/redo and every direct studiod `applyOps` caller (including media completion and blockout extraction) invoke it inside their transaction. Scene sources are loaded and parsed once per slot using a status-leading proposal index from a generated migration. Only missing or deleted sources silently invalidate pending changes: unexpected reads, corrupt documents and invalid live slots abort the transaction. Proposal views reuse known node IDs. Resolution emits at most one event per affected proposal, including rows that both resolve selected changes and stale other changes, and returns their final state. Transcript receipt extraction parses successful tool JSON once and shares the parsed value with scene and skill receipt checks.

## As built — step b

The scene inspector now shows proposal summaries, session names, per-item content differences and key counts, pending counts, and per-change or whole-proposal review actions. It retains resolved entries so their accepted/rejected state agrees with the session card, and stale/superseded entries remain dismissable. Preview overlays only pending changes on the local document, samples at the current playhead and outlines affected objects through the viewport's existing in-place update path. Hover and keyboard focus provide temporary preview; Preview and Open in scene editor pin it until a document edit, playback, Escape or End preview. Scrubbing, the playhead field, frame stepping and key navigation keep the preview and sample the proposed scene at the new playhead. Orbit, pan, zoom and framing also keep the read-only preview; document-writing viewport gestures remain blocked. Hover cannot replace a pinned proposal. Preview has no transition, including under reduced motion, and scene output actions are disabled while it is displayed.

Session cards are derived only from successful structured `sceneProposal` receipts, with duplicate receipts placed at their last occurrence; review state comes from the project cache, loaded once with `scene.proposal.list` (`status: all`) and refreshed on `scene.proposalChanged`. Cards perform no separate list requests, including after resolution. A project-scoped host cache supplies inspector state and the number of proposals with pending changes on canvas scene cards, without a canvas-to-editor dependency. Accepting from either surface flushes any mounted draft once in the host, reports a localized reason if saving fails, rereads the saved slot revision and resolves against it. A revision conflict rereads, synchronizes a still-clean mounted draft and leaves the next attempt to the author. The accepted document is adopted explicitly only if the flushed draft is still clean at the same base revision and the incoming revision is not older than the latest known document; edits made during resolution are retained. Resolved proposals clear preview requests and Escape only dismisses an actual visible preview. Editor proposal arrays retain their identity across unrelated app renders, and viewport teardown disposes every proposal outline. Resolution starts no Agent turn.

Unit coverage checks content-difference summaries, preview derivation, structured receipt placement, draft adoption and host flush/revision ordering. The fake-Codex browser suite covers protected bench preview and acceptance, receipt navigation, chat acceptance with another object's unsaved edit, rejection, synchronized states and stale changes after an author edit. Screenshots are captured at 1600 × 1000 with device scale factor 2 under `/tmp/vis-0044/step-b`.

## Manual acceptance (maintainer, 2026-11-11)

Passed by hand with Codex in the app: proposal cards and canvas counts, read-only preview, viewport navigation and playhead scrubbing during preview, Escape, pinning, accepting in the inspector and from the chat (an unsaved draft edit elsewhere was saved first), rejection, stale detection, supersession and reload persistence. A mixed review also passed: one proposal updated two existing objects, and accepting the bench change while rejecting the lamp change applied only the bench change.

A planned case, "move the bench and add a lamp" in one proposal, does not apply: proposals change only existing items, and new objects are the Agent's own direct writes (see Contract). The expected result there is a proposal for the bench and a direct write for the lamp.
