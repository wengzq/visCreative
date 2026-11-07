import { createConnection } from 'node:net'
import { PROTOCOL_VERSION, runtime } from '@vis/protocol'
import type { Credential, ErrorData } from '@vis/protocol'

export class RpcCallError extends Error {
  constructor(readonly code: string, message: string, readonly conflicts?: unknown, readonly data?: ErrorData) {
    super(message)
    this.name = 'RpcCallError'
  }
}

export type RpcClient = { call(method: string, params: unknown): Promise<unknown>; close(): void }

export async function connect(opts: { socketPath: string; credential: Credential; timeoutMs?: number }): Promise<RpcClient> {
  const timeoutMs = opts.timeoutMs ?? 35_000
  const socket = createConnection(opts.socketPath)
  let sequence = 0
  let buffer = ''
  let failure: RpcCallError | undefined
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  const stop = (error: RpcCallError) => {
    failure ??= error
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(failure)
    }
    pending.clear()
    socket.destroy()
  }
  socket.setEncoding('utf8')
  socket.on('error', error => stop(new RpcCallError('unavailable', error.message)))
  socket.on('close', () => stop(new RpcCallError('unavailable', 'Socket is closed')))
  socket.on('data', chunk => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        const response = JSON.parse(line)
        if (!response || response.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC response')
        if (!Object.hasOwn(response, 'id')) continue
        const entry = pending.get(response.id)
        if (!entry) continue
        if (!Object.hasOwn(response, 'result') && !response.error) throw new Error('Response is missing result or error')
        pending.delete(response.id)
        clearTimeout(entry.timer)
        if (response.error) {
          entry.reject(new RpcCallError(response.error.data?.code ?? 'rpc_error', response.error.message, response.error.data?.conflicts, response.error.data))
        } else {
          entry.resolve(response.result)
        }
      } catch (error) {
        stop(new RpcCallError('unavailable', error instanceof Error ? error.message : 'Invalid response'))
        return
      }
    }
  })
  const client: RpcClient = {
    call(method, params) {
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        const id = ++sequence
        let message: string
        try {
          message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
        } catch {
          reject(new RpcCallError('invalid_params', 'RPC parameters cannot be serialized to JSON'))
          return
        }
        const timer = setTimeout(() => stop(new RpcCallError('unavailable', `RPC timed out: ${method}`)), timeoutMs)
        pending.set(id, { resolve, reject, timer })
        socket.write(message)
      })
    },
    close() { stop(new RpcCallError('unavailable', 'Client is closed')) },
  }
  try {
    const result = runtime.hello.result.parse(await client.call('runtime.hello', {
      protocolVersion: PROTOCOL_VERSION,
      credential: opts.credential,
    }))
    if (result.protocolVersion !== PROTOCOL_VERSION) throw new RpcCallError('unavailable', 'Incompatible protocol version')
    return client
  } catch (error) {
    client.close()
    if (error instanceof RpcCallError) throw error
    throw new RpcCallError('unavailable', 'Invalid handshake response')
  }
}
