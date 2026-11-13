import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AppLayout } from './layout'

export type StudiodServer = { protocolVersion: number; studiodVersion: string }
/** Resolves to studiod's handshake answer, or undefined while nothing is listening */
export type StudiodProbe = () => Promise<StudiodServer | undefined>

export class StudiodStartError extends Error {
  constructor(readonly reason: 'timeout' | 'exited', readonly exitCode?: number | null) {
    super(reason === 'timeout' ? 'studiod did not start in time' : `studiod exited during startup (code ${exitCode})`)
  }
}

/**
 * Attach to the studiod serving this data directory, or start one and wait until it answers (RFC 0004).
 * A start that loses the race to another launcher exits with 0 and is not a failure: keep probing for the winner.
 */
export async function ensureStudiod(opts: {
  probe: StudiodProbe
  start: () => { exited: Promise<number | null> }
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<{ state: 'attached' | 'started'; server: StudiodServer }> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const running = await opts.probe()
  if (running) return { state: 'attached', server: running }
  let failed: { code: number | null } | undefined
  void opts.start().exited.then(code => { if (code !== 0) failed = { code } })
  const deadline = now() + (opts.timeoutMs ?? 30_000)
  for (;;) {
    const server = await opts.probe()
    if (server) return { state: 'started', server }
    if (failed) throw new StudiodStartError('exited', failed.code)
    if (now() >= deadline) throw new StudiodStartError('timeout')
    await sleep(opts.pollMs ?? 150)
  }
}

const MAX_LOG_BYTES = 5 * 1024 ** 2

export function studiodLogPath(dataDir: string): string {
  return join(dataDir, 'logs', 'studiod.log')
}

const psString = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`

/** The Windows launch script: Start-Process goes through the shell, which creates the process without inheriting handles. */
export function windowsStartScript(command: string, entry: string): string {
  return `try { Start-Process -FilePath (${psString(command)}) -ArgumentList ('"' + (${psString(entry)}) + '"') -WindowStyle Hidden -ErrorAction Stop } catch { exit 1 }
`
}

/**
 * Start studiod detached, so closing or updating the app does not stop running turns. studiod writes its own log
 * (VIS_STUDIOD_LOG). `path` is the PATH studiod and its Agents search; the rest comes from the app's environment.
 *
 * On Windows a child started directly inherits handles of the Electron main process, and the app then cannot exit
 * while studiod lives (docs/lessons/tooling.md). There the resolved code is the launcher's, not studiod's.
 */
export function startStudiodProcess(layout: AppLayout, env: Record<string, string | undefined>, path: string | undefined, platform: NodeJS.Platform = process.platform): { exited: Promise<number | null> } {
  const log = studiodLogPath(layout.dataDir)
  mkdirSync(join(layout.dataDir, 'logs'), { recursive: true })
  // One previous log is enough to diagnose a failed start; the file must not grow without bound.
  try { if (statSync(log).size > MAX_LOG_BYTES) renameSync(log, `${log}.1`) } catch { /* no log yet */ }
  const childEnv = { ...env, ...(path ? { PATH: path } : {}), ...layout.studiodEnv, VIS_DATA_DIR: layout.dataDir, VIS_CLI_BIN_DIR: layout.cliBinDir, VIS_STUDIOD_LOG: log }
  const child = platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: childEnv })
    : spawn(layout.studiodCommand, [layout.studiodEntry], { detached: true, stdio: 'ignore', env: childEnv })
  const exited = new Promise<number | null>(resolve => {
    child.once('error', () => resolve(-1))
    child.once('exit', code => resolve(code))
  })
  if (platform === 'win32') {
    child.stdin?.on('error', () => {})
    child.stdin?.end(windowsStartScript(layout.studiodCommand, layout.studiodEntry))
  } else {
    child.unref()
  }
  return { exited }
}
