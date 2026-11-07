import type { ReactElement, ReactNode } from 'react'
import { SCRIPT_LIMITS } from '@vis/protocol'
import { expect, it, vi } from 'vitest'
import { ScriptAssetCards } from './ScriptAssetCards'
import type { ScriptPartProps } from './script-ui'

const hooks = vi.hoisted(() => ({ values: [] as any[], index: 0, picker: vi.fn() }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value }]
  },
}))
vi.mock('./CanvasView', () => ({
  useCanvasSelector: (select: (state: unknown) => unknown) => select({
    nodes: [], actions: { renderScriptSettingPicker: hooks.picker },
  }),
}))
vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useFormat: () => ({ number: String }),
  useLocale: () => ({ locale: 'en' }),
}))
function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ReactElement<any>
  return [element, ...elements(element.props.children)]
}

it('opens the library at the cast limit and passes style selection separately', () => {
  hooks.values = []; hooks.picker.mockClear()
  const onPatch = vi.fn()
  const props = { doc: { rev: 1, styleId: 'current-style', assets: Array.from({ length: SCRIPT_LIMITS.assets }, (_, index) => ({
    id: `cast-${index}`, kind: 'character', name: `Cast ${index}`,
  })) }, onPatch } as unknown as ScriptPartProps
  const tree = () => { hooks.index = 0; return elements(ScriptAssetCards(props)) }
  const open = tree().find(item => item.type === 'button' && item.props.children === 'Add from library')!
  expect(open.props.disabled).toBe(false)
  open.props.onClick()
  tree()
  const picker = hooks.picker.mock.calls[0]![0]
  expect(picker).toMatchObject({ styleId: 'current-style', castLimitReached: true })
  expect(picker.castIds).not.toContain('current-style')
  picker.onPick({ id: 'new-style', kind: 'style' })
  expect(onPatch).toHaveBeenCalledWith([{ kind: 'doc.set', rev: 1, fields: { styleId: 'new-style' } }])
})
