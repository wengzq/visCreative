import { VisError } from '@vis/domain'
import { MAX_PRESIGN_SECONDS, type HostedInputs } from '@vis/generation'
import type { HostingConfig, HostingErrorReason } from '@vis/protocol'
import type { SecretStore } from './secret-store'
import { redactHostingText } from './hosting-redaction'
import { presignTosGet, sha256, signTosRequest } from './tos-signing'
import { uploadTosFile, type UploadRequest } from './tos-upload'

export type HostingOptions = {
  dataDir: string
  secrets: SecretStore
  /** Test transport injection keeps signed production URLs away from real services. */
  fetch?: typeof fetch | undefined
  now?: () => Date
  uploadRequest?: UploadRequest | undefined
  uploadStallMs?: number
}

type InputsOptions = Omit<HostingOptions, 'dataDir'> & { getConfig(): HostingConfig | null; hasSecret(): boolean }
const extensions: Record<string, string> = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
}
export const hostingFailure = (reason: HostingErrorReason = 'hosting.upload_failed') => VisError.of('unavailable', reason, {}, reason === 'hosting.store_failed' ? 'Media hosting settings operation failed' : 'Media hosting operation failed')
const notConfigured = () => VisError.of('unavailable', 'hosting.not_configured', {}, 'Media hosting is not configured')

export function createTosClient(opts: InputsOptions) {
  const request = opts.fetch ?? fetch
  async function credentials() {
    const config = opts.getConfig()
    if (!config) throw notConfigured()
    let secret: string | undefined
    try { secret = await opts.secrets.get(config.type) } catch { throw hostingFailure('hosting.store_failed') }
    if (!secret) throw hostingFailure()
    return { config, secret }
  }
  type Credentials = Awaited<ReturnType<typeof credentials>>
  async function signed(auth: Credentials, method: 'GET' | 'PUT' | 'DELETE', key: string, options: { body?: Buffer; mime?: string; query?: Record<string, string>; signal?: AbortSignal | undefined } = {}) {
    const { url, headers } = signTosRequest({ ...auth, method, key, ...options, date: opts.now?.() ?? new Date() })
    const response = await request(url, { method, headers, ...(options.body ? { body: new Uint8Array(options.body) } : {}), signal: options.signal ?? AbortSignal.timeout(60_000), redirect: 'error' })
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      await response.body?.cancel()
      throw hostingFailure()
    }
    return response
  }
  return {
    credentials,
    async put(auth: Credentials, key: string, body: Buffer, mime: string, signal?: AbortSignal) {
      const response = await signed(auth, 'PUT', key, { body, mime, signal })
      await response.body?.cancel()
    },
    presign(auth: Credentials, key: string, ttlSeconds: number) { return presignTosGet({ ...auth, key, ttlSeconds, date: opts.now?.() ?? new Date() }) },
    async read(url: string) {
      const response = await request(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
      if (!response.ok) { await response.body?.cancel(); throw hostingFailure() }
      return Buffer.from(await response.arrayBuffer())
    },
    async delete(auth: Credentials, key: string) {
      const response = await signed(auth, 'DELETE', key)
      await response.body?.cancel()
    },
    async release(auth: Credentials, key: string) {
      const prefix = `${auth.config.prefix}${sha256(key)}/`
      let token = ''
      const tokens = new Set<string>()
      do {
        const response = await signed(auth, 'GET', '', { query: { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) } })
        const page: unknown = await response.json()
        if (!page || typeof page !== 'object') throw hostingFailure()
        const { Contents = [], IsTruncated, NextContinuationToken } = page as Record<string, unknown>
        if (!Array.isArray(Contents) || typeof IsTruncated !== 'boolean') throw hostingFailure()
        for (const object of Contents) {
          // A malformed response must never widen cleanup beyond the job's prefix.
          if (!object || typeof object.Key !== 'string' || !object.Key.startsWith(prefix)) throw hostingFailure()
          await this.delete(auth, object.Key)
        }
        if (!IsTruncated) return
        if (typeof NextContinuationToken !== 'string' || !NextContinuationToken || tokens.has(NextContinuationToken)) throw hostingFailure()
        tokens.add(NextContinuationToken)
        token = NextContinuationToken
      } while (token)
    },
  }
}

export function createHostedInputs(opts: InputsOptions): HostedInputs {
  const tos = createTosClient(opts)
  return {
    get configured() { return Boolean(opts.getConfig() && opts.hasSecret()) },
    redact(text) { return redactHostingText(text, opts.getConfig()) },
    async url(input, ttlSeconds, signal) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_PRESIGN_SECONDS) throw new Error('Invalid media hosting link lifetime')
      try {
        signal?.throwIfAborted()
        const separator = input.key.lastIndexOf(':')
        const key = input.key.slice(0, separator)
        const ordinal = input.key.slice(separator + 1)
        const extension = extensions[input.mime]
        if (separator < 1 || !/^(0|[1-9]\d*)$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)) || !extension) throw hostingFailure()
        const auth = await tos.credentials()
        const object = `${auth.config.prefix}${sha256(key)}/${ordinal}.${extension}`
        // An injected fetch must never fall through to a real upload during tests.
        if (opts.fetch && !opts.uploadRequest) throw hostingFailure()
        await uploadTosFile({ ...auth, key: object, path: input.path, mime: input.mime, date: opts.now?.() ?? new Date(), signal, request: opts.uploadRequest, stallMs: opts.uploadStallMs })
        return tos.presign(auth, object, ttlSeconds)
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Media hosting operation aborted', 'AbortError')
        if (error instanceof VisError && error.details?.reason === 'hosting.not_configured') throw notConfigured()
        if (error instanceof VisError && error.details?.reason === 'hosting.store_failed') throw hostingFailure('hosting.store_failed')
        // Never carry vendor text, causes, paths or request objects across this boundary.
        throw hostingFailure()
      }
    },
    async release(key) {
      try {
        const auth = await tos.credentials()
        await tos.release(auth, key)
      } catch (error) {
        if (error instanceof VisError && error.details?.reason === 'hosting.store_failed') throw hostingFailure('hosting.store_failed')
        throw hostingFailure()
      }
    },
  }
}
