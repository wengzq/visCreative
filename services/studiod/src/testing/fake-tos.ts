import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { request } from 'node:http'
import type { UploadRequest } from '../tos-upload'
import { createIsolatedHttpServer } from '../../../../scripts/testing/isolated-http'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const escape = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

// Independent server-side verification, also exercised with mutated requests by the tests.
function verify(method: string, url: URL, headers: Record<string, string | string[] | undefined>, body: Buffer, accessKeyId: string, secret: string) {
  const query = url.searchParams.has('X-Tos-Signature')
  const authorization = /^TOS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(String(headers.authorization ?? ''))
  const credential = query ? url.searchParams.get('X-Tos-Credential') : authorization?.[1]
  const names = (query ? url.searchParams.get('X-Tos-SignedHeaders') : authorization?.[2])?.split(';')
  const signature = query ? url.searchParams.get('X-Tos-Signature') : authorization?.[3]
  const date = query ? url.searchParams.get('X-Tos-Date') : headers['x-tos-date']
  if (!credential || !names?.includes('host') || !signature || typeof date !== 'string' || !/^\d{8}T\d{6}Z$/.test(date)) return false
  const [id, day, region, service, terminator, extra] = credential.split('/')
  if (id !== accessKeyId || day !== date.slice(0, 8) || region !== 'cn-beijing' || service !== 'tos' || terminator !== 'request' || extra) return false
  if (headers.host !== `${url.host.split('.tos-')[0]}.tos-${region}.volces.com`) return false
  if (query) {
    if (url.searchParams.get('X-Tos-Algorithm') !== 'TOS4-HMAC-SHA256' || names.join(';') !== 'host') return false
    const ttl = Number(url.searchParams.get('X-Tos-Expires'))
    const parsed = Date.parse(date.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'))
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800 || Date.now() > parsed + ttl * 1000) return false
  } else {
    if (!names.includes('x-tos-content-sha256') || !names.includes('x-tos-date') || headers['x-tos-content-sha256'] !== hash(body)) return false
    if (Object.keys(headers).some(name => name.startsWith('x-tos-') && !names.includes(name))) return false
  }
  const parameters = [...url.searchParams].filter(([name]) => name !== 'X-Tos-Signature').map(([name, value]) => `${escape(name)}=${escape(value)}`).sort().join('&')
  const canonicalHeaders = names.map(name => `${name}:${String(headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('')
  const canonical = [method, url.pathname, parameters, canonicalHeaders, names.join(';'), query ? 'UNSIGNED-PAYLOAD' : hash(body)].join('\n')
  const scope = `${day}/${region}/tos/request`
  let signingKey = Buffer.from(secret)
  for (const value of [day!, region!, 'tos', 'request']) signingKey = createHmac('sha256', signingKey).update(value).digest()
  const expected = createHmac('sha256', signingKey).update(['TOS4-HMAC-SHA256', date, scope, hash(canonical)].join('\n')).digest()
  const actual = Buffer.from(signature, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function createFakeTos() {
  const state = {
    objects: new Map<string, Buffer>(),
    requests: [] as { method: string; key: string }[],
    uploadSizes: [] as number[],
    uploadContentLengths: [] as number[],
    uploadSignedLengths: [] as boolean[],
    uploadWriteSizes: [] as number[],
    uploadChunkDelayMs: 0, stallUpload: false,
    verified: 0, rejected: 0,
    fail: undefined as 'upload' | 'read' | 'delete' | 'list' | undefined,
    corruptRead: false, missingOnDelete: false,
    listOutsidePrefix: false, repeatToken: false,
  }
  const isolated = createIsolatedHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk))
        if (req.method === 'PUT' && state.stallUpload) { req.pause(); await new Promise<void>(resolve => req.once('close', resolve)); return }
        if (req.method === 'PUT' && state.uploadChunkDelayMs) {
          res.writeProcessing()
          await new Promise<void>(resolve => setTimeout(resolve, state.uploadChunkDelayMs))
        }
      }
    } catch { res.destroy(); return }
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, `https://${req.headers.host}`)
    if (!verify(req.method!, url, req.headers, body, 'testAK', 'testSK')) { state.rejected++; res.writeHead(403).end('Invalid signature'); return }
    state.verified++
    const key = decodeURIComponent(url.pathname.slice(1))
    const method = url.searchParams.get('list-type') === '2' ? 'LIST' : req.method!
    state.requests.push({ method, key })
    const step = method === 'PUT' ? 'upload' : method === 'DELETE' ? 'delete' : method === 'LIST' ? 'list' : 'read'
    if (url.hostname.split('.')[0] !== 'reference-clips' || state.fail === step) {
      res.writeHead(403).end(`Rejected testAK testSK ${url.href}`)
      return
    }
    if (method === 'PUT') {
      state.uploadSizes.push(body.length)
      state.uploadContentLengths.push(Number(req.headers['content-length']))
      state.uploadSignedLengths.push(/SignedHeaders=[^,]*content-length/.test(req.headers.authorization ?? ''))
      state.objects.set(key, body)
      res.writeHead(200).end()
    } else if (method === 'DELETE') {
      state.objects.delete(key)
      res.writeHead(state.missingOnDelete ? 404 : 204).end()
    } else if (method === 'LIST') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const token = url.searchParams.get('continuation-token') ?? ''
      const keys = [...state.objects.keys()].filter(key => key.startsWith(prefix) && key > token).sort()
      const page = keys.slice(0, 2)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        Contents: state.listOutsidePrefix ? [{ Key: 'someone-else/clip.mp4' }] : page.map(Key => ({ Key })),
        IsTruncated: state.repeatToken || keys.length > page.length,
        ...(state.repeatToken || keys.length > page.length ? { NextContinuationToken: state.repeatToken ? 'same-token' : page.at(-1) } : {}),
      }))
    } else if (method === 'GET' && state.objects.has(key)) {
      res.end(state.corruptRead ? Buffer.from('corrupt') : state.objects.get(key))
    } else res.writeHead(404).end()
  })
  const { server } = isolated
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = isolated.baseUrl
  return Object.assign(state, {
    uploadRequest: ((input, options, listener) => {
      const url = new URL(String(input))
      const call = request(`${origin}${url.pathname}${url.search}`, options, listener)
      const write = call.write.bind(call)
      call.write = ((chunk, ...rest) => {
        state.uploadWriteSizes.push(Buffer.byteLength(chunk))
        return Reflect.apply(write, call, [chunk, ...rest])
      }) as typeof call.write
      return call
    }) as UploadRequest,
    fetch: (async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      headers.set('host', url.host)
      // node:http preserves the signed Host while routing exclusively to loopback.
      return new Promise<Response>((resolve, reject) => {
        const call = request(`${origin}${url.pathname}${url.search}`, { method: init?.method ?? 'GET', headers: Object.fromEntries(headers), ...(init?.signal ? { signal: init.signal } : {}) }, response => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('error', reject)
          response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode ?? 500, headers: { 'content-type': 'application/json' } })))
        })
        call.on('error', reject)
        call.end(init?.body)
      })
    }) as typeof fetch,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  })
}
