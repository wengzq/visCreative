import type { ReactElement, ReactNode } from 'react'
import type { ApprovalPayload, BatchView } from '@vis/protocol'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApprovalCard } from './ApprovalCard'
import { BatchApprovalCard } from './BatchApprovalCard'

const hooks = vi.hoisted(() => ({ values: [] as any[], index: 0 }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }]
  },
  useRef(initial: unknown) { const index = hooks.index++; return hooks.values[index] ??= { current: initial } },
  useEffect() {},
}))
vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useLocale: () => ({ locale: 'en' }),
  useFormat: () => ({ number: String }),
}))
beforeEach(() => { hooks.values = []; hooks.index = 0 })

const approval: ApprovalPayload = { approvalId: 'approval', batchId: 'batch', kind: 'generation_batch', status: 'pending', summary: 'Batch', detail: '' }
const batch: BatchView = {
  batchId: 'batch', scriptNodeId: 'script', status: 'pending_approval', origin: 'agent', sessionId: 'session', media: 'frames', createdAt: 1,
  estimate: { shots: 1, jobs: 1, billedJobs: 0, provider: 'mock', model: 'mock-image-1', quotaRemaining: null, staleShots: 1, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 },
  shots: [{ shotId: 'one', steps: [{ role: 'first', status: 'waiting' }] }], changedShotIds: ['one'],
}
function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  return [value as ReactElement<any>, ...elements((value as ReactElement<any>).props.children)]
}

it('routes generation_batch to its dedicated card instead of command approval', () => {
  const commandRespond = vi.fn()
  const tree = ApprovalCard({ approval, onRespond: commandRespond, batch }) as ReactElement<any>
  expect(tree.type).toBe(BatchApprovalCard)
  expect(tree.props.onRespond).toBeUndefined()
  expect(commandRespond).not.toHaveBeenCalled()
  expect(tree.props.batch.changedShotIds).toEqual(['one'])
})

it.each(['approve', 'reject'] as const)('answers %s through the batch method with one stable request ID and shows the outcome', async decision => {
  const outcome = { ...batch, status: decision === 'approve' ? 'running' : 'rejected' } as BatchView
  const respond = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(outcome)
  const render = () => { hooks.index = 0; return elements(BatchApprovalCard({ approval, batch, onRespondBatch: respond })) }
  const button = () => render().find(element => element.type === 'button' && element.props.children === (decision === 'approve' ? 'Approve' : 'Reject'))!
  const first = button().props.onClick()
  button().props.onClick()
  await first
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
  expect(render().some(element => element.props.role === 'alert')).toBe(true)
  button().props.onClick()
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
  expect(respond.mock.calls[0]).toEqual(respond.mock.calls[1])
  expect(respond.mock.calls[0]!.slice(0, 2)).toEqual(['batch', decision])
  await vi.waitFor(() => expect(render().some(element => element.type === 'button' && ['Approve', 'Reject'].includes(element.props.children))).toBe(false))
  if (decision === 'approve') {
    hooks.index = 0
    expect(elements(BatchApprovalCard({ approval, batch: { ...batch, status: 'succeeded' } }))[0]!.props.className).toContain('is-succeeded')
  }
})

it.each(['rejected', 'expired', 'succeeded'] as const)('renders the %s outcome without approval controls', status => {
  const tree = elements(BatchApprovalCard({ approval, batch: { ...batch, status } }))
  expect(tree[0]!.props.className).toContain(`is-${status}`)
  expect(tree.some(element => element.type === 'button' && ['Approve', 'Reject'].includes(element.props.children))).toBe(false)
})
