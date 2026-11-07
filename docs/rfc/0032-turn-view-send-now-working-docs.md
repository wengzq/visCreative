# 0032 · Turn view, send now, and working documents by default

Status: implemented

Date: 2026-11-05

Builds on [0013](0013-agent-activity.md) (session activity), [0015](0015-session-experience.md) (queue), [0016](0016-canvas-organization.md) (node purpose) and [0030](0030-session-results.md) (result cards). Comes from the maintainer's real use on 2026-11-05.

## Background

- A turn shows every reasoning block and tool group as its own row. A 2m40s turn fills a screen with "thought for 1s" and "called 2 tools".
- A message sent during a turn waits for the whole turn, and turns in real use ran up to 20 minutes.
- Child workspaces wrote review reports onto the canvas as artifacts, although the `canvas` guide says not to. Guide wording has already failed twice for similar rules (RFC 0029 evaluations).

## Design

### 1. One work block per stretch of activity

Consecutive reasoning, plan and tool items merge into one block. Anything the user must see ends the block and stays outside it: assistant text, approvals, questions, notices and RFC 0030 result cards.

- **Running:** one line with the current step and elapsed time, replacing the separate activity line.
- **Finished:** one collapsed line, for example `Worked 2m40s · 12 tools`, with failed tools counted so a failure is never hidden.
- **Expanded:** the steps in order, using today's reasoning and tool rows.
- Pure UI: no contract, storage or Agent change, and old sessions get it too. Scroll position and stick-to-bottom keep working when a block grows.

### 2. Send now

A queued user message gains **Send now**: it stops the current turn and delivers this message next.

- New UI method `session.sendNow { requestId, sessionId, messageId }`. It moves the message to the head of the queue and requests the same stop as `session.stop`, as one idempotent action.
- Stop keeps its existing scope: media tasks and Agent script batches in this session are cancelled; standalone generation jobs continue and still deliver to the canvas. A confirmation appears only when there are media tasks or script batches that Stop would cancel, and explains that cancellation is not a refund and standalone generation continues. Otherwise there is no confirmation.
- Undelivered work messages keep their order behind it and are not lost.
- Only for sessions that can run. RFC 0031 stranded messages keep their own actions.

Follow-up: delivering a message into a running turn without stopping it, if Codex and dsh support that. Not researched yet.

### 3. Child text is a working document

The gateway, not the guide, sets this.

- A text node created by a session in a child work item is stored as `purpose: 'working'`, whatever the op says, so it is hidden from the canvas by default (RFC 0016).
- A child session cannot set `purpose: 'artifact'` on a text node. The parent's session and the user can, which is how a child's result becomes a deliverable.
- Media, script, timeline and previz nodes are unaffected, so generated results still appear.
- `work_report` stays the channel for results. The review drawer and the parent's work message link working documents from that activation, so they can be read without turning on Show working documents.
- Following a working-document link temporarily reveals only that node while Show working documents remains off. Leaving the node hides it again.
- Existing nodes are not migrated.
- Root sessions are not covered: their text may be a deliverable, so the guide stays the only rule there. Reassess after use.

## Testing

- Unit: grouping boundaries, counts, failed tools. Gateway: child create, explicit artifact refused, parent and user promotion, media unaffected.
- e2e with fake Codex: collapsed and expanded blocks, a result card outside a block, Send now with and without cancellable batch generation, plus standalone generation continuing after interruption, order after a stop, a child report hidden with a link that opens it.
- A real Agent evaluation of the child rule needs the maintainer's approval.

## Implementation notes

- `session.sendNow` is UI-only. Queue promotion and unpausing share an idempotent transaction; its stop target is captured once. A dispatch fence holds the queue while the existing stop hook cancels media and batches, so a concurrent turn-end event cannot send early. Retried requests reuse the accepted result and do not interrupt a later turn.
- Claimed work batches interrupted before delivery get a fresh draft with the same delivery ID and queue position; messages have one turn each. Unclaimed work messages retain their original order and batch acknowledgement rules.
- Work blocks group existing transcript records at render time. Result cards use the last actual tool mention, including late receipts, as a boundary. Tool details and failures remain available inside the block; the running summary replaces the separate activity line. A message queued during a turn is stored inside that turn, so rendering moves it below the turn: one turn stays one block, and the running block stays above waiting messages.
- The gateway coerces all child-created text (plain, Markdown and code) to working purpose and rejects child promotion, including same-batch temporary IDs. Reports add links to working text changed by the child’s own sessions during this activation. These view references never become input snapshot requirements, so a deleted document does not block report delivery.
- Media task views expose optional session ownership for accurate cancellation confirmation; legacy views remain valid. No storage migration or new dependency is needed.
- Standalone jobs intentionally continue after Stop/Send now, as clarified by the maintainer during implementation. Real-Agent evaluation remains approval-gated and was not run.

## Validation

- Targeted protocol, session queue, work delivery, grouping, gateway, media-task and review unit tests passed, including Send now request retries and both unclaimed and startup-interrupted work batches.
- All 42 targeted browser cases passed across turn view, session panel, session results and canvas organization; fake-Codex coverage verifies long collapsed/expanded/running blocks, result ordering and uniqueness, Send now ordering and cancellation confirmation, standalone generation continuing, parent/report and review links to hidden child documents, and local rendering of a child's code document. Screenshots are saved at `/tmp/vis-next/rfc32` with a 1600×1000 viewport and device scale factor 2.
- The coordinator explicitly waived full e2e rounds on this branch to avoid three sequential full-suite queues. Full e2e did not run on this commit; the coordinator will run check, build and two consecutive full e2e rounds on the merged result. Real-Agent evaluation was not run.
