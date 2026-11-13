import { randomUUID } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'

/** Keep unrelated localhost probes out of fixture handlers without filtering adapter mistakes. */
export function createIsolatedHttpServer(handler: RequestListener) {
  const prefix = `/${randomUUID()}`
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`)) {
      res.writeHead(404).end()
      return
    }
    // Restore the provider path before routing, recording or verifying a signed request.
    const path = url.slice(prefix.length)
    req.url = path.startsWith('/') ? path : `/${path}`
    handler(req, res)
  })
  return {
    server,
    get baseUrl() {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Isolated HTTP server has not started')
      return `http://127.0.0.1:${address.port}${prefix}`
    },
  }
}
