import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nJkAAAAASUVORK5CYII=', 'base64')
export type Scenario = 'normal' | 'lost' | 'slow' | 'moderation' | 'output-moderation' | 'unknown-moderation' | 'quota' | 'credit_balance_exhausted' | 'organization_spend_limit_exceeded' | 'project_spend_limit_exceeded' | 'organization_usage_limit_exceeded' | 'rate' | 'auth' | 'verification' | 'forbidden' | 'server' | 'invalid' | 'secret-error' | 'unparseable' | 'invalid-base64' | 'url-output' | 'wrong-mime' | 'oversized'

export async function fakeOpenAI(initial: Scenario = 'normal') {
  let scenario = initial
  let override: { status: number; body: string; contentType: string; chunked?: boolean; truncated?: boolean } | undefined
  const requests: { path: string; fields: Record<string, unknown>; images: { name: string; type: string; data: Buffer }[]; trace: string | undefined }[] = []
  let count = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    if (!['/v1/images/generations', '/v1/images/edits'].includes(req.url ?? '')) { res.writeHead(404).end(); return }
    count++
    const images: { name: string; type: string; data: Buffer }[] = []
    let fields: Record<string, unknown>
    if (req.headers['content-type']?.startsWith('multipart/form-data')) {
      const form = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
      fields = {}
      for (const [key, value] of form) {
        if (typeof value === 'string') fields[key] = value
        else images.push({ name: key, type: value.type, data: Buffer.from(await value.arrayBuffer()) })
      }
    } else fields = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    requests.push({ path: req.url!, fields, images, trace: req.headers['x-client-request-id'] as string | undefined })
    if (scenario === 'lost') { req.socket.destroy(); return }
    const send = () => {
      if (override) {
        res.writeHead(override.status, {
          'Content-Type': override.contentType,
          ...(override.chunked ? {} : { 'Content-Length': String(Buffer.byteLength(override.body) + (override.truncated ? 10 : 0)) }),
        })
        if (override.truncated) {
          res.flushHeaders()
          res.write(override.body)
          setImmediate(() => res.destroy())
        } else res.end(override.body)
        return
      }
      let status = 200
      let result: unknown
      const error = (code: string, message = 'Fake request failed', extra = {}) => ({ error: { code, message, ...extra } })
      switch (scenario) {
        case 'moderation': case 'output-moderation': case 'unknown-moderation':
          status = 400
          result = error('moderation_blocked', 'Blocked', { moderation_details: { moderation_stage: scenario === 'moderation' ? 'input' : scenario === 'output-moderation' ? 'output' : 'unknown' } })
          break
        case 'quota': status = 429; result = error('insufficient_quota'); break
        case 'credit_balance_exhausted': case 'organization_spend_limit_exceeded': case 'project_spend_limit_exceeded': case 'organization_usage_limit_exceeded':
          status = 429; result = error(scenario); break
        case 'rate': status = 429; res.setHeader('Retry-After', '1'); result = error('rate_limit_exceeded'); break
        case 'auth': status = 401; result = error('invalid_api_key'); break
        case 'verification': status = 403; result = error('permission_denied', 'Your organization must be verified to use this model'); break
        case 'forbidden': status = 403; result = error('permission_denied'); break
        case 'server': status = 503; result = error('server_error'); break
        case 'invalid': status = 400; result = error('invalid_request_error', 'Unsupported size'); break
        case 'secret-error': {
          status = 400
          const key = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
          result = error('invalid_request_error', `Authorization: Bearer ${key}; key=${encodeURIComponent(key)}; Bearer ${key}`)
          break
        }
        case 'unparseable': res.writeHead(200).end('{'); return
        case 'invalid-base64': result = { data: [{ b64_json: '!!!!' }] }; break
        case 'url-output': result = { data: [{ url: 'https://should-never-fetch.invalid/image.png' }] }; break
        default: {
          const bytes = scenario === 'wrong-mime' ? Buffer.from('<html>not an image</html>') : scenario === 'oversized' ? Buffer.concat([PNG, Buffer.alloc(1100)]) : PNG
          result = { data: Array.from({ length: Number(fields.n ?? 1) }, () => ({ b64_json: bytes.toString('base64') })), usage: { total_tokens: 12, input_tokens: 2, output_tokens: 10 } }
        }
      }
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    }
    if (scenario === 'slow') {
      const timer = setTimeout(() => { timers.delete(timer); send() }, 500)
      timers.add(timer)
    } else send()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests, creates: () => count, setScenario: (next: Scenario) => { scenario = next },
    setResponse: (response: NonNullable<typeof override>) => { override = response },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
