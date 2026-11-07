import type { Readable, Writable } from 'node:stream'

/** Adapters use only these child-process members, allowing tests to substitute fake Agent processes */
export type ChildLike = {
  stdin: Writable
  stdout: Readable
  stderr?: Readable | null
  pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => ChildLike

export class RpcRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

export type ServerRequestHandler = (method: string, params: any) => unknown | Promise<unknown>

/**
 * Bidirectional JSONL JSON-RPC over stdio: we send requests and notifications; the Agent process sends notifications
 * and requests (approvals, etc.), answered by onRequest.
 */
export function createRpcPeer(io: { input: Readable; output: Writable }, handlers: {
  onNotification(method: string, params: any): void
  onRequest: ServerRequestHandler
  onClose(): void
}) {
  const pending = new Map<number | string, { resolve(v: any): void; reject(e: Error): void }>()
  let nextId = 0
  let buffer = ''
  let closed = false

  const write = (message: object) => {
    if (!closed) io.output.write(`${JSON.stringify(message)}\n`)
  }

  function onLine(line: string) {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      Promise.resolve()
        .then(() => handlers.onRequest(msg.method, msg.params))
        .then(
          result => write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }),
          error => write({ jsonrpc: '2.0', id: msg.id, error: { code: error instanceof RpcRequestError ? error.code : -32603, message: String(error?.message ?? error) } }),
        )
      return
    }
    if (typeof msg.method === 'string') {
      handlers.onNotification(msg.method, msg.params)
      return
    }
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new RpcRequestError(msg.error.code ?? -32603, msg.error.message ?? 'Agent process returned an error'))
    else entry.resolve(msg.result)
  }

  io.input.setEncoding('utf8')
  io.input.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      onLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  })
  io.input.on('close', () => close())
  io.output.on('error', () => close())

  function close() {
    if (closed) return
    closed = true
    for (const entry of pending.values()) entry.reject(new RpcRequestError(-32000, 'Agent process connection is closed'))
    pending.clear()
    handlers.onClose()
  }

  return {
    request(method: string, params: unknown): Promise<any> {
      if (closed) return Promise.reject(new RpcRequestError(-32000, 'Agent process connection is closed'))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method: string, params?: unknown) {
      write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
    },
    get closed() { return closed },
  }
}
