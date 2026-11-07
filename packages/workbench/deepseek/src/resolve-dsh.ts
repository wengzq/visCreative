import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { resolveExecutable } from '@vis/workbench-core'

export type ResolvedDsh = { path: string; version: string }
export type ResolveDshOptions = {
  dshPath?: string
  env?: Record<string, string | undefined>
  homeDir?: string
}

type Version = { core: string[]; prerelease: string[] }

function parseVersion(version: string): Version | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match || match[0] !== version) return
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(part => /^0\d+$/.test(part))) return
  return { core: match.slice(1, 4), prerelease }
}

function compareNumeric(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(a.core[i]!, b.core[i]!)
    if (order) return order
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length)
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i]!
    const right = b.prerelease[i]!
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return compareNumeric(left, right)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left < right ? -1 : 1
  }
  return a.prerelease.length - b.prerelease.length
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    if (process.platform === 'win32') resolveExecutable('dsh', path)
    return true
  } catch {
    return false
  }
}

function packageVersion(path: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string' && parseVersion(pkg.version)) return pkg.version
  } catch {}
}

function installedVersion(path: string): string {
  let dir: string
  try {
    const entry = resolveExecutable('dsh', path)
    dir = dirname(realpathSync(entry.args[0] ?? path))
  } catch {
    return 'unknown'
  }
  for (;;) {
    const version = packageVersion(join(dir, 'package.json'))
    if (version) return version
    const parent = dirname(dir)
    if (parent === dir) return 'unknown'
    dir = parent
  }
}

/** Only locate installed dsh; never start or download it, and never silently switch versions when an explicit path is invalid. */
export function resolveDsh(options: ResolveDshOptions = {}): ResolvedDsh | undefined {
  const env = options.env ?? process.env
  const override = options.dshPath ?? env.VIS_DSH_PATH
  if (override !== undefined) {
    if (!override) return
    const path = resolve(override)
    return executable(path) ? { path, version: installedVersion(path) } : undefined
  }
  const pathEnv = env.PATH ?? (process.platform === 'win32' ? env.Path : undefined)
  if (pathEnv !== undefined) {
    for (const dir of pathEnv.split(delimiter)) {
      for (const suffix of process.platform === 'win32' ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';'), ''] : ['']) {
        const path = resolve(dir.replace(/^"|"$/g, ''), `dsh${suffix.toLowerCase()}`)
        if (executable(path)) return { path, version: installedVersion(path) }
      }
    }
  }
  const caches = new Set([
    ...(process.platform === 'win32' && env.npm_config_cache ? [join(env.npm_config_cache, '_npx')] : []),
    ...(process.platform === 'win32' && !options.homeDir && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'npm-cache', '_npx')] : []),
    join(options.homeDir ?? env.HOME ?? (process.platform === 'win32' ? env.USERPROFILE : undefined) ?? homedir(), '.npm', '_npx'),
  ])
  let best: ResolvedDsh | undefined
  let bestVersion: Version | undefined
  const entries = [...caches].flatMap(cache => {
    try { return readdirSync(cache).sort().map(entry => join(cache, entry)) } catch { return [] }
  })
  for (const entry of entries) {
    const modules = join(entry, 'node_modules')
    const version = packageVersion(join(modules, '@deepseek-ai', 'dsh', 'package.json'))
    if (!version) continue
    const parsed = parseVersion(version)!
    const path = join(modules, '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    if (executable(path) && (!bestVersion || compareVersions(parsed, bestVersion) > 0)) {
      best = { path, version }
      bestVersion = parsed
    }
  }
  return best
}
