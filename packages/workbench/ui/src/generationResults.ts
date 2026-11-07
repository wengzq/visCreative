import type { JobView, TranscriptItem } from '@vis/protocol'
import { generationJob } from './toolGroups'

/** Results occupy their last actual tool mention, including receipts after a visible message. */
export function generationResults(items: TranscriptItem[], jobs: ReadonlyMap<string, JobView> | undefined): Map<string, JobView[]> {
  const last = new Map<string, { itemId: string; job: JobView }>()
  for (const item of items) {
    if (item.kind !== 'tool_call' && item.kind !== 'tool_result') continue
    const job = generationJob(item.kind === 'tool_call' ? { call: item } : { result: item }, jobs)
    if (job) { last.delete(job.jobId); last.set(job.jobId, { itemId: item.itemId, job }) }
  }
  const results = new Map<string, JobView[]>()
  for (const { itemId, job } of last.values()) results.set(itemId, [...results.get(itemId) ?? [], job])
  return results
}

export const resultState = (status: JobView['status']) => ['queued', 'running', 'finalizing'].includes(status) ? 'running' : status

export function resultOutputs(job: JobView, expanded: boolean) {
  return expanded ? job.outputs : job.outputs.slice(0, 4)
}
