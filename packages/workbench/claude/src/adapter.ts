import { mkdirSync } from 'node:fs'
import { delimiter } from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SpaceDb } from '@vis/storage'
import { type AgentEvent, type AgentRuntimePort, type ChildLike, DispatchError, exitInstance, killTree, markInstanceReady, spawnAgentProcess, startTurnInstance } from '@vis/workbench-core'
import { buildPrompt, systemAppend } from './prompt'
import { translate } from './translate'

/** 0004 "Claude Adapter": allow vis and read-only tools; reject all others without approval prompts */
export const TOOLS = ['Bash', 'Read', 'Glob', 'Grep']
export const ALLOWED_TOOLS = ['Bash(vis:*)', 'Read', 'Glob', 'Grep']

export type QueryFn = (params: { prompt: string; options?: Options }) => Query

export type ClaudeRuntimeOptions = {
  query: QueryFn
  /** Session working directory. Claude stores transcripts by cwd, so resume must use the same directory */
  workDir(sessionId: string): string
  /** Issue a runtime token; store only its hash in the database */
  issueToken(): { token: string; tokenHash: string }
  socketPath: string
  /** Directory containing the vis executable, prepended to the Agent process PATH */
  cliBinDir: string
  model?: string
  /** Maximum wait from startup to receiving init */
  initTimeoutMs?: number
  /** Grace period for Agent cleanup after interruption; abort immediately on timeout */
  interruptGraceMs?: number
  env?: Record<string, string | undefined>
  now?: () => number
}

type Run = {
  sessionId: string
  turnId: string
  instanceId: string
  q: Query
  abort: AbortController
  interrupted: boolean
  done: Promise<void>
}

/**
 * One SDK call per turn, restoring context with resume; the process exits when the turn ends.
 * Receiving init means the Agent has accepted the turn; all subsequent endings are reported through turn_ended.
 */
