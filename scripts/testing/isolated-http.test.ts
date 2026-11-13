import { expect, it } from 'vitest'
import { createIsolatedHttpServer } from './isolated-http'

it('ignores localhost probes while retaining unauthorized, unexpected and output requests from its client', async () => {
  const requests: { method: string | undefined; path: string | undefined; authorization: string | undefined; body: string }[] = []
  const fixture = createIsolatedHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() })
    res.writeHead(req.url === '/unexpected' ? 404 : req.headers.authorization ? 200 : 401).end()
  })
  await new Promise<void>(resolve => fixture.server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = fixture.baseUrl
    const origin = new URL(baseUrl).origin
    for (const url of [origin, `${origin}/v1/tasks`, `${baseUrl}-other/tasks`]) {
      expect((await fetch(url)).status).toBe(404)
    }
    expect(requests).toEqual([])
    expect((await fetch(`${baseUrl}/v1/tasks`, { method: 'POST', body: '{"prompt":"test"}' })).status).toBe(401)
    expect((await fetch(`${baseUrl}/unexpected`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/output?revision=2`, { headers: { Authorization: 'Bearer fixture-key' } })).status).toBe(200)
    expect((await fetch(`${baseUrl}?list-type=2`)).status).toBe(401)
    expect(requests).toEqual([
      { method: 'POST', path: '/v1/tasks', authorization: undefined, body: '{"prompt":"test"}' },
      { method: 'GET', path: '/unexpected', authorization: undefined, body: '' },
      { method: 'GET', path: '/output?revision=2', authorization: 'Bearer fixture-key', body: '' },
      { method: 'GET', path: '/?list-type=2', authorization: undefined, body: '' },
    ])
  } finally {
    fixture.server.closeAllConnections()
    await new Promise<void>(resolve => fixture.server.close(() => resolve()))
  }
})
