import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { normalizeCanvasInputs } from './canvas-inputs'
import { formatParamsError } from './param-errors'
import { randomUUID } from 'node:crypto'
import { METHODS, commandOf, describeCapability, listCapabilities } from '@vis/protocol'
import type { MethodName } from '@vis/protocol'
import { connect, RpcCallError } from './client'
import type { RpcClient } from './client'

type IO = { stdin: () => Promise<string>; stdout: (s: string) => void; stderr: (s: string) => void }
class UsageError extends Error {}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) } catch { throw new UsageError('invalid_params: parameters must be valid JSON') }
}

async function paramsOf(method: MethodName, args: string[], io: IO): Promise<Record<string, unknown>> {
  const spec = describeCapability(method, 'agent')!
  const properties = (spec.params as { properties: Record<string, { type?: string }> }).properties
  if (method === 'guide.get' && args[0] && !args[0].startsWith('--')) args = ['--topic', ...args]
  let params: Record<string, unknown> = {}
  const shortcuts: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!
    const value = args[i + 1]
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) throw new UsageError(`Argument requires a value: ${flag}`)
    if (flag === '--params') {
      const parsed = parseJson(value === '-' ? await io.stdin() : value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('invalid_params: --params must be an object')
      params = { ...params, ...parsed }
      continue
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    if (!Object.hasOwn(properties, key)) throw new UsageError(`Unknown argument: ${flag}`)
    switch (properties[key]!.type) {
      case 'string': shortcuts[key] = value; break
      case 'number':
      case 'integer': shortcuts[key] = value.trim() ? Number(value) : NaN; break
      case 'boolean':
        if (value !== 'true' && value !== 'false') throw new UsageError(`invalid_params: ${flag} requires true or false`)
        shortcuts[key] = value === 'true'
        break
      default: shortcuts[key] = parseJson(value)
    }
  }
  params = { ...params, ...shortcuts }
  if (Object.hasOwn(properties, 'requestId') && params.requestId === undefined) params.requestId = randomUUID()
  if (method === 'canvas.apply') {
    try { params = normalizeCanvasInputs(params) } catch (error) { throw new UsageError((error as Error).message) }
  }
  const checked = METHODS[method].params.safeParse(params)
  if (!checked.success) throw new UsageError(`invalid_params: ${formatParamsError(method, checked.error, params)}`)
  return checked.data
}

async function waitForJob(client: RpcClient, method: 'generation.get' | 'media.get', params: Record<string, unknown>, timeoutMs: number): Promise<{ result: unknown; code: number }> {
  let last: unknown = null
  let expired = false
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<{ result: unknown; code: number }>(resolve => {
    timer = setTimeout(() => {
      expired = true
      resolve({ result: last, code: 3 })
      client.close()
    }, timeoutMs)
  })
  const poll = async () => {
    while (!expired) {
      last = await client.call(method, params)
      const checked = METHODS[method].result.safeParse(last)
      if (!checked.success) throw new RpcCallError('unavailable', 'Invalid task response')
      if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(checked.data.status)) return { result: last, code: 0 }
    }
    return { result: last, code: 3 }
  }
  try { return await Promise.race([deadline, poll()]) } finally { clearTimeout(timer) }
}

export async function run(argv: string[], env: Record<string, string | undefined>, io: IO): Promise<number> {
  const socketPath = env.VIS_SOCKET ?? (env.VIS_DATA_DIR ? studiodEndpoint(env.VIS_DATA_DIR) : undefined)
  let client: RpcClient | undefined
  let requestId: unknown
  const output = (value: unknown) => io.stdout(`${JSON.stringify(value)}\n`)
  try {
    const available = listCapabilities('agent')
    if (argv.includes('--help')) {
      const prefix = argv.slice(0, argv.indexOf('--help')).join(' ')
      const entries = available.filter(entry => entry.command === prefix || entry.command.startsWith(`${prefix} `) || !prefix)
      if (!entries.length && !['list', 'describe', 'gen wait', 'media wait'].includes(prefix)) throw new UsageError(`Unknown command: ${prefix}`)
      io.stdout([...entries.map(entry => `vis ${entry.command}${entry.method === 'guide.get' ? ' [topic]' : ''} — ${entry.summary}`), 'vis list — List capabilities', 'vis describe <method or command> — Describe a capability', 'vis gen wait <jobId> [--timeout-ms N] — Wait for a generation job', 'vis media wait <taskId> [--timeout-ms N] — Wait for a local media task', 'vis mcp — Serve these capabilities as a stdio MCP server'].join('\n') + '\n')
      return 0
    }
    let args = [...argv]
    if (args[0] === 'list') args = ['capabilities', 'list', ...args.slice(1)]
    if (args[0] === 'describe') {
      const name = args.slice(1).join(' ')
      const match = available.find(entry => entry.method === name || entry.command === name)
      if (!match) throw new UsageError(`Unknown capability: ${name}`)
      args = ['capabilities', 'describe', '--method', match.method]
    }
    const waiting = (args[0] === 'gen' || args[0] === 'media') && args[1] === 'wait'
    let timeoutMs = 600_000
    let method: MethodName
    let params: Record<string, unknown>
    if (waiting) {
      if (!args[2] || (args.length !== 3 && (args.length !== 5 || args[3] !== '--timeout-ms'))) throw new UsageError('Usage: vis gen wait <jobId> or vis media wait <taskId> [--timeout-ms N]')
      if (args[4] !== undefined) timeoutMs = Number(args[4])
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new UsageError('--timeout-ms must be a valid positive integer')
      method = args[0] === 'media' ? 'media.get' : 'generation.get'
      params = await paramsOf(method, [method === 'media.get' ? '--task-id' : '--job-id', args[2], '--wait-ms', '30000'], io)
    } else {
      const match = available.find(entry => commandOf(entry.method as MethodName).every((part, index) => args[index] === part))
      if (!match) throw new UsageError('Unknown command; use vis --help to list commands')
      method = match.method as MethodName
      params = await paramsOf(method, args.slice(commandOf(method).length), io)
    }
    requestId = params.requestId
    if (!socketPath || !env.VIS_AGENT_TOKEN) throw new UsageError('VIS_SOCKET and VIS_AGENT_TOKEN must be set')
    client = await connect({ socketPath, credential: { kind: 'agent', token: env.VIS_AGENT_TOKEN } })
    if (waiting) {
      const { result, code } = await waitForJob(client, method as 'generation.get' | 'media.get', params, timeoutMs)
      output(result)
      return code
    }
    const result = await client.call(method, params)
    output(requestId === undefined ? result : { ...result as object, requestId })
    return 0
  } catch (error) {
    const code = error instanceof RpcCallError ? error.code : error instanceof UsageError ? 'invalid_params' : 'unavailable'
    output({ error: { code, message: error instanceof Error ? error.message : String(error),
      ...(error instanceof RpcCallError ? {
        ...(error.conflicts !== undefined ? { conflicts: error.conflicts } : {}),
        ...(error.data?.reason !== undefined ? { reason: error.data.reason } : {}),
        ...(error.data?.params !== undefined ? { params: error.data.params } : {}),
      } : {}),
    }, ...(requestId === undefined ? {} : { requestId }) })
    return error instanceof UsageError ? 2 : 1
  } finally {
    client?.close()
  }
}
