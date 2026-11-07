import type { BindingStatus, JobStatus, JobTarget, JobView } from '@vis/protocol'
import { and, desc, eq, spaceSchema as s, type SpaceTx } from '@vis/storage'

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'unknown', 'cancelled']

export function readJobView(tx: SpaceTx, jobId: string): JobView | undefined {
  const job = tx.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
  if (!job) return undefined

  const bindings = new Map(
    tx.select().from(s.deliveryBindings).where(eq(s.deliveryBindings.jobId, jobId)).all().map(b => [b.outputIndex, b]),
  )
  const outputs = tx
    .select({ outputIndex: s.generationOutputs.outputIndex, assetVersionId: s.generationOutputs.assetVersionId, mime: s.assetVersions.mime })
    .from(s.generationOutputs)
    .innerJoin(s.assetVersions, eq(s.assetVersions.id, s.generationOutputs.assetVersionId))
    .where(eq(s.generationOutputs.jobId, jobId))
    .orderBy(s.generationOutputs.outputIndex)
    .all()

  const missing = [...bindings.values()].filter(b => b.status === 'no_output').map(b => b.outputIndex).sort((a, b) => a - b)
  const targets = [...bindings.values()].sort((a, b) => a.outputIndex - b.outputIndex).map(b => {
    const target: JobTarget = { outputIndex: b.outputIndex, kind: b.targetKind, status: b.status as BindingStatus }
    if (b.targetKind === 'slot') {
      if (b.nodeId) target.nodeId = b.nodeId
      if (b.slotId) target.slotId = b.slotId
    } else {
      if (b.createdNodeId) target.nodeId = b.createdNodeId
      const near = (b.placement as { nearNodeId?: string } | null)?.nearNodeId
      if (near) target.nearNodeId = near
    }
    return target
  })
  return {
    jobId,
    status: job.status,
    kind: job.kind,
    operation: job.operation,
    createdAt: job.createdAt,
    ...(job.cancelRequestedAt !== null ? { cancelRequestedAt: job.cancelRequestedAt } : {}),
    ...(job.providerCancelled !== null ? { providerCancelled: job.providerCancelled } : {}),
    ...(job.queueReason ? { queueReason: job.queueReason } : {}),
    targets,
    outputs: outputs.map(o => {
      const b = bindings.get(o.outputIndex)
      const delivery: JobView['outputs'][number]['delivery'] = { status: (b?.status ?? 'pending') as BindingStatus }
      if (b?.targetKind === 'slot' && b.nodeId && b.slotId) {
        delivery.nodeId = b.nodeId
        delivery.slotId = b.slotId
      } else if (b?.createdNodeId) {
        const slot = tx.select({ id: s.slots.id }).from(s.slots).where(and(eq(s.slots.nodeId, b.createdNodeId), eq(s.slots.slotKey, 'main'))).get()
        delivery.nodeId = b.createdNodeId
        if (slot) delivery.slotId = slot.id
      }
      return { ...o, delivery }
    }),
    ...(missing.length > 0 ? { missingOutputIndexes: missing } : {}),
    ...(job.error ? { error: job.error as { code: string; message: string } } : {}),
    ...(isRecheckable(tx, job) ? { recheckable: true } : {}),
  }
}

/** Unknown jobs with external IDs stopped only by temporary query/download failures; rechecking cannot help missing jobs, invalid configurations, etc. */
export function isRecheckable(tx: SpaceTx, job: typeof s.generationJobs.$inferSelect): boolean {
  if (job.status !== 'unknown' || (job.error as { code?: string } | null)?.code !== 'retries_exhausted') return false
  const attempt = tx.select({ externalTaskId: s.generationAttempts.externalTaskId }).from(s.generationAttempts)
    .where(eq(s.generationAttempts.jobId, job.id)).orderBy(desc(s.generationAttempts.attemptNo)).get()
  return Boolean(attempt?.externalTaskId)
}

/** Active jobs and failed/cancelled jobs still accepted by target slots; preserves retryable node state after reconnect. */
export function readActiveJobViews(tx: SpaceTx): JobView[] {
  const accepted = new Set(tx.select({ jobId: s.deliveryBindings.jobId }).from(s.deliveryBindings)
    .innerJoin(s.slots, eq(s.slots.acceptedBindingId, s.deliveryBindings.id)).all().map(binding => binding.jobId))
  // Always include recheckable unknown jobs: new-node targets have no canvas slot to attach to and would otherwise disappear after refresh
  return tx.select().from(s.generationJobs)
    .orderBy(s.generationJobs.createdAt).all()
    .filter(job => !TERMINAL_STATUSES.includes(job.status) || (job.status !== 'succeeded' && accepted.has(job.id)) || isRecheckable(tx, job))
    .map(j => readJobView(tx, j.id)!)
}
