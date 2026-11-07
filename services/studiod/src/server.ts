import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import type { Gateway } from './gateway'

/** Per-line limit: disconnect when exceeded to prevent faulty clients from exhausting memory. */
const MAX_LINE_BYTES = 16 * 1024 * 1024

/** Throw if studiod is already listening; remove stale socket files directly. */
async function claimSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32' || !existsSync(socketPath)) return
  const alive = await new Promise<boolean>(resolve => {
    const probe = connect(socketPath)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => resolve(false))
  })
  if (alive) throw new Error(`studiod is already running at ${socketPath}`)
  unlinkSync(socketPath)
}

/** Carry JSON-RPC over NDJSON on a local socket (RFC 0004 "Local communication"). */
export async function listen(socketPath: string, gateway: Gateway): Promise<Server> {
  await claimSocket(socketPath)
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    // Accumulate bytes of the incomplete line per chunk, avoiding recalculation over the entire buffer each time.
    let pendingBytes = 0
    const conn = gateway.accept({
      send: message => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`) },
      // Write queued responses before disconnecting.
      close: () => socket.end(),
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!chunk.includes('\n')) {
        pendingBytes += Buffer.byteLength(chunk)
      } else {
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          conn.receive(line)
        }
        // Only the portion after the newline in this chunk remains.
        pendingBytes = Buffer.byteLength(buffer)
      }
      if (pendingBytes > MAX_LINE_BYTES) socket.destroy()
    })
    socket.on('close', () => conn.closed())
    socket.on('error', () => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ path: socketPath, ...(process.platform === 'win32' ? { readableAll: false, writableAll: false } : {}) }, () => { server.off('error', reject); resolve() })
  })
  if (process.platform !== 'win32') chmodSync(socketPath, 0o600)
  return server
}
