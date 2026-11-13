import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { resolveExecutable } from '@vis/workbench-core'

export type ResolveMcodeOptions = {
  mcodePath?: string
  env?: Record<string, string | undefined>
  homeDir?: string
}

function executable(path: string, env: Record<string, string | undefined>): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    resolveExecutable('mcode', path, env)
    return true
  } catch { return false }
}

/** Locate the CLI without starting it or inspecting login state; an invalid override never falls back. */
export function resolveMcode(options: ResolveMcodeOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const override = options.mcodePath ?? env.VIS_MCODE_PATH
  if (override !== undefined) {
    if (!override) return
    const path = resolve(override)
    return executable(path, env) ? path : undefined
  }
  const pathEnv = env.PATH ?? (process.platform === 'win32' ? env.Path : undefined)
  for (const dir of pathEnv?.split(delimiter) ?? []) {
    for (const suffix of process.platform === 'win32' ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';'), ''] : ['']) {
      const path = resolve(dir.replace(/^"|"$/g, ''), `mcode${suffix.toLowerCase()}`)
      if (executable(path, env)) return path
    }
  }
  const home = options.homeDir ?? env.HOME ?? (process.platform === 'win32' ? env.USERPROFILE : undefined) ?? homedir()
  const path = join(home, '.minimax-code', 'bin', 'mcode')
  return executable(path, env) ? path : undefined
}
