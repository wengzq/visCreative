import type { JobView, TranscriptItem } from '@vis/protocol'

export type ToolCall = { call?: TranscriptItem; result?: TranscriptItem }
export type ToolTranscriptGroup = { kind: 'tools'; itemId: string; calls: ToolCall[] }
export type TranscriptGroup = ToolTranscriptGroup | { kind: 'item'; item: TranscriptItem }

function generationJobId(pair: ToolCall): string | undefined {
  const input = (pair.call?.payload as { input?: { jobId?: unknown } } | undefined)?.input
  const text = (pair.result?.payload as { text?: unknown } | undefined)?.text
  let result: unknown = text
  if (typeof text === 'string') {
    try { result = JSON.parse(text) } catch { /* Non-JSON or truncated tool results have no job ID to link */ }
  }
  const jobId = result && typeof result === 'object' && 'jobId' in result ? result.jobId : input?.jobId
  return typeof jobId === 'string' && jobId.length ? jobId : undefined
}

/** Tool receipts retain status at submission time; job events supplement later cancellation status. */
export function generationJob(pair: ToolCall, jobs: ReadonlyMap<string, JobView> | undefined): JobView | undefined {
  const jobId = jobs?.size ? generationJobId(pair) : undefined
  return jobId ? jobs?.get(jobId) : undefined
}

export function transcriptGenerationJobIds(items: TranscriptItem[]): string[] {
  return [...new Set(groupTranscript(items).flatMap(group => group.kind === 'tools'
    ? group.calls.flatMap(pair => { const jobId = generationJobId(pair); return jobId ? [jobId] : [] }) : []))]
}

function toolUseId(item: TranscriptItem): string | undefined {
  const id = (item.payload as { toolUseId?: unknown } | null)?.toolUseId
  return typeof id === 'string' && id.length ? id : undefined
}

export function groupTranscript(items: TranscriptItem[]): TranscriptGroup[] {
  const calls: ToolCall[] = items.filter(item => item.kind === 'tool_call').map(call => ({ call }))
  const pairs = new Map(calls.map(pair => [pair.call!, pair]))
  // Text may arrive during tool execution; still merge results under the original call.
  for (const item of items) {
    if (item.kind !== 'tool_result') continue
    const id = toolUseId(item)
    const pair = id === undefined ? undefined : calls.find(candidate =>
      !candidate.result && toolUseId(candidate.call!) === id,
    )
    if (pair) pair.result = item
    else pairs.set(item, { result: item })
  }
  const groups: TranscriptGroup[] = []
  let tools: ToolTranscriptGroup | undefined
  for (const item of items) {
    if (item.kind !== 'tool_call' && item.kind !== 'tool_result') {
      groups.push({ kind: 'item', item })
      tools = undefined
      continue
    }
    if (!tools) {
      tools = { kind: 'tools', itemId: item.itemId, calls: [] }
      groups.push(tools)
    }
    const pair = pairs.get(item)
    if (pair) tools.calls.push(pair)
  }
  return groups.filter(group => group.kind === 'item' || group.calls.length > 0)
}
