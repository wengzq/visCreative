import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { resolveExecutable } from '@vis/workbench-core'

export type ResolveCodebuddyOptions = {
  codebuddyPath?: string
  env?: Record<string, string | undefined>
}

function executable(path: string, env: Record<string, string | undefined>): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    if (process.platform === 'win32') resolveExecutable('codebuddy', path, env)
    return true
  } catch {
    return false
  }
}

/** Locate an installed executable without running it or inspecting the Agent's saved state. */
export function resolveCodebuddy(options: ResolveCodebuddyOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const override = options.codebuddyPath ?? env.VIS_CODEBUDDY_PATH
  if (override !== undefined) {
    if (!override) return
    const path = resolve(override)
    return executable(path, env) ? path : undefined
  }
  const lookup = (key: string) => process.platform === 'win32'
    ? Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : env[key]
  const directories = (lookup('PATH') ?? '').split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' ? [...(lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : ['']
  for (const name of ['codebuddy', 'cbc']) {
    for (const dir of directories) {
      for (const suffix of suffixes) {
        const path = resolve(dir.replace(/^"|"$/g, ''), `${name}${suffix.toLowerCase()}`)
        if (executable(path, env)) return path
      }
    }
  }
}

export function codebuddyAvailability(options: ResolveCodebuddyOptions = {}): { available: boolean; reason?: string } {
  return resolveCodebuddy(options) ? { available: true } : { available: false, reason: 'executable_missing' }
}
