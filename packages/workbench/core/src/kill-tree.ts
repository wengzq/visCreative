import { ChildProcess, spawn } from 'node:child_process'
import type { ChildLike } from './stdio-rpc'

const groups = new WeakMap<ChildLike, number>()

/** Only locally spawned detached children have an owned process group. Never infer ownership from a pid. */
export function spawnAgentProcess(command: string, args: string[], options: { cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal }) {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  if (process.platform !== 'win32' && child.pid) {
    groups.set(child, child.pid)
    child.once('exit', () => groups.delete(child))
  }
  return child
}

type Taskkill = (pid: number) => Promise<void>

const taskkill: Taskkill = pid => new Promise(resolve => {
  // No shell: the pid is the only argument. /T takes the agent's MCP servers and shell commands with it.
  const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  child.once('error', () => resolve())
  child.once('exit', () => resolve())
})

/**
 * Stop an agent process and everything it started. On Windows `kill()` ends only the process itself and is a hard
 * kill, so the agent never gets to stop its children: they would outlive the turn and keep the workspace busy.
 * Resolves once the tree has been signalled (Windows) or the signal was sent (elsewhere).
 */
export async function killTree(child: ChildLike, signal: NodeJS.Signals = 'SIGTERM', options: { platform?: NodeJS.Platform; taskkill?: Taskkill } = {}): Promise<void> {
  // Only a process this Node instance spawned is tree-killed by pid; injected test doubles carry made-up pids
  const real = options.taskkill !== undefined || child instanceof ChildProcess
  // An exited process's pid can be reused; tree-killing it could end an unrelated process tree
  const status = child as { exitCode?: number | null; signalCode?: string | null }
  if (status.exitCode != null || status.signalCode != null) return
  if ((options.platform ?? process.platform) === 'win32' && real && child.pid) {
    await (options.taskkill ?? taskkill)(child.pid)
    return
  }
  const group = groups.get(child)
  if (group !== undefined && group === child.pid) {
    try { process.kill(-group, signal) } catch { /* already exited */ }
    return
  }
  try { child.kill(signal) } catch { /* already exited */ }
}
