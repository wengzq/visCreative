import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'] as const

// For nonexistent paths, still resolve existing parent symlinks so /var and /private/var cannot bypass the policy.
function canonical(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(canonical(parent), basename(absolute))
}

function agentPrivatePaths(home: string, agent: SandboxAgent) {
  const paths: string[] = []
  const patterns: { directory: string; regex: string }[] = []
  const own = `~/${agent.runtimeDirectory}`
  for (const path of new Set(agent.forbiddenPaths ?? [])) {
    if (path === own || path.startsWith(own + '/')) continue
    const expanded = path.startsWith('~/') ? join(home, path.slice(2)) : resolve(path)
    const name = basename(expanded)
    if (!name.includes('*')) { paths.push(expanded); continue }
    const directory = dirname(expanded)
    const regex = '/' + [...name].map(char => char === '*' ? '[^/]*' : /[a-zA-Z0-9_-]/.test(char) ? char : `[${char}]`).join('') + '$'
    patterns.push({ directory, regex })
    const match = new RegExp(regex)
    // Resolve existing backup symlinks, while the regex also protects future names.
    if (existsSync(directory)) paths.push(...readdirSync(directory).filter(entry => match.test('/' + entry)).map(entry => join(directory, entry)))
  }
  return { paths, patterns }
}

export type SandboxAgent = {
  envPassthrough: readonly string[]
  runtimeDirectory: string
  runtimeHomeVariable?: string
  forbiddenPaths?: readonly string[]
}

const DEFAULT_SANDBOX_AGENT: SandboxAgent = { envPassthrough: [], runtimeDirectory: '.codex', runtimeHomeVariable: 'CODEX_HOME' }

export function buildSandboxPolicy(cwd: string, dataDir: string, home: string, runtimeHome: string, agent: SandboxAgent = DEFAULT_SANDBOX_AGENT): string {
  const quote = (path: string) => JSON.stringify(canonical(path))
  const protectedAgent = agentPrivatePaths(home, agent)
  const privatePaths = [join(dataDir, 'run'), join(dataDir, 'providers.json'), join(home, '.vis-dev/run'), join(home, '.ssh'), ...protectedAgent.paths, join(home, 'Library/Keychains'), '/Library/Keychains']
  return [
    '(version 1)',
    '(allow default)',
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))',
    // A fixed regex avoids Seatbelt's distinct escaping rules; same-named backups deeper under home are also private.
    `(deny file-read* ${privatePaths.map(path => `(subpath ${quote(path)})`).join(' ')} (require-all (subpath ${quote(dataDir)}) (regex #"/app[.]db[^/]*$")) (require-all (subpath ${quote(join(dataDir, 'spaces'))}) (regex #"/space[.]db[^/]*$"))${protectedAgent.patterns.map(pattern => ` (require-all (subpath ${quote(pattern.directory)}) (regex #${JSON.stringify(pattern.regex)}))`).join('')})`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${quote(cwd)}) (subpath ${quote(runtimeHome)}) (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))`,
  ].join('\n')
}

export function prepareSandbox(options: {
  cwd: string
  agent?: SandboxAgent
  dataDir?: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  available?: (path: string) => boolean
}) {
  const agent = options.agent ?? DEFAULT_SANDBOX_AGENT
  const platform = options.platform ?? process.platform
  const source = options.env ?? process.env
  const env: Record<string, string | undefined> = Object.fromEntries([...ENVIRONMENT, ...agent.envPassthrough].flatMap(key => {
    const value = platform === 'win32' ? Object.entries(source).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : source[key]
    return value === undefined ? [] : [[key, value]]
  }))
  const home = canonical(source.HOME ?? (platform === 'win32' ? env.USERPROFILE : undefined) ?? homedir())
  const runtimeHome = canonical((agent.runtimeHomeVariable ? source[agent.runtimeHomeVariable] : undefined) ?? join(home, agent.runtimeDirectory))
  if (agent.runtimeHomeVariable) env[agent.runtimeHomeVariable] = runtimeHome
  const available = options.available ?? existsSync
  const fallback = (notice: string) => ({ env, policy: undefined, notice, isolation: 'none' as const })
  if (platform === 'win32') return { env, policy: undefined, notice: undefined, isolation: 'none' as const }
  if (!options.dataDir) return fallback('未配置密钥隔离目录，保持只读模式')
  if ((options.platform ?? process.platform) !== 'darwin' || !available('/usr/bin/sandbox-exec')) return fallback('系统不支持密钥隔离沙箱，保持只读模式')
  if (!available('/etc/ssl/cert.pem')) return fallback('缺少 /etc/ssl/cert.pem 根证书，保持只读模式')
  const cwd = canonical(options.cwd)
  const dataDir = canonical(options.dataDir)
  const protectedAgent = agentPrivatePaths(home, agent)
  const restricted = [join(dataDir, 'run'), join(home, '.vis-dev/run'), join(home, '.ssh'), ...protectedAgent.paths, join(home, 'Library/Keychains'), '/Library/Keychains']
  const overlapsBackup = (path: string) => protectedAgent.patterns.some(pattern => path.startsWith(pattern.directory + sep) && new RegExp(pattern.regex.slice(0, -1) + '(?:/|$)').test(path.split(sep).join('/')))
  const overlaps = (left: string, right: string) => left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)
  const withinData = relative(dataDir, cwd)
  const parts = withinData.split(sep)
  const isWithinData = withinData === '' || (!withinData.startsWith(`..${sep}`) && withinData !== '..' && !isAbsolute(withinData))
  // Preserve workspaces of old sessions and migrated projects; application databases and runtime directories cannot be writable workspaces.
  const isLegacyWorkspace = parts[0] === 'spaces' && Boolean(parts[1]) && ((parts[2] === 'sessions' && Boolean(parts[3])) || (parts[2] === 'project' && parts[3] === 'workspaces' && Boolean(parts[4])))
  if ((isWithinData && !isLegacyWorkspace) || overlapsBackup(cwd) || overlapsBackup(runtimeHome) || restricted.some(path => overlaps(cwd, canonical(path)) || overlaps(runtimeHome, canonical(path))) || dataDir === cwd || dataDir.startsWith(`${cwd}/`) || overlaps(dataDir, runtimeHome)) {
    return fallback('工作目录或 Agent 配置目录与密钥目录重叠，保持只读模式')
  }
  mkdirSync(join(cwd, '.vis-tmp'), { recursive: true, mode: 0o700 })
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 })
  env.TMPDIR = canonical(join(cwd, '.vis-tmp'))
  // zsh writes here-documents under TMPPREFIX (default /tmp/zsh), not TMPDIR, and /tmp is not writable here.
  env.TMPPREFIX = join(env.TMPDIR, 'zsh')
  // After blocking securityd, use public PEM root certificates; never disable TLS verification.
  env.SSL_CERT_FILE = '/etc/ssl/cert.pem'
  return { env, policy: buildSandboxPolicy(cwd, dataDir, home, runtimeHome, agent), notice: undefined, isolation: 'sandbox' as const }
}
