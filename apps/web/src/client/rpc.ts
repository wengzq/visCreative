import { messagesFor, type Locale } from '@vis/ui-kit'
import { shellMessages } from './messages'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export class RpcError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) {
    super(message)
  }
}

export type RpcClient = {
  call<T = any>(method: string, params?: unknown): Promise<T>
  onSkillsChanged?(listener: () => void): () => void
  close(): void
}

/**
 * JSON-RPC client connecting to studiod through the web host. Reconnects automatically (backoff up to 5 seconds),
 * calling onOpen on each connection so the caller can resubscribe (using afterSeq for replay).
 */
export function connectRpc(opts: {
  getLocale?: () => Locale
  url: string
  onNotification(method: string, params: unknown): void
  onStatus(status: ConnectionStatus): void
  onOpen(): void
}): RpcClient {
  const skillListeners = new Set<() => void>()
  let skillSeq = 0
  let socket: WebSocket | undefined
  let closed = false
  let retryMs = 500
  let nextId = 0
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()

  const failAll = () => {
    for (const p of pending.values()) p.reject(new RpcError('unavailable', messagesFor(shellMessages, opts.getLocale?.() ?? 'zh-CN').disconnected))
    pending.clear()
  }

  function open() {
    opts.onStatus('connecting')
    const ws = new WebSocket(opts.url)
    socket = ws
    ws.onopen = () => {
      skillSeq = 0
      for (const listener of skillListeners) listener()
      retryMs = 500
      opts.onStatus('open')
      opts.onOpen()
    }
    ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === undefined || msg.id === null) {
        if (msg.method === 'events.skillsChanged') {
          const seq = msg.params?.seq
          if (typeof seq === 'number' && seq > skillSeq) { skillSeq = seq; for (const listener of skillListeners) listener() }
        }
        if (typeof msg.method === 'string') opts.onNotification(msg.method, msg.params)
        return
      }
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      if (msg.error) entry.reject(new RpcError(msg.error.data?.code ?? 'rpc_error', msg.error.message, msg.error.data))
      else entry.resolve(msg.result)
    }
    ws.onclose = () => {
      failAll()
      if (closed) return
      opts.onStatus('closed')
      setTimeout(open, retryMs)
      retryMs = Math.min(retryMs * 2, 5000)
    }
  }
  open()

  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return reject(new RpcError('unavailable', messagesFor(shellMessages, opts.getLocale?.() ?? 'zh-CN').notConnected))
        const id = ++nextId
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    },
    onSkillsChanged(listener) { skillListeners.add(listener); return () => skillListeners.delete(listener) },
    close() {
      closed = true
      socket?.close()
    },
  }
}
