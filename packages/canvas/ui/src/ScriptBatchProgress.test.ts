import type { ReactElement, ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { BatchView, NodeView } from '@vis/protocol'
import { ScriptBatchSummary, ShotBatchProgress } from './ScriptBatchProgress'
import { VideoPoster } from './VideoPoster'

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (current: unknown) => ({ current }),
}))

vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useLocale: () => ({ locale: 'en' }),
  useFormat: () => ({ number: String }),
}))

function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  return [value as ReactElement<any>, ...elements((value as ReactElement<any>).props.children)]
}

it('renders waiting reasons, errors, extraction and the completed output thumbnail in shot rows', () => {
  const batch = {
    batchId: 'batch', scriptNodeId: 'script', origin: 'user', media: 'video',
    estimate: { shots: 1, jobs: 3, billedJobs: 0, provider: 'mock', model: 'mock-video-1', quotaRemaining: 0, staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 },
    createdAt: 1, status: 'paused', shots: [{ shotId: 'one', steps: [
      { role: 'first', status: 'succeeded', source: 'extract', nodeId: 'image' },
      { role: 'last', status: 'failed', error: { code: 'unavailable', message: 'Provider offline' } },
      { role: 'video', status: 'waiting', blockedBy: 'waiting_previous' },
    ] }],
  } as BatchView
  const focus = vi.fn()
  const nodes = [{ nodeId: 'image', slots: [{ slotKey: 'main', content: { type: 'asset', assetVersionId: 'asset' } }] }] as NodeView[]
  const urls = { assetUrl: (id: string) => `/assets/${id}`, posterUrl: (id: string) => `/posters/${id}` }
  const tree = elements(ShotBatchProgress({ batches: [batch], shotId: 'one', nodes, ...urls, onFocus: focus }))
  const children = JSON.stringify(tree.map(element => element.props.children))
  expect(children).toContain('Waiting for the previous shot')
  expect(children).toContain('Extracted from the previous video')
  expect(children).toContain('Provider offline')
  expect(tree.find(element => element.type === 'img')?.props.src).toBe('/assets/asset')
  tree.find(element => element.type === 'button')!.props.onClick()
  expect(focus).toHaveBeenCalledWith('image')
  const quota = { ...batch, shots: [{ shotId: 'one', steps: [{ role: 'video', status: 'waiting', blockedBy: 'quota' }] }] } as BatchView
  expect(JSON.stringify(ShotBatchProgress({ batches: [quota], shotId: 'one', nodes: [], ...urls, onFocus: focus }))).toContain('Paused for the daily quota')
  const video = { ...batch, shots: [{ shotId: 'one', steps: [{ role: 'video', status: 'succeeded', nodeId: 'image' }] }] } as BatchView
  const output = elements(ShotBatchProgress({ batches: [video], shotId: 'one', nodes, ...urls, onFocus: focus }))
  expect(output.some(element => element.type === 'video')).toBe(false)
  expect(output.find(element => element.type === VideoPoster)?.props).toMatchObject({ src: '/assets/asset', posterSrc: '/posters/asset' })
})

it.each([
  [true, 'The provider confirmed cancellation'],
  [false, 'Cancelled locally only'],
  [undefined, 'Provider cancellation has not been confirmed'],
] as const)('shows the actual provider cancellation result %s without promising a refund', (providerCancelled, expected) => {
  const batch: BatchView = { batchId: 'batch', scriptNodeId: 'script', origin: 'user', media: 'frames', createdAt: 1, status: 'cancelled',
    estimate: { shots: 1, jobs: 1, billedJobs: 0, provider: 'mock', model: 'mock-image-1', quotaRemaining: null, staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 },
    shots: [{ shotId: 'shot', steps: [{ role: 'first', status: 'cancelled', jobId: 'job' }] }] }
  const value = ScriptBatchSummary({ batches: [batch], actions: {}, jobs: [{ jobId: 'job', status: 'cancelled', outputs: [], targets: [], ...(providerCancelled !== undefined ? { providerCancelled } : {}) }] })
  expect(JSON.stringify(value)).toContain(expected)
  expect(JSON.stringify(value)).toContain('Cancelling is not a refund')
})

it('hides an older cancellation notice when a newer batch exists, regardless of array order', () => {
  const cancelled: BatchView = { batchId: 'old', scriptNodeId: 'script', origin: 'user', media: 'frames', createdAt: 1, status: 'cancelled',
    estimate: { shots: 1, jobs: 1, billedJobs: 0, provider: 'mock', model: 'mock-image-1', quotaRemaining: null, staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 0, shotsWithoutPrompt: 0 },
    shots: [{ shotId: 'shot', steps: [{ role: 'first', status: 'cancelled', jobId: 'job' }] }] }
  const newest = { ...cancelled, batchId: 'new', createdAt: 2, status: 'running' as const, shots: [] }
  for (const batches of [[cancelled, newest], [newest, cancelled]]) {
    const value = ScriptBatchSummary({ batches, actions: {}, jobs: [{ jobId: 'job', status: 'cancelled', providerCancelled: true, outputs: [], targets: [] }] })
    expect(JSON.stringify(value)).not.toContain('Cancelling is not a refund')
    expect(JSON.stringify(value)).not.toContain('The provider confirmed cancellation')
  }
})
