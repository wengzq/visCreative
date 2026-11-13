import { execFile } from 'node:child_process'

// Shell start-up files may print banners; the markers keep only the PATH line.
const MARK = '__VIS_LOGIN_PATH__'

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>

const runShell: ShellRunner = (shell, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(shell, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
})

/**
 * RFC 0046: macOS apps opened from Finder start with a minimal PATH, so Agent CLIs installed by npm, Homebrew or nvm
 * are not found. Read PATH only, from the user's login shell; no other variable is imported, and Agent environments
 * keep their allowlist. Returns undefined when there is nothing to read or the shell fails or hangs.
 */
export async function readLoginShellPath(opts: { platform: NodeJS.Platform; shell?: string | undefined; timeoutMs?: number; run?: ShellRunner }): Promise<string | undefined> {
  if (opts.platform === 'win32' || !opts.shell?.startsWith('/')) return undefined
  try {
    const stdout = await (opts.run ?? runShell)(opts.shell, ['-ilc', `printf '\\n${MARK}%s${MARK}\\n' "$PATH"`], opts.timeoutMs ?? 5000)
    const value = new RegExp(`${MARK}(.*?)${MARK}`).exec(stdout)?.[1]?.trim()
    return value ? value : undefined
  } catch {
    return undefined
  }
}

/** Login-shell entries first, then entries only the app's own PATH had (such as system directories), without duplicates. */
export function mergePath(loginPath: string | undefined, currentPath: string | undefined, delimiter = ':'): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const entry of [...(loginPath ?? '').split(delimiter), ...(currentPath ?? '').split(delimiter)]) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }
  return entries.join(delimiter)
}
