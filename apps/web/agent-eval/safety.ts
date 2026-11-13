import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { MethodResult } from '@vis/protocol'

export type Options = {
  agents: ('codex' | 'deepseek' | 'minimax-code' | 'codebuddy')[]
  scenarios: string[]
  dataDir: string
  /** Project roots live outside the data dir: studiod drops agents to read-only when a work dir is inside it. */
  projectsDir: string
  out: string
  timeoutMs: number
  dryRun: boolean
}

export function canonical(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  while (!existsSync(current)) {
    missing.unshift(basename(current))
    current = dirname(current)
  }
  return join(realpathSync(current), ...missing)
}

export function contains(parent: string, path: string): boolean {
  // Missing path components cannot be realpathed; conservatively protect case aliases on common case-insensitive filesystems.
  const normalize = (value: string) => process.platform === 'darwin' || process.platform === 'win32' ? value.toLowerCase() : value
  const rel = relative(normalize(parent), normalize(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

export function parseOptions(args: string[], ids: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const flags = new Map<string, string>()
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (flag === '--dry-run') {
      dryRun = true
      continue
    }
    if (!['--agents', '--scenarios', '--data-dir', '--out', '--timeout-ms'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    flags.set(flag, value)
  }
  if (!flags.has('--data-dir')) throw new Error('--data-dir is required; use a fresh isolated directory')
  const agents = [...new Set((flags.get('--agents') ?? 'codex,deepseek').split(','))]
  if (agents.includes('claude')) throw new Error('Claude evaluation is deferred by RFC 0026; choose codex, deepseek, minimax-code or codebuddy')
  if (agents.some(agent => !['codex', 'deepseek', 'minimax-code', 'codebuddy'].includes(agent))) throw new Error('Agents must be codex, deepseek, minimax-code or codebuddy')
  if (dryRun && (agents.length !== 1 || agents[0] !== 'codex')) throw new Error('--dry-run requires --agents codex')
  const scenarios = [...new Set((flags.get('--scenarios') ?? ids.join(',')).split(','))]
  if (scenarios.some(id => !ids.includes(id))) throw new Error(`Unknown scenario; choose ${ids.join(',')}`)
  const timeoutMs = Number(flags.get('--timeout-ms') ?? 20 * 60_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer')
  const dataDir = canonical(flags.get('--data-dir')!)
  const protectedDirs = [
    join(homedir(), '.vis-dev'),
    join(homedir(), 'Library', 'Application Support', 'vis-creative'),
    join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'vis-creative'),
    join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'vis-creative'),
    ...(env.VIS_DATA_DIR ? [env.VIS_DATA_DIR] : []),
  ].map(canonical)
  if (protectedDirs.some(path => contains(path, dataDir) || contains(dataDir, path))) throw new Error('Refusing a data directory overlapping real application data or ~/.vis-dev')
  if (existsSync(dataDir) && (!statSync(dataDir).isDirectory() || readdirSync(dataDir).length)) throw new Error('--data-dir must not exist or must be empty')
  const out = canonical(flags.get('--out') ?? join(tmpdir(), 'vis-agent-eval', new Date().toISOString().replace(/[:.]/g, '-')))
  if (contains(dataDir, out) || contains(out, dataDir)) throw new Error('Output and data directories must be separate')
  if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length)) throw new Error('--out must not exist or must be empty')
  const projectsDir = canonical(`${dataDir}-projects`)
  if ([dataDir, out, ...protectedDirs].some(path => contains(path, projectsDir) || contains(projectsDir, path))) throw new Error('The projects directory must be outside the data, output and real application directories')
  if (existsSync(projectsDir) && (!statSync(projectsDir).isDirectory() || readdirSync(projectsDir).length)) throw new Error(`${projectsDir} must not exist or must be empty`)
  return { agents: agents as Options['agents'], scenarios, dataDir, projectsDir, out, timeoutMs, dryRun }
}

export function prepareDirectories(options: Options) {
  // Recheck immediately before writing; never adopt an existing runtime or configuration.
  for (const path of [options.dataDir, options.projectsDir, options.out]) {
    if (existsSync(path) && readdirSync(path).length) throw new Error(`Directory is no longer empty: ${path}`)
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
}

export function assertFreeProviders(catalog: MethodResult<'providers.list'>) {
  if (!catalog.providers.some(provider => provider.id === 'mock' && provider.type === 'mock') ||
    catalog.providers.some(provider => provider.hasKey || !((provider.id === 'mock' && provider.type === 'mock') || (provider.id === 'render' && provider.type === 'render')))) {
    throw new Error('Unsafe provider catalog: only built-in Mock and local render are allowed; refusing to start agent sessions')
  }
  for (const selected of Object.values(catalog.defaults)) {
    if (selected && !['mock', 'render'].includes(selected.provider)) throw new Error('Unsafe default generation provider')
  }
}

export function assertMockConfiguration(config: unknown) {
  const value = config as any
  if (!Array.isArray(value?.providers) || value.providers.length !== 0 ||
    !['image', 'video', 'audio'].every(kind => value.defaults?.[kind]?.provider === 'mock') ||
    !['maxConcurrent', 'dailyImage', 'dailyVideo', 'dailyAudio'].every(key => value.limits?.[key] === 1)) {
    throw new Error('Unsafe providers.json: evaluation requires no configured providers, Mock-only defaults and limits of 1')
  }
}
