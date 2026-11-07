import { describeError, messagesFor, type Locale } from '@vis/ui-kit'
import { shellMessages } from './messages'
import type { JobProblem, NodeDecoration } from '@vis/canvas-ui'
import type { BatchView, BindingStatus, JobView, MediaTaskProgress, MediaTaskView, NodeView, SessionSummary, SlotVersionView, SlotView, SpaceEvent, SpaceSnapshot } from '@vis/protocol'

export type SpaceState = {
  /** Last applied event sequence; used as afterSeq on reconnect */
  seq: number
  nodes: Map<string, NodeView>
  sessions: Map<string, SessionSummary>
  /** Active generation jobs and terminal jobs needing notices (failed, no output, conflicts); the latter remain until dismissed */
  jobs: Map<string, JobView>
  mediaTasks: Map<string, MediaTaskView>
  scriptBatches: Map<string, BatchView>
  /** Nodes receiving deliveries since opening -> delivery event sequence; the UI highlights each once */
  delivered: Map<string, number>
  /** Full slot histories read on this page; invalidated by slot revisions */
  histories: Map<string, SlotVersionView[]>
}

export const emptyState = (): SpaceState => ({ seq: 0, nodes: new Map(), sessions: new Map(), jobs: new Map(), mediaTasks: new Map(), scriptBatches: new Map(), delivered: new Map(), histories: new Map() })

export function applyMediaProgress(state: SpaceState, event: MediaTaskProgress): SpaceState {
  const task = state.mediaTasks.get(event.taskId)
  if (!task || (task.status !== 'queued' && task.status !== 'running') || event.progress <= (task.progress ?? 0)) return state
  return { ...state, mediaTasks: new Map(state.mediaTasks).set(event.taskId, { ...task, progress: event.progress }) }
}

const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'cancelled'])

export function normalizeSession(session: SessionSummary): SessionSummary {
  return { ...session, agentConfig: { ...{ model: null, effort: null, serviceTier: null }, ...session.agentConfig }, queuedMessageCount: session.queuedMessageCount ?? 0 }
}

export function fromSnapshot(snapshot: SpaceSnapshot, seq: number): SpaceState {
  return {
    seq,
    nodes: new Map(snapshot.nodes.map(n => [n.nodeId, n])),
    sessions: new Map(snapshot.sessions.map(s => [s.sessionId, normalizeSession(s)])),
    jobs: new Map(snapshot.activeJobs.map(j => [j.jobId, j])),
    mediaTasks: new Map((snapshot.activeMediaTasks ?? []).map(task => [task.taskId, task])),
    scriptBatches: new Map((snapshot.activeScriptBatches ?? []).map(batch => [batch.batchId, batch])),
    delivered: new Map(),
    histories: new Map(),
  }
}

/** Applies one persistent event by seq; duplicate or stale events return the old state unchanged */
export function applyEvent(state: SpaceState, e: SpaceEvent): SpaceState {
  if (e.seq <= state.seq) return state
  const next: SpaceState = { ...state, seq: e.seq }
  const p = e.payload as any
  switch (e.type) {
    case 'node.created':
    case 'node.updated':
      next.nodes = new Map(state.nodes).set(p.nodeId, p as NodeView)
      break
    case 'node.deleted': {
      next.nodes = new Map(state.nodes)
      next.nodes.delete(p.nodeId)
      next.histories = new Map(state.histories)
      for (const slot of state.nodes.get(p.nodeId)?.slots ?? []) next.histories.delete(slot.slotId)
      for (const [id, node] of next.nodes) {
        if (!node.inputs?.includes(p.nodeId)) continue
        const { inputs, ...rest } = node
        const liveInputs = inputs.filter(input => input !== p.nodeId)
        next.nodes.set(id, { ...rest, ...(liveInputs.length ? { inputs: liveInputs } : {}) })
      }
      break
    }
    case 'slot.revised': {
      const node = state.nodes.get(p.nodeId)
      const slot = p.slot as SlotView | undefined
      if (node && slot) next.nodes = new Map(state.nodes).set(node.nodeId, { ...node, slots: node.slots.map(s => (s.slotId === slot.slotId ? slot : s)) })
      next.histories = new Map(state.histories)
      next.histories.delete(p.slotId ?? slot?.slotId)
      break
    }
    case 'session.created':
    case 'session.updated':
      // Old snapshots and events bypass zod; fill new fields consistently.
      next.sessions = new Map(state.sessions).set(p.sessionId, normalizeSession(p as SessionSummary))
      break
    case 'job.stateChanged': {
      const prev = state.jobs.get(p.jobId)
      const job: JobView = p.job ?? { outputs: [], targets: [], ...prev, jobId: p.jobId, status: p.status, ...(p.error ? { error: p.error } : {}) }
      next.jobs = new Map(state.jobs)
      if (TERMINAL.has(job.status) && !jobProblem(job)) next.jobs.delete(job.jobId)
      else next.jobs.set(job.jobId, job)
      break
    }
    case 'mediaTask.stateChanged':
      next.mediaTasks = recordMediaTask(state, p as MediaTaskView).mediaTasks
      break
    case 'scriptBatch.stateChanged':
      next.scriptBatches = new Map(state.scriptBatches).set(p.batchId, p as BatchView)
      break
    case 'binding.stateChanged': {
      if (p.status === 'delivered' && p.nodeId) next.delivered = new Map(state.delivered).set(p.nodeId, e.seq)
      break
    }
    default:
      break
  }
  return next
}

