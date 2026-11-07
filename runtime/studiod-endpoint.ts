import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Local endpoint shared by entry points; not part of the RPC contract and adds no backend package dependencies. */
export function studiodEndpoint(dataDir: string): string {
  if (process.platform !== 'win32') return join(dataDir, 'run', 'studiod.sock')
  const missing: string[] = []
  let parent = resolve(dataDir)
  for (;;) {
    try {
      parent = realpathSync.native(parent)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const next = dirname(parent)
      if (next === parent) throw error
      missing.unshift(basename(parent))
      parent = next
    }
  }
  const canonical = join(parent, ...missing).toLowerCase()
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\vis-studiod-${hash}`
}
