import { createHash, createHmac } from 'node:crypto'
import { MAX_PRESIGN_SECONDS } from '@vis/generation'
import type { HostingConfig } from '@vis/protocol'

type Config = Pick<HostingConfig, 'region' | 'bucket' | 'accessKeyId'>
type SigningInput = { config: Config; secret: string; key: string; date?: Date }
const ALGORITHM = 'TOS4-HMAC-SHA256'
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
const queryString = (query: Record<string, string>) => Object.entries(query).map(([key, value]) => [encode(key), encode(value)] as const).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&')

// TOS uses the raw secret for kDate (no AWS4 prefix). Published vectors: https://docs.volcengine.com/docs/6349/74839
// Query signing uses UNSIGNED-PAYLOAD: https://docs.volcengine.com/docs/torch-object-storage/url-contains-a-signature
function signing(input: SigningInput) {
  const host = `${input.config.bucket}.tos-${input.config.region}.volces.com`
  const path = `/${input.key.split('/').map(encode).join('/')}`
  const date = (input.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
  const scope = `${date.slice(0, 8)}/${input.config.region}/tos/request`
  const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest()
  const key = hmac(hmac(hmac(hmac(input.secret, date.slice(0, 8)), input.config.region), 'tos'), 'request')
  return {
    host, path, date, scope,
    signature(method: string, query: string, headers: Record<string, string>, payload: string) {
      const names = Object.keys(headers).sort()
      const canonical = [method, path, query, names.map(name => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}\n`).join(''), names.join(';'), payload].join('\n')
      return hmac(key, [ALGORITHM, date, scope, sha256(canonical)].join('\n')).toString('hex')
    },
  }
}

export function signTosRequest(input: SigningInput & { method: 'GET' | 'PUT' | 'DELETE'; body?: Uint8Array; payloadHash?: string; contentLength?: number; mime?: string; query?: Record<string, string> }) {
  const sign = signing(input)
  const payload = input.payloadHash ?? sha256(input.body ?? '')
  const headers: Record<string, string> = {
    host: sign.host, 'x-tos-content-sha256': payload, 'x-tos-date': sign.date,
    ...(input.mime ? { 'content-type': input.mime } : {}),
    ...(input.contentLength !== undefined ? { 'content-length': String(input.contentLength) } : {}),
  }
  const query = queryString(input.query ?? {})
  const signature = sign.signature(input.method, query, headers, payload)
  const signedHeaders = Object.keys(headers).sort().join(';')
  headers.authorization = `${ALGORITHM} Credential=${input.config.accessKeyId}/${sign.scope},SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { url: `https://${sign.host}${sign.path}${query ? `?${query}` : ''}`, headers }
}

export function presignTosGet(input: SigningInput & { ttlSeconds: number }): string {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_PRESIGN_SECONDS) throw new Error('Invalid media hosting link lifetime')
  const sign = signing(input)
  const query = queryString({
    'X-Tos-Algorithm': ALGORITHM,
    'X-Tos-Credential': `${input.config.accessKeyId}/${sign.scope}`,
    'X-Tos-Date': sign.date,
    'X-Tos-Expires': String(input.ttlSeconds),
    'X-Tos-SignedHeaders': 'host',
  })
  const signature = sign.signature('GET', query, { host: sign.host }, 'UNSIGNED-PAYLOAD')
  return `https://${sign.host}${sign.path}?${query}&X-Tos-Signature=${signature}`
}