/** Sorts nodes by hierarchy for canvas rendering */
export function sortedNodes(state: SpaceState): NodeView[] {
  return [...state.nodes.values()].sort((a, b) => a.z - b.z)
}

/** Explanation when not displayed on a node */
const PROBLEM: Partial<Record<BindingStatus, 'conflict' | 'targetMissing' | 'noOutput'>> = {
  conflict: 'conflict',
  target_missing: 'targetMissing',
  no_output: 'noOutput',
}

/** Issues in terminal jobs to show the user; returns null when there are none */
export function jobProblem(job: JobView, locale: Locale = 'zh-CN'): string | null {
  const m = messagesFor(shellMessages, locale)
  if (job.status === 'cancelled') return job.providerCancelled === false ? m.cancelledLocally : m.cancelled
  if (job.status === 'failed' || job.status === 'unknown') {
    const reason = job.status === 'unknown' ? m.unknown : m.failed
    return job.error?.message ? m.problem(reason, describeError(job.error, locale)) : reason
  }
  if (!TERMINAL.has(job.status)) return null
  const bad = job.targets.find(t => PROBLEM[t.status])
  return bad ? m[PROBLEM[bad.status]!] : null
}

// User-cancelled jobs confirmed by the provider are informational, not errors; mark unknown results that can still be queried
const problemFlags = (job: JobView) => ({
  ...(job.status === 'cancelled' && job.providerCancelled !== false ? { muted: true } : {}),
  ...(job.recheckable ? { recheckable: true } : {}),
})

/** User dismisses a notice */
export function dismissJobs(state: SpaceState, jobIds: string[]): SpaceState {
  const jobs = new Map(state.jobs)
  for (const id of jobIds) if (TERMINAL.has(jobs.get(id)?.status ?? '')) jobs.delete(id)
  return { ...state, jobs }
}

/** RPC acknowledgments may arrive after newer persistent task events. Never regress a completed task. */
export function recordMediaTask(state: SpaceState, task: MediaTaskView): SpaceState {
  const previous = state.mediaTasks.get(task.taskId)
  if (previous && (previous.status === 'failed' || previous.status === 'succeeded')) return state
  if (previous?.status === 'running' && task.status === 'queued') return state
  const progress = task.status === 'running' && previous?.progress !== undefined
    ? Math.max(previous.progress, task.progress ?? 0) : task.progress
  return { ...state, mediaTasks: new Map(state.mediaTasks).set(task.taskId, { ...task, ...(progress !== undefined ? { progress } : {}) }) }
}

export function dismissMediaTask(state: SpaceState, taskId: string): SpaceState {
  if (state.mediaTasks.get(taskId)?.status !== 'failed') return state
  const mediaTasks = new Map(state.mediaTasks)
  mediaTasks.delete(taskId)
  return { ...state, mediaTasks }
}

function sameDecorationValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameDecorationValue(value, b[index]))
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameDecorationValue(left[key], right[key]))
}

export function reuseNodeDecorations(next: Map<string, NodeDecoration>, previous?: ReadonlyMap<string, NodeDecoration>): ReadonlyMap<string, NodeDecoration> {
  let unchanged = next.size === previous?.size
  for (const [id, decoration] of next) {
    const old = previous?.get(id)
    const equal = old && sameDecorationValue(decoration, old)
    if (equal) next.set(id, old)
    else unchanged = false
  }
  return unchanged ? previous! : next
}

/**
 * Generation state for each node: slot-fill jobs appear on their target nodes, and node-creation jobs on their anchor nodes.
 * Jobs without a matching node count toward unanchored and appear in the page header.
 */
export function nodeDecorations(state: SpaceState, locale: Locale = 'zh-CN', previous?: ReadonlyMap<string, NodeDecoration>): { byNode: ReadonlyMap<string, NodeDecoration>; unanchored: { running: number; problems: JobProblem[] } } {
  const byNode = new Map<string, NodeDecoration>()
  const unanchored = { running: 0, problems: [] as JobProblem[] }
  const at = (nodeId: string) => {
    let d = byNode.get(nodeId)
    if (!d) byNode.set(nodeId, (d = { running: 0, problems: [] }))
    return d
  }
  for (const job of state.jobs.values()) {
    const problem = jobProblem(job, locale)
    const running = !TERMINAL.has(job.status)
    if (!running && !problem) continue
    // Count each node only once per job; active jobs consider only undelivered targets
    const anchors = new Set<string>()
    for (const t of job.targets) {
      if (running && t.status !== 'pending') continue
      if (!running && !PROBLEM[t.status] && job.status === 'succeeded') continue
      const nodeId = t.kind === 'slot' ? t.nodeId : t.nearNodeId
      if (nodeId && state.nodes.has(nodeId)) anchors.add(nodeId)
    }
    if (!anchors.size) {
      if (running) unanchored.running++
      else unanchored.problems.push({ jobId: job.jobId, message: problem!, ...problemFlags(job) })
      continue
    }
    for (const nodeId of anchors) {
      const d = at(nodeId)
      if (running) {
        d.running++
        d.activeJobs ??= []
        d.activeJobs.push(job)
      }
      else d.problems.push({ jobId: job.jobId, message: problem!, ...problemFlags(job) })
    }
  }
  for (const [nodeId, seq] of state.delivered) if (state.nodes.has(nodeId)) at(nodeId).deliveredSeq = seq
  const latest = new Map<string, MediaTaskView>()
  for (const task of state.mediaTasks.values()) {
    if (!state.nodes.has(task.nodeId) || (latest.get(task.nodeId)?.createdAt ?? -1) > task.createdAt) continue
    latest.set(task.nodeId, task)
  }
  for (const task of latest.values()) if (task.status !== 'succeeded') at(task.nodeId).mediaTask = task
  const latestBatches = new Map<string, BatchView>()
  for (const batch of state.scriptBatches.values()) {
    if ((latestBatches.get(batch.scriptNodeId)?.createdAt ?? -1) <= batch.createdAt) latestBatches.set(batch.scriptNodeId, batch)
  }
  for (const batch of state.scriptBatches.values()) {
    if (!state.nodes.has(batch.scriptNodeId)) continue
    if (!['pending_approval', 'running', 'paused'].includes(batch.status) && latestBatches.get(batch.scriptNodeId) !== batch) continue
    const decoration = at(batch.scriptNodeId)
    decoration.scriptBatches = [...(decoration.scriptBatches ?? []), batch]
    const jobIds = new Set(batch.shots.flatMap(shot => shot.steps.flatMap(step => step.jobId ? [step.jobId] : [])))
    const jobs = [...state.jobs.values()].filter(job => jobIds.has(job.jobId))
    if (jobs.length) decoration.scriptBatchJobs = [...(decoration.scriptBatchJobs ?? []), ...jobs]
  }
  return { byNode: reuseNodeDecorations(byNode, previous), unanchored }
}
