# 0035 · Silent turns: notice, tell the parent, and make Stop reliable

Status: implemented; Windows follow-up revalidation pending (2026-11-05)

Date: 2026-11-05

Builds on [0009](0009-work-items-and-board.md) (work items, recall), [0013](0013-agent-activity.md) (activity), [0015](0015-session-experience.md) (queue) and [0032](0032-turn-view-send-now-working-docs.md) (work blocks, Send now).

## Background

In real use a child worker got stuck and its parent never knew. Delivery failures, failed turns and process exits are already handled: the turn ends and the parent is told. The gap is a live Agent process that stops emitting events. No `turn_ended` arrives, so the turn stays `running`, holds its execution slot and blocks its queue, and everything looks normal.

A timeout that kills the turn is the wrong answer. Quiet is not the same as stuck: a long build, a render or slow reasoning can be silent for minutes, and killing one loses work the author may want. Whether quiet work is worth waiting for is a judgement, so the product should report the fact and leave the decision to a person.

## Decision

1. Detect silence and show it. **Nothing is stopped automatically.**
2. Tell the parent once, so a stuck child no longer goes unnoticed.
3. Make Stop finish even when the Agent no longer answers, because that is the action everyone will reach for.

## Detecting silence

The session service keeps a last-activity time for each active turn, in memory. Activity is any sign of life for that session:

- any `AgentEvent`, including `turn_waiting`;
- streaming events, which bypass the session service today and need a light signal;
- any gateway call authenticated as that session.

