import { createConnection } from 'node:net'
import { PROTOCOL_VERSION } from '@vis/protocol'

export type Notification = { method: string; params: unknown }

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export type UiConnection = {
  call(method: string, params?: unknown): Promise<any>
  close(): void
}

/** Connects to studiod as the UI: handshakes first, then forwards notifications */
export async function connectUi(opts: { socketPath: string; token: string; onNotification(n: Notification): void; onClose(): void }): Promise<UiConnection> {
  const socket = createConnection(opts.socketPath)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.setEncoding('utf8')
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  let buffer = ''
  let nextId = 0
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const msg = JSON.parse(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      if (msg.id === undefined || msg.id === null) {
        if (typeof msg.method === 'string') opts.onNotification({ method: msg.method, params: msg.params })
        continue
      }
      const entry = pending.get(msg.id)
      if (!entry) continue
      pending.delete(msg.id)
      if (msg.error) entry.reject(new RpcError(msg.error.data?.code ?? 'rpc_error', msg.error.message))
      else entry.resolve(msg.result)
    }
  })
  socket.on('error', () => socket.destroy())
  socket.on('close', () => {
    for (const entry of pending.values()) entry.reject(new RpcError('unavailable', 'Connection closed'))
    pending.clear()
    opts.onClose()
  })
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token: opts.token } })
  return { call, close: () => socket.destroy() }
}
