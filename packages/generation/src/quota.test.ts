import { expect, it } from 'vitest'
import { createMockProvider, isPaidProvider } from './index'

it('exports the paid-provider policy for callers using runtime or pinned configuration', () => {
  const mock = createMockProvider()
  expect(isPaidProvider(mock)).toBe(false)
  expect(isPaidProvider({ ...mock, type: 'render' })).toBe(false)
  expect(isPaidProvider({ ...mock, type: 'volcengine-ark' })).toBe(true)
  const untyped = { ...mock }
  delete untyped.type
  expect(isPaidProvider(untyped)).toBe(true)
  const configured = { ...untyped, configuration: {
    id: 'ark', type: 'volcengine-ark' as const, label: 'Ark', baseUrl: 'https://unused.invalid', imageModels: [], videoModels: [], audioModels: [],
  } }
  expect(isPaidProvider(configured)).toBe(true)
  expect(isPaidProvider({ ...configured, type: 'mock' })).toBe(false)
})
