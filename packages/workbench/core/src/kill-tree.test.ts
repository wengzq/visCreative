import { describe, expect, it, vi } from 'vitest'
import { killTree } from './kill-tree'

const child = (state: { exitCode?: number | null; signalCode?: string | null } = {}) => ({
  pid: 42, exitCode: null, signalCode: null, ...state, kill: vi.fn(() => true),
}) as unknown as Parameters<typeof killTree>[0] & { kill: ReturnType<typeof vi.fn> }

describe('killTree', () => {
  it('Windows: stops the whole tree with taskkill instead of kill()', async () => {
    const c = child()
    const taskkill = vi.fn(async () => {})
    await killTree(c, 'SIGTERM', { platform: 'win32', taskkill })
    expect(taskkill).toHaveBeenCalledWith(42)
    expect(c.kill).not.toHaveBeenCalled()
  })

  it('POSIX: sends the signal to the process', async () => {
    const c = child()
    const taskkill = vi.fn(async () => {})
    await killTree(c, 'SIGKILL', { platform: 'darwin', taskkill })
    expect(c.kill).toHaveBeenCalledWith('SIGKILL')
    expect(taskkill).not.toHaveBeenCalled()
  })

  it('does nothing for an exited process, whose pid may already belong to another process', async () => {
    for (const state of [{ exitCode: 0 }, { signalCode: 'SIGTERM' }]) {
      const c = child(state)
      const taskkill = vi.fn(async () => {})
      await killTree(c, 'SIGTERM', { platform: 'win32', taskkill })
      await killTree(c, 'SIGTERM', { platform: 'darwin', taskkill })
      expect(taskkill).not.toHaveBeenCalled()
      expect(c.kill).not.toHaveBeenCalled()
    }
  })
})

describe('killTree with test doubles', () => {
  it('never tree-kills a pid it did not spawn: a fake child gets kill() even on Windows', async () => {
    const fake = { pid: process.pid, exitCode: null, signalCode: null, kill: vi.fn(() => true) } as unknown as Parameters<typeof killTree>[0] & { kill: ReturnType<typeof vi.fn> }
    await killTree(fake, 'SIGTERM', { platform: 'win32' })
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
