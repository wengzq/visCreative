import type { AssetVersionView, NodeView } from '@vis/protocol'
import { beforeEach, expect, it, vi } from 'vitest'
import { numberedReferences } from './prompt-references'
import { useVideoReferences } from './use-video-references'

const hooks = vi.hoisted(() => ({ values: [] as any[], index: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[], writes: 0 }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: unknown) => { hooks.writes++; hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }]
  },
  useRef(initial: unknown) { const index = hooks.index++; return hooks.values[index] ??= { current: initial } },
  useEffect(effect: () => (() => void), deps: unknown[]) {
    const index = hooks.index++
    const previous = hooks.values[index] as unknown[] | undefined
    if (previous?.every((value, i) => value === deps[i])) return
    hooks.values[index] = deps
    hooks.effects.push(() => { hooks.cleanups[index]?.(); hooks.cleanups[index] = effect() })
  },
}))
beforeEach(() => { hooks.values = []; hooks.index = 0; hooks.effects = []; hooks.cleanups = []; hooks.writes = 0 })
const references = (version = 'asset') => numberedReferences(['clip'], [{ nodeId: 'clip', kind: 'video', slots: [
  { slotKey: 'main', content: { type: 'asset', assetVersionId: version } },
] } as NodeView])
function render(resolve?: (id: string) => Promise<AssetVersionView>, version: string | string[] = 'asset') {
  hooks.index = 0
  const result = useVideoReferences(typeof version === 'string' ? references(version) : version.flatMap(references), resolve)
  for (const effect of hooks.effects.splice(0)) effect()
  return result
}
const asset = (durationMs: number) => ({ durationMs }) as AssetVersionView
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

it('resolves pinned video duration without media loading and retains metadata on unrelated rerenders', async () => {
  const resolve = vi.fn(async (_id: string) => asset(3500))
  expect(render(resolve).loading).toBe(true)
  await settle()
  expect(render(resolve)).toMatchObject({ loading: false, references: [{ durationMs: 3500 }] })
  expect(resolve).toHaveBeenCalledExactlyOnceWith('asset')
  render(resolve)
  expect(resolve).toHaveBeenCalledOnce()
})

it('records actual fetch failures separately and allows retrying only failed metadata', async () => {
  const resolve = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(asset(4000))
  render(resolve)
  await settle()
  const failed = render(resolve)
  expect(failed).toMatchObject({ loading: false, failed: true, references: [{ durationMs: undefined }] })
  failed.retry()
  render(resolve)
  await settle()
  expect(render(resolve)).toMatchObject({ loading: false, references: [{ durationMs: 4000 }] })
  expect(resolve).toHaveBeenCalledTimes(2)
})

it('discards late metadata from a previous asset version and invalidates its displayed duration immediately', async () => {
  let finishOld!: (value: AssetVersionView) => void
  const resolve = vi.fn((id: string) => id === 'asset' ? new Promise<AssetVersionView>(done => { finishOld = done }) : Promise.resolve(asset(7000)))
  render(resolve)
  expect(render(resolve, 'new-version')).toMatchObject({ loading: true, references: [{ durationMs: undefined }] })
  await settle()
  finishOld(asset(3000))
  await settle()
  expect(render(resolve, 'new-version')).toMatchObject({ loading: false, references: [{ durationMs: 7000 }] })
})

it('settles absent resolvers and missing or invalid metadata as unavailable', async () => {
  render()
  await settle()
  expect(render()).toMatchObject({ loading: false, references: [{ durationMs: undefined }] })
  for (const [index, duration] of [undefined, Number.NaN, -1].entries()) {
    const resolve = vi.fn(async () => ({ durationMs: duration }) as AssetVersionView)
    render(resolve, `invalid-${index}`)
    await settle()
    expect(render(resolve, `invalid-${index}`)).toMatchObject({ loading: false, failed: false, references: [{ durationMs: undefined }] })
  }
})

it('caches immutable versions across adding, reordering, removing and restoring references', async () => {
  const resolve = vi.fn(async (_id: string) => asset(3500))
  render(resolve)
  await settle()
  render(resolve, ['asset', 'second'])
  await settle()
  expect(resolve.mock.calls.map(call => call[0])).toEqual(['asset', 'second'])
  expect(render(resolve, ['second', 'asset']).references.map(reference => reference.durationMs)).toEqual([3500, 3500])
  render(resolve, [])
  render(resolve, 'asset')
  await settle()
  expect(resolve).toHaveBeenCalledTimes(2)
})

it('does not update state or fetch when no video references exist', async () => {
  const resolve = vi.fn(async (_id: string) => asset(3500))
  expect(render(resolve, []).loading).toBe(false)
  await settle()
  expect(resolve).not.toHaveBeenCalled()
  expect(hooks.writes).toBe(0)
})

it('uses the latest inline resolver without refetching on every render', async () => {
  const resolve = vi.fn(async (_id: string) => asset(3500))
  render(id => resolve(id))
  await settle()
  expect(render(id => resolve(id)).references[0]?.durationMs).toBe(3500)
  await settle()
  render(id => resolve(id))
  expect(resolve).toHaveBeenCalledOnce()
})
