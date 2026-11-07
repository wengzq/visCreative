import type { ReactElement, ReactNode } from 'react'
import type { MethodResult } from '@vis/protocol'
import { beforeEach, expect, it, vi } from 'vitest'
import { ScriptBatchDialog } from './ScriptBatchDialog'
import type { ScriptPartProps } from './script-ui'

const hooks = vi.hoisted(() => ({
  values: [] as any[], index: 0, effects: [] as (() => void)[],
  context: { catalog: {
    defaults: { image: { provider: 'mock', model: 'image' }, video: { provider: 'mock', model: 'video' } },
    providers: [{ id: 'mock', label: 'Mock', available: true, needsKey: false, hasKey: false, models: [
      { id: 'image', label: 'Image', kind: 'image', paramsSchema: {} },
      { id: 'video', label: 'Video', kind: 'video', paramsSchema: {} },
      { id: 'other', label: 'Other video', kind: 'video', paramsSchema: {} },
    ] }],
  } },
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useContext: () => hooks.context,
  useState(initial: unknown) {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }]
  },
  useRef(initial: unknown) { const index = hooks.index++; return hooks.values[index] ??= { current: initial } },
  useMemo: (fn: () => unknown) => fn(),
  useEffect(fn: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.index++
    const previous = hooks.values[index]
    // The component memoizes its request from the serialized options.
    const key = JSON.stringify(deps)
    if (previous?.key === key) return
    previous?.cleanup?.()
    const record = { key, cleanup: undefined as (() => void) | void }
    hooks.values[index] = record
    hooks.effects.push(() => { record.cleanup = fn() })
  },
}))
vi.mock('react-dom', () => ({ createPortal: (value: unknown) => value }))
vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useFormat: () => ({ number: String }),
  useLocale: () => ({ locale: 'en' }),
}))
beforeEach(() => {
  hooks.values = []; hooks.index = 0; hooks.effects = []
  vi.stubGlobal('document', { body: {}, activeElement: null })
})

function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  return [value as ReactElement<any>, ...elements((value as ReactElement<any>).props.children)]
}
const parts = { view: { nodeId: 'script' }, doc: { shots: [
  { id: 'one', description: 'First', transition: 'cut' },
  { id: 'two', description: 'Second', transition: 'continuous' },
] } } as ScriptPartProps
const plan: MethodResult<'script.batch.plan'> = {
  scriptNodeId: 'script', media: 'video',
  estimate: { shots: 2, jobs: 2, billedJobs: 0, provider: 'mock', model: 'video', quotaRemaining: null, staleShots: 0, shotsMissingAssetImages: 0, shotsMissingFirstFrame: 2, shotsWithoutPrompt: 0 },
  shots: [],
}

it('filters models by media, replans video choices and ignores stale dry-run responses', async () => {
  const resolves: ((value: typeof plan) => void)[] = []
  const planner = vi.fn(() => new Promise<typeof plan>(resolve => resolves.push(resolve)))
  const start = vi.fn()
  const close = vi.fn()
  const render = () => {
    hooks.index = 0
    const tree = elements(ScriptBatchDialog({ parts, media: 'video', actions: { onPlanScriptBatch: planner, onStartScriptBatch: start }, onClose: close }))
    hooks.effects.splice(0).forEach(effect => effect())
    return tree
  }
  const select = (label: string) => render().find(element => element.type === 'select' && element.props['aria-label'] === label)!
  const confirm = () => render().find(element => element.type === 'button' && element.props.children === 'Confirm generation')!
  expect(confirm().props.disabled).toBe(true)
  expect(elements(select('Model')).filter(element => element.type === 'option').map(element => element.props.value)).toEqual(['mock/video', 'mock/other'])
  expect(planner).toHaveBeenLastCalledWith(expect.objectContaining({ media: 'video', provider: 'mock', model: 'video', missingFirstFrames: 'generate' }))
  select('Model').props.onChange({ target: { value: 'mock/other' } })
  render()
  resolves[0]!(plan)
  await Promise.resolve()
  expect(confirm().props.disabled).toBe(true)
  resolves[1]!({ ...plan, estimate: { ...plan.estimate, model: 'other' } })
  await Promise.resolve()
  expect(confirm().props.disabled).toBe(false)
  const strict = render().find(element => element.type === 'input' && element.props.type === 'checkbox')!
  strict.props.onChange({ target: { checked: true } })
  render()
  expect(planner).toHaveBeenLastCalledWith(expect.objectContaining({ strictShotIds: ['two'] }))
  select('When first frames are missing').props.onChange({ target: { value: 'skip' } })
  render()
  expect(planner).toHaveBeenLastCalledWith(expect.objectContaining({ missingFirstFrames: 'skip', strictShotIds: ['two'] }))
  render().find(element => element.type === 'button' && element.props.children === 'Cancel')!.props.onClick()
  expect(close).toHaveBeenCalledOnce()
  expect(start).not.toHaveBeenCalled()
})
