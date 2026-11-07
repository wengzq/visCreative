# 0038 · Unreported child turns: tell the parent when a child stops without reporting

Status: implemented (2026-11-07)

Date: 2026-11-07

Builds on [0009](0009-work-items-and-board.md) (work items, reports), [0010](0010-workspaces-without-canvas-binding.md) (sessions and routing) and [0035](0035-silent-turn-watchdog.md) (silent turns, the parent notice path).

## Background

A parent learns about a child through three paths: a failed turn, a silent turn (0035) and `work.report`. One case falls through all of them. A child's turn ends normally, but the child never called `work.report`: it forgot, or it asked its question in prose and stopped. `session-service.ts` only notifies the parent when a turn's status is not `completed`, so nothing is sent. The parent waits for a report that will never come, and the card stays `in_progress`.

The only protection today is the instruction telling children to report. Permissions and limits are enforced in the gateway rather than in prompts, and delivery of a state this important should not depend on a prompt either. Coordinating Codex workers through Orca showed the same case twice in one day: a worker asked a question, ended its turn and waited. Orca caught it because it reports a worker that stops without reporting.

A periodic heartbeat is the wrong answer. It would wake the parent repeatedly, spending turns and money, and it only proves that a process is alive. Liveness is already covered by 0035.

## Decision

When a child stops without reporting, tell the parent once, through the existing failure path. Nothing is stopped, moved or retried, and the parent decides what to do.

## When it fires

The check runs when a turn ends with status `completed`. It fires only if all of these hold:

1. The session belongs to a child work item (one with a `parentId`) whose status is `in_progress`. Root work items reply to the user and are exempt.
2. No session of that work item has an active turn, a queued message or an undelivered work batch. Work that is about to continue is not stopped work, so the check waits for the turn that really ends the run. If that work goes away without a completed turn (a sibling turn is stopped, fails or is interrupted by a restart, or a queued message is cleared or rejected), the check runs at that point instead.
3. The work item's most recent delivered work batch has no `work.report` of any kind created after it. Reports are read from `work_messages`, so the check survives a restart.
4. That batch has not been notified yet.

Consequences worth stating:

- A conversation between the author and a child session never fires by itself. Only a delivered dispatch, reply or review feedback creates an expectation of a report. The latest turn carrying that batch must have completed, and each later turn across the item's sessions, in start order, must use a message created no later than the latest turn end seen so far, so only messages queued during the same continuous run extend that expectation.
- A turn waiting for approval has not ended, and 0035 covers it.
- Recall and `work.move` leave the work item out of this path: recall stops the agents on purpose, and a card moved off `in_progress` no longer expects a report.
- Interrupted and failed turns keep their existing notices.

## Telling people

- **Parent.** `WorkFailure['reason']` gains `turn_unreported`. The message goes through `notifySessionFailure` to the parent's main session and wakes it, keyed `unreported_<deliveryId>` so a batch produces at most one. The body says the child ended its turn without reporting, that nothing was stopped, and that the parent can reply, recall or wait. It includes the count of the work item's unfinished generation jobs, if any, and the last 500 characters of the child's final assistant message, so that a question asked in prose reaches the parent without another read.
- **Board and inbox.** It is a notice, not a failure, and gets the same treatment as `turn_silent`: the card does not turn into a failed card, and the inbox uses its own label. The card shows a small warning until the child's next turn starts, it reports, or the card leaves `in_progress`; the inbox keeps the notice.
- **Instructions.** The child's instructions state that a turn ending without `work_report` notifies the parent. The parent's instructions state that a reply to the notice restarts the child, and that recall is available.

## Cost bound

A notice wakes the parent, the parent may reply, the reply starts a child turn, and that turn may again end without a report. Left alone, two Agents could spend money on each other indefinitely.

So a work item wakes its parent at most **twice** for this reason until the count resets. The third notice is recorded for the author in the inbox with no target session, and the parent is not woken. Only notices that reached a parent session count. A notice that finds no live parent session is addressed to the author and is never delivered later. The count comes from `work_messages`, so a restart does not reset it. This is a cost rule, and it is mechanism rather than taste. A `work.report` resets the count, and so does the author's own recall, activation, move to `in_progress`, reopen or rejection. An Agent's recall and activation do not: otherwise a parent could restart the count on every cycle and the two Agents could still spend without limit.

