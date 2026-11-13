import type { JobView, SceneProposal, SkillDraftReceipt, TranscriptItem } from '@vis/protocol'
import { groupTranscript, type ToolCall, type TranscriptGroup } from './toolGroups'
import { sceneProposalResults } from './SceneProposalCard'
import { skillDraftResults } from './SkillDraftCard'
import { generationResults } from './generationResults'

export type WorkBlockGroup = { kind: 'work'; itemId: string; turnId: string | null; items: TranscriptItem[]; steps: TranscriptGroup[]; active: boolean; endedAt?: number }
export type WorkTranscriptGroup = WorkBlockGroup | { kind: 'item'; item: TranscriptItem } | { kind: 'result'; job: JobView } | { kind: 'skillDraft'; draft: SkillDraftReceipt } | { kind: 'sceneProposal'; proposal: SceneProposal }

/** A message queued mid-turn is stored inside that turn; show it after the turn so one turn stays one block. */
function queuedAfterTurn(items: TranscriptItem[], waiting: (item: TranscriptItem) => boolean) {
  const last = new Map(items.flatMap((item, index) => item.turnId ? [[item.turnId, index] as const] : []))
  const ordered: TranscriptItem[] = []
  let held: TranscriptItem[] = []
  let current: string | null = null
  const release = () => { ordered.push(...held); held = [] }
  items.forEach((item, index) => {
    if (waiting(item)) return
    // User messages carry no turn ID, so a sent message is recognized by its position inside another turn.
    if (item.kind === 'user' && current && item.turnId !== current && last.get(current)! > index) {
      held.push(item)
      return
    }
    // A late receipt from a stopped turn must not hold a message behind the turn it started.
    if (item.turnId && current && item.turnId !== current) release()
    ordered.push(item)
    if (item.turnId) current = item.turnId
    if (current && last.get(current) === index) release()
  })
  release()
  return [...ordered, ...items.filter(waiting)]
}

/** Results occupy their last actual mention, even when a late receipt rejoins an earlier call. */
export function workTranscript(source: TranscriptItem[], jobs?: ReadonlyMap<string, JobView>, activeTurnId: string | null = null, isWaiting: (item: TranscriptItem) => boolean = () => false): WorkTranscriptGroup[] {
  const waiting = (item: TranscriptItem) => !!activeTurnId && item.kind === 'user' && isWaiting(item)
  const items = queuedAfterTurn(source, waiting)
  const pairs = new Map<string, ToolCall>()
  for (const group of groupTranscript(items)) if (group.kind === 'tools') for (const pair of group.calls) {
    pairs.set((pair.call ?? pair.result)!.itemId, pair)
  }
  const results = generationResults(items, jobs)
  const sceneProposals = sceneProposalResults(items)
  const skillDrafts = skillDraftResults(items)
  const groups: WorkTranscriptGroup[] = []
  let block: WorkBlockGroup | undefined
  let boundary = 'start'
  for (const item of items) {
    if (['reasoning', 'plan', 'tool_call', 'tool_result'].includes(item.kind)) {
      const pair = pairs.get(item.itemId)
      // A paired late receipt updates its original row without adding an empty work block.
      if (item.kind !== 'tool_result' || pair || block?.turnId === item.turnId) {
        if (!block || block.turnId !== item.turnId) {
          block = { kind: 'work', itemId: `work-${item.turnId}-${boundary}`, turnId: item.turnId, items: [], steps: [], active: false }
          groups.push(block)
        }
        block.items.push(item)
        if (pair) {
          const previous = block.steps.at(-1)
          if (previous?.kind === 'tools') previous.calls.push(pair)
          else block.steps.push({ kind: 'tools', itemId: item.itemId, calls: [pair] })
        } else if (item.kind !== 'tool_call' && item.kind !== 'tool_result') block.steps.push({ kind: 'item', item })
      }
    } else {
      if (block && item.turnId === block.turnId) block.endedAt = item.createdAt
      groups.push({ kind: 'item', item })
      boundary = item.itemId
      block = undefined
    }
    const proposal = sceneProposals.get(item.itemId)
    if (proposal) {
      if (block) block.endedAt = item.createdAt
      groups.push({ kind: 'sceneProposal', proposal })
      boundary = proposal.proposalId
      block = undefined
    }
    const draft = skillDrafts.get(item.itemId)
    if (draft) {
      if (block) block.endedAt = item.createdAt
      groups.push({ kind: 'skillDraft', draft })
      boundary = draft.draftId
      block = undefined
    }
    for (const job of results.get(item.itemId) ?? []) {
      if (block) block.endedAt = item.createdAt
      groups.push({ kind: 'result', job })
      boundary = job.jobId
      block = undefined
    }
  }
  if (activeTurnId) {
    // Messages still waiting for their turn stay below the running one.
    const tail = groups.findLastIndex(group => group.kind !== 'item' || !waiting(group.item))
    const last = groups[tail]
    if (last?.kind === 'work' && last.turnId === activeTurnId) last.active = true
    else groups.splice(tail + 1, 0, { kind: 'work', itemId: `work-${activeTurnId}-${boundary}`, turnId: activeTurnId, items: [], steps: [], active: true })
  }
  return groups
}

export function workBlockStats(block: WorkBlockGroup) {
  const calls = block.steps.flatMap(step => step.kind === 'tools' ? step.calls : [])
  const items = [...block.items, ...calls.flatMap(pair => [pair.call, pair.result].filter((item): item is TranscriptItem => !!item))]
  return {
    tools: calls.length,
    failed: calls.filter(pair => (pair.result?.payload as { isError?: boolean } | undefined)?.isError).length,
    startedAt: items.length ? Math.min(...items.map(item => item.createdAt)) : undefined,
    endedAt: items.length ? Math.max(block.endedAt ?? 0, ...items.map(item => item.updatedAt)) : undefined,
  }
}
