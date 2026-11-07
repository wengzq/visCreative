import { beforeEach, expect, it, vi } from 'vitest'
import { useReferencePick } from './CanvasView'

const hooks = vi.hoisted(() => ({ values: [] as any[], index: 0 }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value }]
  },
  useRef(initial: unknown) {
    const index = hooks.index++
    return hooks.values[index] ??= { current: initial }
  },
  useCallback(callback: unknown) {
    const index = hooks.index++
    return hooks.values[index] ??= callback
  },
  useEffect() {},
}))
beforeEach(() => { hooks.values = []; hooks.index = 0 })
const render = () => { hooks.index = 0; return useReferencePick() }

it('keeps pick actions stable when the target changes', () => {
  const initial = render()
  initial.pickImage('script', vi.fn())
  const next = render()
  expect(next.pickImage).toBe(initial.pickImage)
  expect(next.setPickingId).toBe(initial.setPickingId)
})

it.each(['script', 'another-script'])('uses the requested %s as the image target without a selection argument', scriptNodeId => {
  render().pickImage(scriptNodeId, vi.fn())
  expect(render().pickingId).toBe(scriptNodeId)
})

it.each([null, 'reference-target'])('clears an image callback synchronously when pick mode changes to %s', target => {
  const callback = vi.fn()
  render().pickImage('script', callback)
  render().setPickingId(target)
  expect(render().imagePick.current).toBeNull()
  render().setPickingId('reference-target')
  expect(render().imagePick.current).toBeNull()
  expect(callback).not.toHaveBeenCalled()
})
