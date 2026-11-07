# 0034 · Agent-requested cleanup of child work items

Status: implemented

Date: 2026-11-05

Builds on [0009](0009-work-items-and-board.md) (work items, delete), [0010](0010-workspaces-without-canvas-binding.md) (delete keeps the canvas), [0015](0015-session-experience.md) (approval modes) and [0031](0031-manuscript.md) (`text.requestDelete`).

## Background

An author asked a root Agent to clean up the children it had dispatched. The Agent answered, correctly, that it had no way to do so: `work.delete` is UI-only, and `work.recall` only stops work. The author then has to leave the conversation and delete each card from the board.

Keeping `work.delete` away from Agents was deliberate. Deleting stops turns, cancels generation jobs, resolves open questions and archives sessions, and cancelling a job is not a refund. Opening it to Agents would let one silently discard work and money.

## Decision

An Agent may **ask**; the author **decides**. This follows the shape of `text.requestDelete`: the Agent names the targets, the gateway checks the relationship, and one approval card shows what will happen. Nothing is stopped or deleted until the author approves.

The board's own delete stays as it is.

## Contract

`work.requestDelete`, callers `agent`:

```ts
params: { requestId, workItemIds: Id[] }   // 1 to 20, no duplicates
result: { approvalId, status: 'pending' | 'approved' | 'denied' | 'expired' }
```

`ApprovalKind` gains `work_delete`. `ApprovalPayload` gains:

```ts
workDelete?: {
  items: { workItemId: Id, title: string }[]
  // Totals across the targets and everything below them, from work.deletePlan.
  runningTurns: number
  unfinishedJobs: number
  childrenTotal: number
  unresolvedMessages: number
  hasUnreviewedReport: boolean
  expiresAt: number
}
```

## Rules, all enforced in the gateway

1. **Relationship.** The caller needs an active turn in a linked, unarchived session of a root work item. Every target must be a live direct child of that work item. A child work item cannot request deletion, and neither can a session without a work item. One invalid target refuses the whole request (`work.delete_not_child`); no partial card is created.
2. **Once only.** Approval means `allow_once`. `allow_session` is refused with `work.delete_once_only`, and the card does not offer it.
3. **Never automatic.** A session's `auto` approval mode and the adapters' acceptance of vis tool confirmations do not apply. Only `session.respondApproval` from the UI can approve this card.
4. **The card is a promise.** At approval time the gateway rereads the plan. If a target is gone, or `runningTurns`, `unfinishedJobs`, `childrenTotal` or `unresolvedMessages` has grown, or `hasUnreviewedReport` has become true, the approval becomes `expired` and nothing happens. Shrinking numbers still approve: the author agreed to at least that much. This is stricter than a revision pin, which would expire on any report, and it never deletes more than the card showed.
5. **Expiry.** Pending cards expire after 10 minutes, on the same timer pattern as text deletion. Archiving the requesting session or ending its work item also expires them.
6. **Execution.** On approval, targets are deleted through the existing `work.delete` path with the user as actor. Each uses a request ID derived from the approval and target, so retries and restarts cannot repeat or lose a deletion. The status is recorded as approved before stopping begins. Provider cancellation is reported honestly through the existing `cancelledJobs` result; a failure on one target does not undo the others and is shown as a session notice naming that target.
7. **Canvas.** Canvas nodes and assets are kept, as with every work item deletion.

The requester's own session is never a target, so approving does not stop the turn that asked.

## Card

The card uses the existing approval layout, with **Delete** and **Keep**:

- A list of the work items by title.
- One line for each non-zero consequence: running turns to stop, generation jobs to cancel (with a plain note that cancelling is not a refund), nested children, unanswered questions, and reports not yet reviewed.
- One line saying canvas content stays.

An expired card shows why it can no longer be used and offers no buttons.

## Agent guidance

Only in the root workspace text, and only when it has children: if the author asks to clean up children, call `work_request_delete` with the direct children they mean, tell them a card is waiting, and end the turn without polling. Do not request cleanup on your own initiative; finished work may still be something the author wants. If the request is ambiguous, ask which children they mean.

The Agent learns the outcome from `work_list` on a later turn. Approval does not wake it.

## Principle check

- Mechanism: relationship, plan binding and expiry are gateway rules.
- Proposal: the Agent names what to remove.
- Decision: only the author's click stops or deletes anything.
- No taste is encoded: the product does not judge which work is worth keeping.

## Not in scope

- Agent deletion of root work items or projects.
- Bulk delete on the board.
- Waking the Agent after a decision. If authors miss this in use, it can follow as a small change.


## Implementation notes

- The protocol registers the Agent-only `work.requestDelete` capability and the `work_delete` payload. The gateway requires an active turn in a linked, unarchived root workspace session, and validates every live direct child before creating a card. The board's `work.delete` and `work.deletePlan` remain UI-only.
- The approval service uses the existing transcript and idempotency tables, with no schema migration. Pending requests have ten-minute timers restored when a project opens, and expire when the requester is archived, its work item ends, or a target disappears or changes parent. Requesting turn completion does not expire a card. Pending cards survive a daemon restart within their remaining lifetime.
- At a UI approval, all consequences are reread in an immediate transaction. Any numeric growth or a newly unreviewed report expires the entire card before any target is stopped. Shrinking consequences are accepted. The approved status and every target's existing `work.delete` plan are committed together before asynchronous interruption and cancellation; derived approval/target request IDs survive retries and restarts.
- Reuse of `work.deletePlan` and `work.delete` intentionally follows their existing affected set (the target and its live direct children), consistent with the product's two-level workspace hierarchy. Requests can never name a grandchild. This interpretation was confirmed by the coordinator.
- Existing board deletion queues a parent notification and wakes its main session. For approval execution, an internal persisted `suppressParentDelivery` flag preserves deletion audit messages with no `targetSessionId`, so they cannot wake the parent now or become a stale batch on a later turn. Board deletion is unchanged. This resolves the existing-code/RFC disagreement as confirmed by the coordinator.
- Each approved target starts concurrently, so a slow stop or cancellation never delays the other targets. A failure creates a durable localized session notice naming that target and leaves the other deletions intact. Provider cancellation truth remains in the existing `cancelledJobs` result, with an additional session notice reporting cancellation confirmations without implying refunds. Approval recovery delegates to the same durable delete path for each staged plan and catches target failures independently; board deletion recovery remains unchanged.
- The approval card lists target titles and every non-zero consequence, always states that canvas content and assets stay, and offers only Delete and Keep. Expired cards explain the possible invalidation causes and offer no buttons. Root workspace instructions mention cleanup only when children exist and only in response to the author's request.
- Gateway coverage includes relationships, atomic rejection of mixed requests, manual once-only decisions in auto mode, all consequence growth checks, shrinking plans, lifecycle/deadline expiry, target disappearance/reparenting, retry and daemon-restart recovery, honest cancellation notices, independent failures, requesting-turn continuity, and absence of later parent delivery. A timer test covers expiry without a read, including reopening the service. Browser acceptance uses real studiod and the Codex adapter with fake Codex and mock generation to exercise approval, denial, expiry, board removal, persistent canvas contents and card layout.
- Validation: pinned pnpm check passes (227 test files, 2,933 tests; existing optional skips remain), followed by a successful build and two consecutive full browser rounds (40 files and 293 tests each). The browser runs use fake Codex and mock generation only. Fonts were fetched once. The 1600 x 1000 card capture at device scale factor 2 and the detailed report are under `/tmp/vis-next/rfc34/`.