Existing rules still apply: a batch made only of failure messages produces no further notification, and the parent's own turn cannot generate one because a root work item is exempt.

## Contract and data

- `WorkFailure.reason` gains `turn_unreported`. The value is stored in the existing JSON column.
- `work_items.unreported_baseline_seq` records the event sequence of the author's last reset. Activation alone cannot serve as the baseline, because `activationSeq` also moves for Agents and for queued activations.
- No new method and no new event.
- The session service gains the check; the query over work items and messages stays in `work-service.ts`, behind the existing `onWorkFailure` seam.
- `work.reply` with `replyTo` only accepts `question`, `blocked` and `escalation` messages, so the parent answers a notice with a plain `work.reply` without `replyTo`. The parent's instructions say so, and a gateway test covers it.

## Principle check

- Mechanism: noticing that an expected report did not arrive, and bounding the cost of the follow-up.
- Decision: the parent or the author decides whether to reply, recall or wait. A child that stopped early is not judged, and its status does not change.
- Author's work: nothing here writes to canvas content or changes a selection.
- Cost: at most two parent turns until a report or an author action. Generation jobs are reported and never cancelled.

## Testing

- Unit, in the session service and work service: each firing condition and each exemption; one notice per batch, including after a restart; a queued message delaying the check to the final turn; author conversation not firing; the third notice going to the inbox without waking the parent; a report resetting the count.
- Gateway: the parent's main session receives the message, an archived parent leaves it in the inbox, and a parent can reply to it.
- Browser, with fake Codex ending a child turn without a report: the parent receives the notice, the card shows the warning and not a failure, and a reply clears it.

## Decisions

Accepted by the maintainer on 2026-11-07.

1. **Unfinished generation jobs do not delay the notice.** It fires as usual and carries the count, because a child that stopped may have nothing left to wake it.
2. **The wake limit is two**, reset only by a report or the author's own action, as set out in the cost bound above. It was first accepted as two per activation, and changed on 2026-11-07 because an Agent's recall and activation restarted the count.

## Implementation notes

- Completed turns enter the existing `onWorkFailure` seam after batch acknowledgement, except while deliberately stopping. Archived work items and pending deletions are exempt. The work service checks active turns, drafts and pending child messages only for live sessions, ignoring terminally rejected batches while preserving fresh user retries. It ties the most recent delivered batch to its latest carrying turn and follows queued messages across the same continuous run, so later author conversations do not revive an old expectation.
- Reports and prior notices come from `work_messages`, and `unreported_<deliveryId>` provides durable batch deduplication. Event sequence numbers distinguish activation boundaries, report resets and different deliveries with the same timestamp. Ordering messages within one delivery does not read events, and the first running event is read only when a report actually shares the delivery timestamp. Completed turns processed during shutdown still persist their notices; queue pumping stays disabled until recovery delivers them after restart.
- Notices store the unfinished generation count and final reply tail in the existing failure detail JSON string for localized inbox display. The tail comes from the last non-empty assistant text across the run, walking back from its final turn, and retains the last 500 Unicode code points. Generation never delays the notice. The third and later notices target the author with no session, so later parent activation cannot accidentally deliver them.
- The existing card failure field carries the notice while card activity remains independent of it. Board and compact workspace cards show a small warning, cleared by the next child turn, any report, or the card leaving `in_progress`; actual failures and live silence retain their existing behavior. Warning reads compare the notice against the existing `statusChangedAt` and use primary-key row-order lookups for timestamp ties, without reading events. Leaving progress also persists a `warningCleared` marker in the existing notice detail for status changes within one millisecond, so restarting or returning to progress cannot revive it. Inbox and review history share localized message labels, including separate labels for silence and unreported turns. Parent instructions explicitly use `work.reply` without `replyTo`.
- Focused session/work-service tests cover eligibility, all report kinds, live and archived sibling sessions, queued and unassigned messages, rejected batches, author conversations after idle or failed runs, review feedback, deliberate stops and deletions, shutdown and restart delivery, tool-only final turns, Unicode tails, warning dismissal, same-timestamp ordering, wake caps and report resets. Gateway tests cover main-session delivery, archived-parent inbox retention and replying. Fake-Codex browser acceptance verifies parent delivery, the inbox label, a warning without a failed card, and clearing after a parent reply. No real Agent or paid provider was used.
