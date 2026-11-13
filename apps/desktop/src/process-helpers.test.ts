import { expect, it, vi } from 'vitest'
import { cleanupStudiod, selectStudiodPid } from '../e2e/process-helpers'

it('selects the matching daemon from multiple lsof PIDs and duplicate entries', () => {
  expect(selectStudiodPid('101\n202\n202\n303\n', pid => pid === 202)).toBe(202)
  expect(selectStudiodPid('', () => true)).toBeUndefined()
  expect(() => selectStudiodPid('101\n202\n', () => true)).toThrow('Multiple studiod processes')
})

it('removes temporary data after a graceful stop without sending a signal', async () => {
  let alive = true
  const terminate = vi.fn()
  const remove = vi.fn()
  await cleanupStudiod({ shutdown: async () => { alive = false }, waitForExit: async () => {}, alive: () => alive, terminate, remove })
  expect(terminate).not.toHaveBeenCalled()
  expect(remove).toHaveBeenCalledOnce()
})

it('stops the identified daemon and removes data even when shutdown throws', async () => {
  let alive = true
  const events: string[] = []
  await expect(cleanupStudiod({
    shutdown: async () => { throw new Error('RPC failed') },
    waitForExit: async () => { expect(alive).toBe(false) },
    alive: () => alive,
    terminate: signal => {
      events.push(signal)
      alive = false
    },
    remove: () => { events.push('removed') },
  })).rejects.toThrow('RPC failed')
  expect(events).toEqual(['SIGTERM', 'removed'])
})

it('bounds a hung shutdown and escalates a daemon that ignores SIGTERM', async () => {
  let alive = true
  const signals: string[] = []
  const remove = vi.fn()
  await expect(cleanupStudiod({
    shutdown: () => new Promise(() => {}), shutdownTimeoutMs: 5,
    waitForExit: async () => { if (alive) throw new Error('Still alive') },
    alive: () => alive,
    terminate: signal => {
      signals.push(signal)
      if (signal === 'SIGKILL') alive = false
    },
    remove,
  })).rejects.toThrow('shutdown timed out')
  expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(remove).toHaveBeenCalledOnce()
})

it('retains data if the identified daemon cannot be stopped', async () => {
  const remove = vi.fn()
  await expect(cleanupStudiod({
    shutdown: async () => { throw new Error('RPC failed') },
    waitForExit: async () => { throw new Error('Still alive') }, alive: () => true,
    terminate: () => {}, remove,
  })).rejects.toThrow('Still alive')
  expect(remove).not.toHaveBeenCalled()
})