export function createClaudeRuntime(
  ctx: { db: SpaceDb; report: (event: AgentEvent) => void },
  opts: ClaudeRuntimeOptions,
): AgentRuntimePort & { dispose(): Promise<void> } {
  const { db, report } = ctx
  const now = opts.now ?? Date.now
  const runs = new Map<string, Run>()
  const starting = new Map<string, { turnId: string; instanceId: string; abort: AbortController; done: Promise<void> }>()
  const consumers = new Set<Run>()
  const startups = new Set<{ abort: AbortController; done: Promise<void> }>()
  const processes = new Map<string, { turnId: string; child: ChildLike; exited: Promise<void> }>()
  let disposed = false

  const exit = (instanceId: string, reason: string) => exitInstance(db, instanceId, reason, now())

  async function stopProcess(turnId: string) {
    const process = processes.get(turnId)
    if (!process || process.turnId !== turnId) return
    await killTree(process.child, 'SIGKILL')
    await process.exited
    if (processes.get(turnId) === process) processes.delete(turnId)
  }

  async function consume(run: Run, iterator: AsyncIterator<SDKMessage>, first: SDKMessage | undefined) {
    const { sessionId, turnId } = run
    let status: 'completed' | 'failed' | 'interrupted' = 'interrupted'
    try {
      for (let msg = first; msg; ) {
        if (msg.type === 'result') {
          status = run.interrupted ? 'interrupted' : msg.subtype === 'success' && !msg.is_error ? 'completed' : 'failed'
        }
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') report({ type: 'context_compacted', sessionId })
        if ((msg.type === 'assistant' || msg.type === 'user') && msg.parent_tool_use_id === null) report({ type: 'leaf', sessionId, leafUuid: msg.uuid! })
        for (const item of translate(msg)) report({ type: 'item', sessionId, turnId, ...item })
        const next = await iterator.next()
        msg = next.done ? undefined : next.value
      }
    } catch (error) {
      // Abnormal process exit or abort: the turn did not finish normally, so treat it as interrupted (0004)
      if (!run.interrupted) console.error(`[claude] ${sessionId} turn ${turnId} ended abnormally`, error)
    } finally {
      await stopProcess(turnId)
      exit(run.instanceId, status)
      report({ type: 'turn_ended', sessionId, turnId, status })
      // Disposal must retain the consumer until both process exit and the final database write.
      if (runs.get(sessionId) === run) runs.delete(sessionId)
      consumers.delete(run)
    }
  }

  return {
    async ensureReady(sessionId) {
      if (disposed) throw new DispatchError('rejected', 'Runtime is closed')
      // One call per turn, with no persistent process to prepare; only ensure the working directory exists
      mkdirSync(opts.workDir(sessionId), { recursive: true })
    },

    async dispatchTurn(input) {
      if (disposed) throw new DispatchError('rejected', 'Runtime is closed')
      if (runs.has(input.sessionId) || starting.has(input.sessionId)) throw new DispatchError('rejected', 'This session already has an active turn')
      const { token, tokenHash } = opts.issueToken()
      const instanceId = startTurnInstance(db, { sessionId: input.sessionId, turnId: input.turnId, tokenHash }, now())
      const abort = new AbortController()
      let finished!: () => void
      const startup = { turnId: input.turnId, instanceId, abort, done: new Promise<void>(resolve => { finished = resolve }) }
      starting.set(input.sessionId, startup)
      startups.add(startup)
      try {
        const env = { ...(opts.env ?? process.env) }
        // Windows environment keys are case-insensitive; avoid passing both Path and PATH to child processes.
        if (process.platform === 'win32') {
          const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
          const path = pathKey ? env[pathKey] : undefined
          for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
          if (path !== undefined) env.PATH = path
        }
        let q: Query
        try {
          q = opts.query({
            prompt: buildPrompt(input),
            options: {
              ...(input.resumeId ? { resume: input.resumeId } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              cwd: opts.workDir(input.sessionId),
              abortController: abort,
              spawnClaudeCodeProcess: options => {
                const child = spawnAgentProcess(options.command, options.args, { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env })
                const process = { turnId: input.turnId, child, exited: new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => { if (child.pid === undefined) resolve() }) }) }
                processes.set(input.turnId, process)
                options.signal.addEventListener('abort', () => { void killTree(child, 'SIGKILL') }, { once: true })
                child.stderr.resume()
                // SDK shutdown first allows stdin cleanup, then calls kill. Keep that final action tree-wide.
                return {
                  stdin: child.stdin, stdout: child.stdout,
                  get killed() { return child.killed },
                  get exitCode() { return child.exitCode },
                  get signalCode() { return child.signalCode },
                  kill() { void killTree(child, 'SIGKILL'); return true },
                  on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child),
                }
              },
              tools: TOOLS,
              allowedTools: ALLOWED_TOOLS,
              permissionMode: 'dontAsk',
              settingSources: [],
              systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(input.workContext) },
              env: {
                ...env,
                PATH: [opts.cliBinDir, env.PATH].filter(Boolean).join(delimiter),
                VIS_SOCKET: opts.socketPath,
                VIS_AGENT_TOKEN: token,
                CLAUDE_AGENT_SDK_CLIENT_APP: 'vis-creative',
              },
            },
          })
        } catch (error) {
          exit(instanceId, 'start_failed')
          throw new DispatchError('rejected', `Cannot start Claude: ${errorMessage(error)}`)
        }

        // Wait for init: failure before receiving it proves the Agent did not process this message
        const iterator = q[Symbol.asyncIterator]()
        const timeoutMs = opts.initTimeoutMs ?? 60_000
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs) })
        let first: IteratorResult<SDKMessage>
        const firstNext = iterator.next()
        // After timeout, this read fails due to abort with nobody still waiting
        firstNext.catch(() => {})
        try {
          const raced = await Promise.race([firstNext, timeout])
          if (raced === 'timeout') {
            abort.abort()
            exit(instanceId, 'start_timeout')
            throw new DispatchError('unknown', `Waiting for Claude startup exceeded ${Math.round(timeoutMs / 1000)} seconds`)
          }
          if (abort.signal.aborted || disposed) throw new Error('Runtime has stopped')
          first = raced
        } catch (error) {
          if (error instanceof DispatchError) throw error
          exit(instanceId, 'start_failed')
          throw new DispatchError('rejected', `Claude startup failed: ${errorMessage(error)}`)
        } finally {
          clearTimeout(timer)
        }
        if (first.done) {
          exit(instanceId, 'start_failed')
          throw new DispatchError('rejected', 'Claude exited before starting')
        }
        if (first.value.type === 'system' && first.value.subtype === 'init') {
          report({ type: 'resume_id', sessionId: input.sessionId, resumeId: first.value.session_id })
        }
        markInstanceReady(db, instanceId)

        const run: Run = { sessionId: input.sessionId, turnId: input.turnId, instanceId, q, abort, interrupted: false, done: Promise.resolve() }
        runs.set(input.sessionId, run)
        consumers.add(run)
        // The turn continues in the background; dispatchTurn only reports acceptance
        run.done = consume(run, iterator, first.value)
      } finally {
        if (runs.get(input.sessionId)?.turnId !== input.turnId) await stopProcess(input.turnId)
        if (starting.get(input.sessionId)?.turnId === input.turnId) starting.delete(input.sessionId)
        startups.delete(startup)
        finished()
      }
    },

    async interruptTurn({ sessionId, turnId }) {
      const pending = starting.get(sessionId)
      if (pending?.turnId === turnId) { pending.abort.abort(); await pending.done; return }
      const run = runs.get(sessionId)
      if (!run || run.turnId !== turnId) return
      run.interrupted = true
      const grace = new Promise<void>(r => setTimeout(r, opts.interruptGraceMs ?? 5000).unref())
      try {
        await Promise.race([run.q.interrupt(), grace])
      } catch {
        // If the interrupt request fails, abort directly
      }
      // Force abort if still running after the grace period
      void Promise.race([run.done, grace]).then(() => { if (runs.get(sessionId) === run) run.abort.abort() })
    },

    async terminateTurn({ sessionId, turnId }) {
      const pending = starting.get(sessionId)
      if (pending?.turnId === turnId) {
        starting.delete(sessionId)
        exit(pending.instanceId, 'interrupted')
        pending.abort.abort()
        await stopProcess(turnId)
        await pending.done
      }
      const run = runs.get(sessionId)
      if (run?.turnId === turnId) {
        run.interrupted = true
        runs.delete(sessionId)
        run.abort.abort()
        await stopProcess(turnId)
        await run.done
      }
    },

    async dispose() {
      disposed = true
      const pending = [...startups]
      for (const run of pending) run.abort.abort()
      await Promise.all([...processes.keys()].map(turnId => stopProcess(turnId)))
      await Promise.all(pending.map(run => run.done))
      const all = [...consumers]
      for (const run of all) {
        run.interrupted = true
        run.abort.abort()
      }
      await Promise.all(all.map(r => r.done))
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
