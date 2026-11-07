import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { PROTOCOL_VERSION, type ErrorData } from '@vis/protocol'

/** Host-initiated calls use string IDs with this prefix; browser requests must not use it */
export const HOST_ID_PREFIX = 'host:'

export class LinkError extends Error {
  constructor(readonly code: string, message: string, readonly data?: ErrorData) {
    super(message)
  }
}

export type StudiodLink = {
  /** Forwards one JSON-RPC line unchanged */
  send(line: string): void
  call(method: string, params?: unknown): Promise<any>
  close(): void
  readonly closed: boolean
}

/**
 * Connects to studiod as the UI and handshakes. For subsequent studiod messages,
 * handles host-call acknowledgments locally and passes the rest (browser acknowledgments and event notifications) unchanged to onMessage.
 * Rereads the token on each connection because studiod replaces it after restarting.
 */
export async function openStudiodLink(opts: {
  socketPath: string
  tokenPath: string
  onMessage?: (line: string) => void
  onClose?: () => void
}): Promise<StudiodLink> {
  let token: string
  try {
    token = readFileSync(opts.tokenPath, 'utf8')
  } catch {
    throw new LinkError('unavailable', 'studiod is not running', { code: 'unavailable', reason: 'host.studiod_unavailable' })
  }
  const socket = createConnection(opts.socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', () => reject(new LinkError('unavailable', 'studiod is not running', { code: 'unavailable', reason: 'host.studiod_unavailable' })))
  })
  socket.setEncoding('utf8')
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()
  let closed = false
  let buffer = ''
  let nextId = 0
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let id: unknown
      try {
        id = JSON.parse(line).id
      } catch {
        continue
      }
      const entry = typeof id === 'string' ? pending.get(id) : undefined
      if (!entry) {
        opts.onMessage?.(line)
        continue
      }
      pending.delete(id as string)
      const msg = JSON.parse(line)
      if (msg.error) entry.reject(new LinkError(msg.error.data?.code ?? 'rpc_error', msg.error.message, msg.error.data))
      else entry.resolve(msg.result)
    }
  })
  socket.on('error', () => socket.destroy())
  socket.on('close', () => {
    closed = true
    for (const entry of pending.values()) entry.reject(new LinkError('unavailable', 'Connection to studiod closed', { code: 'unavailable', reason: 'host.studiod_disconnected' }))
    pending.clear()
    opts.onClose?.()
  })
  const write = (line: string) => { if (!closed) socket.write(`${line}\n`) }
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    if (closed) return reject(new LinkError('unavailable', 'Connection to studiod closed', { code: 'unavailable', reason: 'host.studiod_disconnected' }))
    const id = `${HOST_ID_PREFIX}${++nextId}`
    pending.set(id, { resolve, reject })
    write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  try {
    await call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token } })
  } catch (error) {
    socket.destroy()
    throw error
  }
  return {
    send: write,
    call,
    close: () => socket.destroy(),
    get closed() { return closed },
  }
}
