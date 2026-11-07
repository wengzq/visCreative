import { describe, expect, it } from 'vitest'
import { shallowEqual } from './render-state'

describe('Canvas render selection equality', () => {
  it('Reuses slices with the same node, history and callback references', () => {
    const view = { revision: 1 }
    const history = [1, 2]
    const resize = () => {}
    expect(shallowEqual({ view, history, resize, selectedId: null }, { view, history, resize, selectedId: null })).toBe(true)
    expect(shallowEqual({ view, history, resize, selectedId: null }, { view, history, resize, selectedId: 'own' })).toBe(false)
    expect(shallowEqual({ view, history }, { view: { revision: 1 }, history })).toBe(false)
    expect(shallowEqual({ view, history }, { view, history: [1, 2] })).toBe(false)
  })

  it('Does not confuse maps or missing keys with equal selected state', () => {
    expect(shallowEqual(new Map(), new Map())).toBe(false)
    expect(shallowEqual({ first: undefined }, { second: undefined })).toBe(false)
    expect(shallowEqual({ first: 1 }, { first: 1 })).toBe(true)
    expect(shallowEqual(['first', 'second'], ['first', 'second'])).toBe(true)
    expect(shallowEqual(['first', 'second'], ['second', 'first'])).toBe(false)
    expect(shallowEqual(['first'], ['first', 'second'])).toBe(false)
  })

  it('Compares primitive flags and optional values without coercion', () => {
    expect(shallowEqual(null, null)).toBe(true)
    expect(shallowEqual(null, undefined)).toBe(false)
    expect(shallowEqual(false, false)).toBe(true)
    expect(shallowEqual<unknown>(false, 0)).toBe(false)
    expect(shallowEqual(NaN, NaN)).toBe(true)
  })
})