A periodic check (every 30 s, unref'd) marks a `running` turn silent when:

| Situation | Threshold |
| --- | --- |
| No tool call is open | 10 minutes |
| A tool call has started with no result yet | 30 minutes |

A turn in `waiting_user`, or one the runtime reports as waiting, is never silent: it is waiting for a person. A turn already stopping is not silent either; rule 3 below covers it. Thresholds are constants with test overrides, not per-project settings.

Activity after a turn is marked silent clears the mark straight away.

A daemon restart already interrupts active turns, so nothing here needs storing beyond the contract fields below.

## Contract

- `SessionSummary` gains `silentSince: int | null`, the last-activity time of a silent active turn, and `session.updated` is emitted when it is set or cleared.
- `WorkFailure['reason']` gains `turn_silent`.
- `WorkSessionView` also gains nullable `silentSince`, so board cards can reflect live silence independently of durable failure messages. Legacy summary and card events parse it as null.

No schema migration is expected. If one proves necessary, generate it.

## Telling people

- **Session.** The running work block's summary shows, in plain words, that there has been no activity for N minutes and that the Agent may be stuck, with Stop nearby. It reuses the existing block; no new card. The text clears when activity resumes.
- **Board.** The work card shows the same state as a small warning, alongside the existing failure display.
- **Parent.** The first time a child turn goes silent, the existing work failure path sends the parent's main session one durable message, keyed by turn so it is sent at most once. It says the child has been quiet for N minutes, that it was **not** stopped, and that the parent can recall it, or keep waiting. Root workspaces have no parent, so only the session and board show it.

If the child recovers, no second message is sent; its normal report follows. A recovered child must not leave a warning on the card.

## Reliable Stop

`session.stop`, `session.sendNow`, `work.recall` and `work.delete` all depend on `interruptTurn`, whose result is only "the request was sent". A hung Agent may never send `turn_ended`, so today these can wait forever.

If a stopping turn has no `turn_ended` within a bounded grace period (30 s), the session service ends it itself as `interrupted`, tells the runtime to terminate that turn's process, and continues exactly as a normal interrupted turn does: approvals expire, the queue pumps, work batches follow existing retry rules, and recall and delete proceed. A late `turn_ended` afterwards is ignored.

The runtime port gains a required way to force termination. All three adapters implement it, and it must actually kill the process tree. A process that outlives a forced end must not be able to write afterwards: its session token is already tied to the turn.

## Principle check

- Mechanism: measuring silence and guaranteeing that Stop works.
- Decision: the author or parent decides whether to wait. Nothing silent is killed, and no quality judgement is involved.
- Cost: a silent turn spends nothing by itself. It holds a slot, which the warning makes visible. Generation jobs follow existing rules and are never cancelled by this.

## Testing

- Unit, with an injected clock: both thresholds, every activity source resetting the timer, waiting turns exempt, stopping turns exempt, mark cleared on activity, one parent message per turn, none for a root.
- Forced end: Stop, Send now, recall and delete all finish against an Agent that ignores interrupts, a late `turn_ended` is ignored, and the queue continues.
- Each adapter: the forced path kills a process that ignores interruption.
- Browser, with fake Codex holding a turn silent and a short test threshold: the block text, the card warning, the parent's message, recovery clearing both, and Stop finishing a hung turn.

## Not in scope

- Automatic stopping or retries of silent turns.
- Per-project threshold settings, unless real use shows a need.
- Freeing a slot while a silent turn still runs.

## Implementation notes

- Silence and last activity stay in memory. The session service owns a 30-second unref’d watchdog and per-turn stop timers; thresholds and intervals accept dependency-injected test overrides, never project configuration. Streaming updates touch an in-memory clock without persistence or a database read. Summary readers in other services see the same ephemeral mark, fenced by the active turn ID.
- Durable silence messages use a separate `silent_<turnId>` failure key, preserving later terminal-failure notifications and suppressing duplicate silence messages after recovery. Roots get no failure message. Board warnings read the live session mark, so a historical silence message never becomes a stale failure badge.
- A forced ending enters the existing interrupted-terminal-event handler before requesting runtime termination. This expires approvals, preserves Send now work batches and queue ordering, and fences old tokens before the next turn. A terminal signal also releases a queue chain waiting on startup or dispatch; late handshake results and late terminal events cannot change the ended turn.
- Coordinator-approved process extension: POSIX Agents launch in detached groups, including through the unchanged macOS sandbox command. Only child objects created by the shared spawner have registered group ownership; exited, reused, or unknown PIDs never receive a group signal. Windows retains `taskkill /T /F`. All adapters expose required `terminateTurn`; Claude captures the process through its SDK custom-spawn hook. Codex and DeepSeek retain process tracking until OS exit, and disposal hard-kills pending and active process trees. Turn cleanup preserves DeepSeek’s existing session-close opportunity.
- Session warnings stay in the current work-block summary with a themed Stop button beside the text. Board warnings sit below the heading and above Agent rows. Both English and Chinese copy describe silence without claiming that the Agent failed or was stopped.
- No schema migration or new dependency was needed. Focused clock, queue, gateway, adapter-process, and browser tests cover the RFC scenarios; acceptance details and screenshot paths are recorded in `/tmp/vis-next/rfc35/report.md`.

## Windows cleanup follow-up (2026-11-05)

Implementation fixed; Windows and real-Agent acceptance pending. Claude keeps independent lifetime sets for startup tasks and consumers, even after forced termination releases session admission. Processes are keyed by turn so a subsequent turn cannot hide an older process. Finalization awaits tree termination and the process exit event before recording the instance and reporting the turn; disposal waits for every consumer, including one already finalizing. Codex termination also waits for process exit, and its process set remains live until exit, the terminal write and the pending tree kill finish. Disposal no longer treats a five-second exit timeout as successful cleanup. Codex also retains startup completion through its final database write, settles failed spawns that never emit exit, and waits for already-finishing catalog probes to exit; only an error with no spawned PID can substitute for an exit event.

The DeepSeek `0415f92` finishing-promise fix was audited: repeated finish calls await the same finalizer, and the process remains tracked through exit and `done`. It needs no additional change for the reported late-database-write race. Deterministic tests hold a Claude tree kill and delay its consumer, and hold a Codex process exit and a finishing catalog probe, plus simulate a failed spawn without an exit event; all five fail against the pre-fix adapters. Existing real fake-process/descendant tests remain in place. No real Agent was launched.
