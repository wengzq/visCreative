import { expect, it, vi } from 'vitest'
import { createAgentModelCatalog } from './agentModels'

it('shares pending and completed per-kind client catalog reads across reloads', async () => {
  let resolve!: (models: []) => void
  let clock = 0
  const load = vi.fn(() => new Promise<[]>(done => { resolve = done }))
  const catalog = createAgentModelCatalog(load, () => clock)
  const first = catalog('codex')
  expect(catalog('codex')).toBe(first)
  await Promise.resolve()
  expect(load).toHaveBeenCalledTimes(1)
  resolve([])
  await first
  expect(catalog('codex')).toBe(first)
  clock = 10 * 60_000
  expect(catalog('codex')).not.toBe(first)
  const other = catalog('claude')
  expect(catalog('claude')).toBe(other)
  await Promise.resolve()
  expect(load).toHaveBeenCalledTimes(3)
})

it('keeps failed reads cached briefly without preventing retry after expiry', async () => {
  let clock = 0
  const load = vi.fn(async () => { throw new Error('Unavailable') })
  const catalog = createAgentModelCatalog(load, () => clock)
  const first = catalog('codex')
  await expect(first).rejects.toThrow('Unavailable')
  expect(catalog('codex')).toBe(first)
  expect(load).toHaveBeenCalledTimes(1)
  clock = 30_000
  await expect(catalog('codex')).rejects.toThrow('Unavailable')
  expect(load).toHaveBeenCalledTimes(2)
})
