import { renameSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const retryDelay = (error: unknown, attempt: number, platform: NodeJS.Platform) =>
  platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM' && attempt < 7 ? 10 * 2 ** attempt : null

/** Windows readers can briefly block rename. Never unlink the destination: replacement must stay atomic. */
export async function replaceFile(source: string, destination: string, options: {
  platform?: NodeJS.Platform
  rename?: typeof rename
  wait?: (ms: number) => Promise<unknown>
} = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await (options.rename ?? rename)(source, destination); return }
    catch (error) {
      const delay = retryDelay(error, attempt, options.platform ?? process.platform)
      if (delay === null) throw error
      await (options.wait ?? setTimeout)(delay)
    }
  }
}

/** Synchronous transactions cannot yield; cap the same retry policy at 1.27 seconds. Recheck author edits each time. */
export function replaceFileSync(source: string, destination: string, options: {
  platform?: NodeJS.Platform
  rename?: typeof renameSync
  wait?: (ms: number) => void
  beforeAttempt?: () => void
} = {}): void {
  for (let attempt = 0; ; attempt++) {
    options.beforeAttempt?.()
    try { (options.rename ?? renameSync)(source, destination); return }
    catch (error) {
      const delay = retryDelay(error, attempt, options.platform ?? process.platform)
      if (delay === null) throw error
      if (options.wait) options.wait(delay)
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
  }
}
