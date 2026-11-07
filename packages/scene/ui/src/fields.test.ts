import type { ChangeEvent, ComponentProps, FocusEvent, KeyboardEvent, ReactElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NumberField } from './fields'

const hooks = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as (() => void)[], stateIndex: 0, refIndex: 0,
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(value: unknown) {
    const index = hooks.stateIndex++
    if (!(index in hooks.state)) hooks.state[index] = value
    return [hooks.state[index], (next: unknown) => { hooks.state[index] = next }]
  },
  useRef(value: unknown) { return hooks.refs[hooks.refIndex++] ??= { current: value } },
  useEffect(effect: () => void) { hooks.effects.push(effect) },
}))
afterEach(() => { hooks.state = []; hooks.refs = []; hooks.effects = [] })

function field(value = 0) {
  const onChange = vi.fn()
  let props: ComponentProps<'input'>
  const render = () => {
    hooks.stateIndex = hooks.refIndex = 0
    const element = NumberField({ label: 'Joint rotation', value, disabled: false, min: -180, max: 180, commitOnBlur: true, onChange })
    props = (element.props.children[1] as ReactElement<ComponentProps<'input'>>).props
    hooks.effects.splice(0).forEach(effect => effect())
  }
  const input = {
    value: '', valueAsNumber: 0, validity: { valid: true },
    closest: () => ({ focus: vi.fn() }),
    blur: () => { props.onBlur!({ target: input } as unknown as FocusEvent<HTMLInputElement>) },
  }
  render()
  const type = (text: string) => {
    Object.assign(input, { value: text, valueAsNumber: Number(text) })
    props.onChange!({ target: input } as unknown as ChangeEvent<HTMLInputElement>)
    render()
  }
  return {
    onChange,
    focus() { props.onFocus!({} as FocusEvent<HTMLInputElement>); render(); Object.assign(input, { value: String(props.value), valueAsNumber: Number(props.value) }) },
    type,
    blur: input.blur,
    escape() {
      props.onKeyDown!({ key: 'Escape', currentTarget: input, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent<HTMLInputElement>)
      render()
    },
    text: () => String(props.value),
  }
}

it.each([0, -12.12345678])('does not commit or round an unchanged joint field on blur: %s', value => {
  const input = field(value)
  input.focus()
  input.blur()
  expect(input.onChange).not.toHaveBeenCalled()
})

it('commits changed joint text once on blur and cancels typed text on Escape', () => {
  const input = field(-10)
  input.focus()
  input.type('-42')
  expect(input.onChange).not.toHaveBeenCalled()
  input.blur()
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith(-42)
  input.onChange.mockClear()
  input.focus()
  input.type('-80')
  input.escape()
  expect(input.onChange).not.toHaveBeenCalled()
  expect(input.text()).toBe('-10')
})
