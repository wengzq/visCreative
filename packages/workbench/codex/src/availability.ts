import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { resolveExecutable } from '@vis/workbench-core'

/** Inspect executable paths only: listing Agents never starts a process or reads credentials. */
export function codexAvailability(explicitPath?: string, env: Record<string, string | undefined> = process.env) {
  const requested = explicitPath ?? 'codex'
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const directories = explicitPath || isAbsolute(requested) ? [''] : path.split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' && !/\.[^/\\]+$/.test(requested) ? ['', '.exe', '.cmd', '.com'] : ['']
  const available = directories.some(directory => suffixes.some(suffix => {
    try {
      const candidate = resolve(directory.replace(/^"|"$/g, ''), `${requested}${suffix}`)
      if (!statSync(candidate).isFile()) return false
      accessSync(candidate, constants.X_OK)
      resolveExecutable('codex', candidate, env)
      return true
    } catch { return false }
  }))
  return available ? { available } : { available, reason: 'executable_missing' }
}
