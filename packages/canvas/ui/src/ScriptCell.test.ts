import type { ReactElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ScriptCell } from './ScriptCell'

const hooks = vi.hoisted(() => ({ values: [] as any[], index: 0 }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }]
  },
  useRef(initial: unknown) {
    const index = hooks.index++
    return hooks.values[index] ??= { current: initial }
  },
  useLayoutEffect() {},
}))
beforeEach(() => { hooks.values = []; hooks.index = 0 })

function cell(onSave: (text: string, rev: number) => Promise<void>) {
  let value = 'Original'
  let rev = 2
  const render = () => {
    hooks.index = 0
    return (ScriptCell({ value, rev, assets: [], label: 'Description', disabled: false, onSave }) as ReactElement<any>).props.children as ReactElement<any>
  }
  render().props.onClick()
  render().props.onChange('My draft')
  return { render, current(text: string, revision: number) { value = text; rev = revision } }
}

it('keeps a failed draft and its starting revision available for retry', async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined)
  const editor = cell(onSave)
  editor.current('Agent edit', 3)
  editor.render().props.onCommit()
  await vi.waitFor(() => {
    expect(editor.render().props.value).toBe('My draft')
    expect(editor.render().props.disabled).toBe(false)
  })
  expect(onSave).toHaveBeenCalledWith('My draft', 2)
  editor.render().props.onCommit()
  await vi.waitFor(() => expect(editor.render().props.className).toBe('vis-script-cell-value'))
  expect(onSave).toHaveBeenCalledTimes(2)
})

it('shows the current value after a row conflict and starts the next edit at the new revision', async () => {
  const onSave = vi.fn().mockRejectedValueOnce({ code: 'revision_conflict' }).mockResolvedValue(undefined)
  const editor = cell(onSave)
  editor.current('Agent edit', 3)
  editor.render().props.onCommit()
  await vi.waitFor(() => expect(editor.render().props.className).toBe('vis-script-cell-value'))
  expect(editor.render().props.children.props.children.props.text).toBe('Agent edit')
  editor.render().props.onClick()
  editor.render().props.onCommit()
  await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith('Agent edit', 3))
})
