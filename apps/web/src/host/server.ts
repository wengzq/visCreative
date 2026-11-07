import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { WRITING_LIMITS, RequestId, type AssetVersionView, type ErrorData } from '@vis/protocol'
import { WebSocketServer } from 'ws'
import { HOST_ID_PREFIX, LinkError, openStudiodLink, type StudiodLink } from './studiod-link'
import { builtinFontFile } from './fonts'

export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3

export type WebHostOptions = {
  socketPath: string
  tokenPath: string
  /** Browser build output directory */
  staticDir: string
  /** Random port by default */
  port?: number
  maxUploadBytes?: number
}

export type WebHost = {
  url: string
  port: number
  token: string
  close(): Promise<void>
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon',
}

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
  'model/gltf-binary': '.glb',
}

/**
 * Local web host (0006): listens only on 127.0.0.1. Pages and scripts are public; WebSocket, assets, and uploads require the startup-generated token,
 * with Host checks against DNS rebinding and Origin checks against cross-site access from other pages.
 */
export async function createWebHost(opts: WebHostOptions): Promise<WebHost> {
  const token = randomBytes(24).toString('base64url')
  const maxUpload = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES
  let port = 0
  const origin = () => `http://127.0.0.1:${port}`
  const sockets = new Set<StudiodLink>()

  // Assets and uploads access studiod through one host-owned connection per space
  const services = new Map<string, Promise<StudiodLink>>()
  let seriesLink: Promise<StudiodLink> | undefined
  function seriesService() {
    seriesLink ??= openStudiodLink({ socketPath: opts.socketPath, tokenPath: opts.tokenPath, onClose: () => { seriesLink = undefined } })
      .then(link => { sockets.add(link); return link })
    seriesLink.catch(() => { seriesLink = undefined })
    return seriesLink
  }
  function service(spaceId: string): Promise<StudiodLink> {
    let link = services.get(spaceId)
    if (!link) {
      link = openStudiodLink({ socketPath: opts.socketPath, tokenPath: opts.tokenPath, onClose: () => services.delete(spaceId) })
        .then(async l => {
          sockets.add(l)
          try {
            await l.call('events.subscribe', { spaceId })
          } catch (error) {
            // For missing spaces and similar cases, close the handshaken connection so repeated requests do not accumulate connections and delay studiod idle exit
            sockets.delete(l)
            l.close()
            throw error
          }
          return l
        })
      link.catch(() => services.delete(spaceId))
      services.set(spaceId, link)
    }
    return link
  }

  const hostOk = (req: IncomingMessage) => req.headers.host === `127.0.0.1:${port}`
  const tokenOk = (url: URL) => {
    const given = Buffer.from(url.searchParams.get('t') ?? '')
    const expected = Buffer.from(token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) sendError(res, error instanceof LinkError && error.code === 'unavailable' ? 503 : 500, errorCode(error), errorMessage(error), error instanceof LinkError ? error.data : undefined)
      else res.destroy()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!hostOk(req)) return sendError(res, 403, 'forbidden', 'Host mismatch', { reason: 'host.host_mismatch' })
    const url = new URL(req.url ?? '/', origin())
    const font = url.pathname.match(/^\/fonts\/([^/]+)$/)
    if (font) {
      if (!tokenOk(url)) return sendError(res, 403, 'forbidden', 'Invalid token', { reason: 'host.invalid_token' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'invalid_params', 'Only GET is supported', { reason: 'host.method_not_allowed', params: { method: 'GET' } })
      if (req.headers.origin && req.headers.origin !== origin()) return sendError(res, 403, 'forbidden', 'Origin mismatch', { reason: 'host.origin_mismatch' })
      const path = builtinFontFile(decodeURIComponent(font[1]!))
      const info = path ? await stat(path).catch(() => undefined) : undefined
      if (!path || !info?.isFile()) return sendError(res, 404, 'unavailable', 'Bundled font is missing; run pnpm fonts:fetch', { reason: 'media.font_missing' })
      res.writeHead(200, { 'Content-Type': extname(path).toLowerCase() === '.otf' ? 'font/otf' : 'font/ttf', 'Content-Length': info.size, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      if (req.method === 'HEAD') return res.end()
      await pipeline(createReadStream(path), res).catch(() => {})
      return
    }
    const exported = url.pathname.match(/^\/exports\/([^/]+)\/([^/]+)$/)
    if (exported) {
      if (!tokenOk(url)) return sendError(res, 403, 'forbidden', 'Invalid token', { reason: 'host.invalid_token' })
      if (req.headers.origin && req.headers.origin !== origin()) return sendError(res, 403, 'forbidden', 'Origin mismatch', { reason: 'host.origin_mismatch' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'invalid_params', 'Only GET is supported', { reason: 'host.method_not_allowed', params: { method: 'GET' } })
      let file
      try { file = await (await service(decodeURIComponent(exported[1]!))).call('media.exportDownload', { taskId: decodeURIComponent(exported[2]!) }) }
      catch (error) {
        if (error instanceof LinkError && error.code === 'not_found') return sendError(res, 404, error.code, error.message, error.data)
        if (error instanceof URIError || (error instanceof LinkError && error.code === 'invalid_params')) return sendError(res, 400, 'invalid_params', 'Invalid export task', { reason: 'media.task_not_found' })
        throw error
      }
      const info = await stat(file.path).catch(() => undefined)
      if (!info?.isFile()) return sendError(res, 404, 'not_found', 'The MOV export is unavailable or has expired; export it again', { reason: 'media.export_expired' })
      const range = parseRange(req.headers.range, info.size)
      if (range === 'invalid') { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end() }
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'video/quicktime', 'Content-Length': range ? range.end - range.start + 1 : info.size,
        'Content-Disposition': `attachment; filename="${file.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}),
      })
      if (req.method === 'HEAD') return res.end()
      await pipeline(createReadStream(file.path, range ?? {}), res).catch(() => {})
      return
    }
    const asset = url.pathname.match(/^\/assets\/([^/]+)\/([^/]+)$/)
    if (asset) {
      if (!tokenOk(url)) return sendError(res, 403, 'forbidden', 'Invalid token', { reason: 'host.invalid_token' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'invalid_params', 'Only GET is supported', { reason: 'host.method_not_allowed', params: { method: 'GET' } })
      return serveAsset(req, res, decodeURIComponent(asset[1]!), decodeURIComponent(asset[2]!), url.searchParams.get('download') === '1')
    }
    const seriesMedia = url.pathname.match(/^\/series-media\/([^/]+)\/([^/]+)$/)
    if (seriesMedia) {
      if (!tokenOk(url)) return sendError(res, 403, 'forbidden', 'Invalid token', { reason: 'host.invalid_token' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'invalid_params', 'Only GET is supported', { reason: 'host.method_not_allowed', params: { method: 'GET' } })
      if (req.headers.origin && req.headers.origin !== origin()) return sendError(res, 403, 'forbidden', 'Origin mismatch', { reason: 'host.origin_mismatch' })
      const link = await seriesService()
      let media: { path: string; mime: string }
      try { media = await link.call('series.mediaGet', { seriesId: decodeURIComponent(seriesMedia[1]!), refId: decodeURIComponent(seriesMedia[2]!) }) }
      catch (error) {
        // A malformed URL is the client's fault, not a server failure.
        if (error instanceof URIError) return sendError(res, 404, 'not_found', 'Series reference does not exist', { reason: 'series.ref_not_found' })
        if (error instanceof LinkError && error.code === 'not_found') return sendError(res, 404, 'not_found', error.message, error.data)
        if (error instanceof LinkError && error.code === 'invalid_params') return sendError(res, 400, 'invalid_params', error.message, error.data)
        throw error
      }
      const info = await stat(media.path).catch(() => undefined)
      if (!info?.isFile()) return sendError(res, 404, 'not_found', 'Series reference file is missing', { reason: 'series.ref_not_found' })
      const headers = { 'Content-Type': media.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'" }
      const range = parseRange(req.headers.range, info.size)
      if (range === 'invalid') { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end() }
      res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': range ? range.end - range.start + 1 : info.size,
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}) })
      if (req.method === 'HEAD') return res.end()
      await pipeline(createReadStream(media.path, range ?? {}), res).catch(() => {})
      return
    }
    const preview = url.pathname.match(/^\/previews\/([^/]+)\/([^/]+)\/(filmstrip|poster|thumbnail)$/)
    if (preview) {
      if (!tokenOk(url)) return sendError(res, 403, 'forbidden', 'Invalid token', { reason: 'host.invalid_token' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'invalid_params', 'Only GET is supported', { reason: 'host.method_not_allowed', params: { method: 'GET' } })
      if (req.headers.origin && req.headers.origin !== origin()) return sendError(res, 403, 'forbidden', 'Origin mismatch', { reason: 'host.origin_mismatch' })
      return servePreview(req, res, decodeURIComponent(preview[1]!), decodeURIComponent(preview[2]!), preview[3] as 'filmstrip' | 'poster' | 'thumbnail')
    }
    if (url.pathname === '/upload') {
      if (!tokenOk(url)) return sendError(res, 403, 'forbidden', 'Invalid token', { reason: 'host.invalid_token' })
      if (req.method !== 'POST') return sendError(res, 405, 'invalid_params', 'Only POST is supported', { reason: 'host.method_not_allowed', params: { method: 'POST' } })
      if (req.headers.origin !== origin()) return sendError(res, 403, 'forbidden', 'Origin mismatch', { reason: 'host.origin_mismatch' })
      return upload(req, res, url)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'invalid_params', 'Only GET is supported', { reason: 'host.method_not_allowed', params: { method: 'GET' } })
    return serveStatic(res, url.pathname)
  }

  async function servePreview(req: IncomingMessage, res: ServerResponse, spaceId: string, assetVersionId: string, kind: 'filmstrip' | 'poster' | 'thumbnail') {
    let path: string | undefined
    try {
      const view = await (await service(spaceId)).call('media.preview', { assetVersionId, kind })
      if (view.kind === kind) path = view.path
    } catch (error) {
      if (error instanceof LinkError && error.code === 'not_found') return sendError(res, 404, 'not_found', 'Media preview does not exist', { reason: 'host.preview_not_found' })
      if (error instanceof LinkError && error.code === 'invalid_params') return sendError(res, 400, error.code, error.message, error.data)
      throw error
    }
    const info = path ? await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    }) : undefined
    if (!path || !info?.isFile()) return sendError(res, 404, 'not_found', 'Media preview has no local file', { reason: 'host.preview_file_missing' })
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': info.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'",
    })
    if (req.method === 'HEAD') return res.end()
    await pipeline(createReadStream(path), res).catch(() => {})
  }

  async function serveAsset(req: IncomingMessage, res: ServerResponse, spaceId: string, assetVersionId: string, download: boolean) {
    let view: AssetVersionView
    try {
      view = await (await service(spaceId)).call('asset.get', { assetVersionId })
    } catch (error) {
      if (error instanceof LinkError && error.code === 'not_found') return sendError(res, 404, 'not_found', error.message, error.data)
      throw error
    }
    if (!view.path) return sendError(res, 404, 'not_found', 'Asset has no local file', { reason: 'host.asset_file_missing' })
    const { size } = await stat(view.path)
    const headers: Record<string, string | number> = {
      'Content-Type': view.mime,
      'Accept-Ranges': 'bytes',
      // Content-addressed; the same version never changes content
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'",
    }
    if (download) {
      let name = (view.displayName ?? '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_').trim().replace(/^\.+|\.+$/g, '')
      if (!name) name = `${view.kind}-${new Date().toISOString().slice(0, 10)}`
      if (!extname(name)) name += DOWNLOAD_EXTENSIONS[view.mime] ?? '.bin'
      const ascii = name.replace(/[^\x20-\x7e]/g, '_')
      const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
    }
    const range = parseRange(req.headers.range, size)
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    if (range) {
      res.writeHead(206, { ...headers, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${size}` })
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size })
    }
    if (req.method === 'HEAD') return res.end()
    await pipeline(createReadStream(view.path, range ?? {}), res).catch(() => {})
  }

  async function upload(req: IncomingMessage, res: ServerResponse, url: URL) {
    const spaceId = url.searchParams.get('space')
    const name = basename(url.searchParams.get('name') ?? '')
    if (!spaceId || !name) return sendError(res, 400, 'invalid_params', 'space and name are required', { reason: 'upload.missing_fields' })
    const requestId = url.searchParams.get('requestId') ?? undefined
    const contentHash = url.searchParams.get('contentHash') ?? undefined
    if (requestId && (!RequestId.safeParse(requestId).success || !contentHash?.match(/^[a-f0-9]{64}$/))) return sendError(res, 400, 'invalid_params', 'Content-addressed uploads require a valid requestId and SHA-256 hash', { reason: 'upload.invalid_identity' })
    const fontLimit = /\.[ot]tf$/i.test(name) && url.searchParams.get('kind') !== 'skill' && maxUpload >= 50 * 1024 ** 2
    const modelUpload = /\.glb$/i.test(name) && !['skill', 'writing'].includes(url.searchParams.get('kind') ?? '')
    const writingUpload = url.searchParams.get('kind') === 'writing'
    const modelLimit = modelUpload && maxUpload >= 32 * 1024 ** 2
    const limit = writingUpload ? Math.min(maxUpload, WRITING_LIMITS.uploadBytes) : modelUpload ? Math.min(maxUpload, 32 * 1024 ** 2) : fontLimit ? 50 * 1024 ** 2 : maxUpload
    const tooLarge = () => sendError(res, 413, 'invalid_params', 'File too large', modelLimit ? { reason: 'asset.model_too_large' } : fontLimit ? { reason: 'asset.font_too_large' } : { reason: 'upload.too_large', params: { maxBytes: limit } })
    if (Number(req.headers['content-length'] ?? 0) > limit) return tooLarge()
    const dir = await mkdtemp(join(tmpdir(), 'vis-web-upload-'))
    let view: unknown
    try {
      try {
        // Client names can be invalid or too long for the file system; asset imports keep them as displayName.
        const file = join(dir, writingUpload || url.searchParams.get('kind') === 'skill' ? name : `upload${extname(name)}`)
        let received = 0
        req.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > limit) req.destroy(new Error('File too large'))
        })
        try {
          await pipeline(req, createWriteStream(file))
        } catch {
          return received > limit
            ? tooLarge()
            : sendError(res, 400, 'invalid_params', 'Upload interrupted', { reason: 'upload.interrupted' })
        }
        const link = await service(spaceId)
        view = writingUpload
          ? await link.call('writing.importPreview', { path: file })
          : url.searchParams.get('kind') === 'skill'
          ? await link.call('skill.stage', { spaceId, path: file })
          : await link.call('asset.import', { requestId: requestId ?? `web-${randomUUID()}`, path: file, displayName: name, ...(contentHash ? { contentHash } : {}) })
      } finally {
        // Staging or import has copied the source; clean uploaded files before both success and failure acknowledgments
        await rm(dir, { recursive: true, force: true })
      }
    } catch (error) {
      if (error instanceof LinkError && (error.code === 'invalid_params' || error.code === 'not_found')) return sendError(res, 400, error.code, error.message, error.data)
      throw error
    }
    sendJson(res, 200, view)
  }

  async function serveStatic(res: ServerResponse, pathname: string) {
    // resolve removes trailing separators, which would otherwise cause false out-of-bounds results
    const root = resolve(opts.staticDir)
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
    const target = join(root, rel)
    if (target !== root && !target.startsWith(root + sep)) return sendError(res, 403, 'forbidden', 'Path is outside the root', { reason: 'host.path_outside_root' })
    let file = target
    let info = await stat(file).catch(() => null)
    // Frontend routing: unknown paths fall back to index.html
    if (!info?.isFile()) {
      file = join(root, 'index.html')
      info = await stat(file).catch(() => null)
      if (!info?.isFile()) return sendError(res, 404, 'not_found', 'UI has not been built', { reason: 'host.ui_not_built' })
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    await pipeline(createReadStream(file), res).catch(() => {})
  }

  // Each browser connection has a corresponding UI connection to studiod; forward JSON-RPC unchanged
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', origin())
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (!hostOk(req) || url.pathname !== '/ws' || !tokenOk(url) || req.headers.origin !== origin()) return reject(403, 'Forbidden')
    const buffered: string[] = []
    let ws: import('ws').WebSocket | undefined
    openStudiodLink({
      socketPath: opts.socketPath,
      tokenPath: opts.tokenPath,
      onMessage: line => { if (ws) ws.send(line); else buffered.push(line) },
      onClose: () => ws?.close(1011, 'studiod_closed'),
    }).then(
      link => {
        sockets.add(link)
        wss.handleUpgrade(req, socket, head, client => {
          ws = client
          for (const line of buffered.splice(0)) client.send(line)
          client.on('message', data => {
            const line = data.toString()
            const problem = checkClientMessage(line)
            if (problem) {
              client.send(JSON.stringify({ jsonrpc: '2.0', id: problem.id, error: { code: -32600, message: problem.message, data: { code: 'forbidden' } } }))
              return
            }
            link.send(line)
          })
          client.on('close', () => { link.close(); sockets.delete(link) })
        })
      },
      () => reject(503, 'Service Unavailable'),
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port

  return {
    url: `${origin()}/#t=${token}`,
    port,
    token,
    async close() {
      for (const client of wss.clients) client.terminate()
      for (const link of sockets) link.close()
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

/** Browsers cannot perform their own handshake or impersonate host request IDs */
function checkClientMessage(line: string): { id: unknown; message: string } | null {
  let msg: { id?: unknown; method?: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return { id: null, message: 'Invalid JSON' }
  }
  const id = msg?.id ?? null
  if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') return { id, message: 'Missing method' }
  if (msg.method === 'runtime.hello') return { id, message: 'The host performs the handshake' }
  if (typeof id === 'string' && id.startsWith(HOST_ID_PREFIX)) return { id: null, message: `Request id cannot start with ${HOST_ID_PREFIX}` }
  return null
}

/** Supports only one range: bytes=a-b, bytes=a-, or bytes=-n */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, code: string, message: string, data?: Omit<ErrorData, 'code'>) {
  sendJson(res, status, { error: { code, message, data: { code, ...data } } })
}

function errorCode(error: unknown): string {
  return error instanceof LinkError ? error.code : 'internal'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
