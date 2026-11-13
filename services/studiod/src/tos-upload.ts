import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import type { HostingConfig } from '@vis/protocol'
import { signTosRequest } from './tos-signing'

export type UploadRequest = (url: URL, options: RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest

const hashes = new Map<string, string>()
const HASH_CACHE_LIMIT = 32
const aborted = () => new DOMException('Media hosting upload aborted', 'AbortError')

async function payloadHash(file: FileHandle, path: string, metadata: { size: number; mtimeMs: number; ino: number; ctimeMs: number }, signal?: AbortSignal) {
  const { size, mtimeMs, ino, ctimeMs } = metadata
  const key = JSON.stringify([path, size, mtimeMs, ino, ctimeMs])
  const cached = hashes.get(key)
  if (cached !== undefined) {
    hashes.delete(key)
    hashes.set(key, cached)
    return cached
  }
  const hash = createHash('sha256')
  if (size > 0) {
    const stream = file.createReadStream({ start: 0, end: size - 1, autoClose: false })
    const onAbort = () => stream.destroy(aborted())
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      signal?.throwIfAborted()
      for await (const chunk of stream) hash.update(chunk)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      // Destroying a successful read would close the shared handle before the upload pass.
      if (!stream.readableEnded) stream.destroy()
    }
  }
  const digest = hash.digest('hex')
  hashes.set(key, digest)
  if (hashes.size > HASH_CACHE_LIMIT) hashes.delete(hashes.keys().next().value!)
  return digest
}

export async function uploadTosFile(input: {
  config: HostingConfig
  secret: string
  key: string
  path: string
  mime: string
  date: Date
  signal?: AbortSignal | undefined
  request?: UploadRequest | undefined
  stallMs?: number | undefined
}): Promise<void> {
  const file = await open(input.path, 'r')
  let body: Readable | undefined
  let call: ClientRequest | undefined
  let connecting: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => {
    const error = aborted()
    body?.destroy(error)
    call?.destroy(error)
  }
  try {
    const metadata = await file.stat()
    const { size } = metadata
    const digest = await payloadHash(file, input.path, metadata, input.signal)
    input.signal?.throwIfAborted()
    const { url, headers } = signTosRequest({ config: input.config, secret: input.secret, key: input.key, method: 'PUT', mime: input.mime, date: input.date, payloadHash: digest, contentLength: size })
    const stallMs = input.stallMs ?? 60_000
    // The pin's signed length is fixed even if a caller violates immutability while the request is being created.
    body = size > 0 ? file.createReadStream({ start: 0, end: size - 1, autoClose: false }) : Readable.from([])
    await new Promise<void>((resolve, reject) => {
      body!.once('error', error => { call?.destroy(error); reject(error) })
      input.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.signal?.aborted) { onAbort(); return }
      call = (input.request ?? httpsRequest)(new URL(url), { method: 'PUT', headers }, response => {
        // Error bodies can echo credentials and signed URLs; never collect them.
        response.resume()
        response.once('error', reject)
        response.once('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve()
          else reject(new Error('Media hosting upload failed'))
        })
      })
      call.once('error', reject)
      if (input.signal?.aborted) { onAbort(); return }
      const stalled = () => call!.destroy(new Error('Media hosting upload stalled'))
      // Socket inactivity tracks network progress, rather than how quickly a stream fills its local buffer.
      call.setTimeout(stallMs, stalled)
      connecting = setTimeout(stalled, stallMs)
      call.once('socket', socket => {
        if (socket.connecting) socket.once('connect', () => clearTimeout(connecting))
        else clearTimeout(connecting)
      })
      call.once('close', () => { input.signal?.removeEventListener('abort', onAbort); body?.destroy() })
      body!.pipe(call)
    })
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    clearTimeout(connecting)
    body?.destroy()
    await file.close()
  }
}
