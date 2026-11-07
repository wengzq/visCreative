import type { BatchView, MethodParams, Shot } from '@vis/protocol'

export const activeBatch = (batch: BatchView) => ['pending_approval', 'running', 'paused'].includes(batch.status)

export function batchShotIds(shots: readonly Shot[], selected: ReadonlySet<string>) {
  const ids = shots.filter(shot => selected.has(shot.id)).map(shot => shot.id)
  return ids.length ? ids : undefined
}

/** Freeze an attempt after submission: retries use exactly the same payload and request ID. */
export function batchAttempt(start: (params: MethodParams<'script.batch.start'>) => Promise<BatchView>, requestId: string) {
  let params: MethodParams<'script.batch.start'> | undefined
  let pending: Promise<BatchView> | undefined
  let completed: BatchView | undefined
  return {
    get submitted() { return !!params },
    get plan() {
      if (!params) return
      const { requestId: _requestId, ...plan } = params
      return plan
    },
    run(plan: MethodParams<'script.batch.plan'>) {
      if (completed) return Promise.resolve(completed)
      if (pending) return pending
      params ??= { ...structuredClone(plan), requestId }
      pending = Promise.resolve().then(() => start(params!)).then(result => { completed = result; return result }).finally(() => { pending = undefined })
      return pending
    },
  }
}

export function shotBatchSteps(batches: readonly BatchView[], shotId: string) {
  const roles = new Map<string, { batch: BatchView; step: BatchView['shots'][number]['steps'][number] }>()
  for (const batch of [...batches].sort((a, b) => a.createdAt - b.createdAt)) {
    if (batch.status === 'rejected' || batch.status === 'expired') continue
    for (const step of batch.shots.find(shot => shot.shotId === shotId)?.steps ?? []) roles.set(step.role, { batch, step })
  }
  return [...roles.values()].sort((a, b) => ['first', 'last', 'video'].indexOf(a.step.role) - ['first', 'last', 'video'].indexOf(b.step.role))
}
