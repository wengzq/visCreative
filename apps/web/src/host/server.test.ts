import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ErrorData } from '@vis/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createWebHost, parseRange, type WebHost } from './server'
import { LinkError, openStudiodLink } from './studiod-link'

const STUDIOD_TOKEN = 'ui-secret'
const stagedResult = { stagingId: 'stage_1', source: '导入.skill', candidates: [], skipped: [] }

let dir: string
let socketPath: string
let fake: Server
let host: WebHost
let imported: { path: string; existed: boolean; content: string; displayName?: string }[]
let staged: { params: { spaceId: string; path: string }; existed: boolean; content: string }[]
let stageError: string | undefined
let rpcErrorData: Omit<ErrorData, 'code'> | undefined
let assetMetadata: { kind: 'image' | 'video' | 'model'; mime: string; displayName?: string }
let previewPath: string | undefined
let previews: unknown[]
let previewError: 'invalid_params' | 'unavailable' | undefined
const assetFile = () => join(dir, 'blob.bin')

/** Fake studiod: validates UI tokens, answers several methods, and pushes one event after subscribing */
function startFakeStudiod(socketPath: string) {
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    let hello = false
    const send = (msg: object) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const msg = JSON.parse(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        const fail = (code: string) => send({ id: msg.id, error: { code: -32000, message: code, data: { code, ...rpcErrorData } } })
        if (!hello) {
          if (msg.method !== 'runtime.hello' || msg.params.credential.token !== STUDIOD_TOKEN) { fail('forbidden'); socket.end(); return }
          hello = true
          send({ id: msg.id, result: { protocolVersion: 1 } })
          continue
        }
        switch (msg.method) {
          case 'series.mediaGet':
            if (msg.params.seriesId !== 'series_1' || msg.params.refId !== 'ref_1') { fail('not_found'); break }
            send({ id: msg.id, result: { path: assetFile(), mime: 'image/png' } })
            break
          case 'events.subscribe':
            send({ id: msg.id, result: { reset: true, seq: 0, snapshot: { nodes: [], sessions: [], activeJobs: [] } } })
            send({ method: 'events.event', params: { seq: 1, type: 'node.created' } })
            break
          case 'asset.get':
            if (msg.params.assetVersionId !== 'astv_1') { fail('not_found'); break }
            send({ id: msg.id, result: { assetVersionId: 'astv_1', ...assetMetadata, url: 'file:///x', path: assetFile() } })
            break
          case 'media.exportDownload':
            if (msg.params.taskId !== 'media_1' || Object.keys(msg.params).length !== 1) { fail('not_found'); break }
            send({ id: msg.id, result: { path: assetFile(), filename: 'video.mov', mime: 'video/quicktime', byteSize: 10 } })
            break
          case 'media.preview':
            previews.push(msg.params)
            if (msg.params.assetVersionId !== 'astv_1') { fail('not_found'); break }
            if (previewError) { fail(previewError); break }
            send({ id: msg.id, result: { ...(['poster', 'thumbnail'].includes(msg.params.kind) ? { kind: msg.params.kind, width: 960, height: 540 } : { kind: 'filmstrip', durationMs: 10000, frameWidth: 96, frameHeight: 54, intervalMs: 1000, frames: 10 }), ...(previewPath ? { path: previewPath } : {}) } })
            break
          case 'asset.import':
            imported.push({ path: msg.params.path, existed: existsSync(msg.params.path), content: readFileSync(msg.params.path, 'utf8'), displayName: msg.params.displayName })
            send({ id: msg.id, result: { assetVersionId: 'astv_2', displayName: msg.params.displayName } })
            break
          case 'skill.stage':
            staged.push({ params: msg.params, existed: existsSync(msg.params.path), content: readFileSync(msg.params.path, 'utf8') })
            if (stageError) fail(stageError)
            else send({ id: msg.id, result: stagedResult })
            break
          default:
            send({ id: msg.id, result: { echo: msg.method } })
        }
      }
    })
  })
  return new Promise<Server>(r => server.listen(socketPath, () => r(server)))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-web-'))
  socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\vis-web-test-${randomUUID()}` : join(dir, 'run', 'studiod.sock')
  imported = []
  staged = []
  previews = []
  previewError = undefined
  previewPath = assetFile()
  stageError = undefined
  rpcErrorData = undefined
  assetMetadata = { kind: 'video', mime: 'video/mp4' }
  mkdirSync(join(dir, 'run'))
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><title>vis</title>')
  mkdirSync(join(dir, 'client', 'assets'))
  writeFileSync(join(dir, 'client', 'assets', 'index-abc.js'), 'console.log(1)')
  writeFileSync(join(dir, 'secret.txt'), 'outside')
  writeFileSync(join(dir, 'run', 'studiod.token'), STUDIOD_TOKEN)
  writeFileSync(assetFile(), '0123456789')
  fake = await startFakeStudiod(socketPath)
  host = await createWebHost({ socketPath, tokenPath: join(dir, 'run', 'studiod.token'), staticDir: `${join(dir, 'client')}/`, maxUploadBytes: 1000 })
})
afterEach(async () => {
  await host.close()
  await new Promise(r => fake.close(r))
  rmSync(dir, { recursive: true, force: true })
})

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function http(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: host.port, path, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${host.port}`, ...opts.headers } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}
const origin = () => `http://127.0.0.1:${host.port}`
const t = () => `t=${host.token}`

it('accepts model uploads and serves models with binary glTF MIME, ranges, HEAD and GLB download names', async () => {
  assetMetadata = { kind: 'model', mime: 'model/gltf-binary', displayName: 'Bench' }
  const response = await http(`/assets/space/astv_1?${t()}`)
  expect(response.status).toBe(200)
  expect(response.headers['content-type']).toBe('model/gltf-binary')
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  expect(response.body).toBe('0123456789')
  const range = await http(`/assets/space/astv_1?${t()}`, { headers: { Range: 'bytes=2-5' } })
  expect(range.status).toBe(206)
  expect(range.body).toBe('2345')
  const head = await http(`/assets/space/astv_1?${t()}`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers['content-type']).toBe('model/gltf-binary')
  expect(head.body).toBe('')
  const download = await http(`/assets/space/astv_1?${t()}&download=1`)
  expect(download.headers['content-disposition']).toContain('Bench.glb')
  expect((await http('/assets/space/astv_1')).status).toBe(403)
  const uploaded = await http(`/upload?${t()}&space=space&name=bench.glb`, { method: 'POST', headers: { Origin: origin() }, body: 'GLB upload fixture' })
  expect(uploaded.status).toBe(200)
  expect(imported).toHaveLength(1)
  expect(imported[0]).toMatchObject({ existed: true, content: 'GLB upload fixture' })
  expect(existsSync(imported[0]!.path)).toBe(false)
})

it('rejects model uploads above 32 MiB before staging or contacting studiod', async () => {
  await host.close()
  host = await createWebHost({ socketPath, tokenPath: join(dir, 'run', 'studiod.token'), staticDir: join(dir, 'client') })
  const result = await http(`/upload?${t()}&space=space&name=bench.GLB`, {
    method: 'POST', headers: { Origin: origin(), 'Content-Length': String(32 * 1024 ** 2 + 1), Connection: 'close' },
  })
  expect(result.status).toBe(413)
  expect(JSON.parse(result.body)).toMatchObject({ error: { data: { reason: 'asset.model_too_large' } } })
  expect(imported).toEqual([])
})

it('streams token-protected series references with MIME, ranges, HEAD and missing-reference handling', async () => {
  expect((await http('/series-media/series_1/ref_1')).status).toBe(403)
  const url = `/series-media/series_1/ref_1?${t()}`
  const response = await http(url)
  expect(response).toMatchObject({ status: 200, body: '0123456789', headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' } })
  expect(await http(url, { headers: { Range: 'bytes=2-4' } })).toMatchObject({ status: 206, body: '234', headers: { 'content-range': 'bytes 2-4/10' } })
  expect(await http(url, { method: 'HEAD' })).toMatchObject({ status: 200, body: '', headers: { 'content-length': '10' } })
  expect((await http(url, { headers: { Range: 'bytes=50-60' } })).status).toBe(416)
  expect((await http(url, { headers: { Origin: 'http://evil.test' } })).status).toBe(403)
  expect((await http(url, { method: 'POST' })).status).toBe(405)
  expect((await http(`/series-media/series_2/ref_1?${t()}`)).status).toBe(404)
  expect((await http(`/series-media/series_1/ref_missing?${t()}`)).status).toBe(404)
  expect((await http(`/series-media/bad%ZZ/ref_1?${t()}`)).status).toBe(404)
})

function ws(opts: { origin?: string; token?: string } = {}) {
  return new WebSocket(`ws://127.0.0.1:${host.port}/ws?t=${opts.token ?? host.token}`, { origin: opts.origin ?? origin() })
}
const opened = (socket: WebSocket) => new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
/** Takes messages in arrival order without losing multiple messages arriving in the same batch */
function inbox(socket: WebSocket) {
  const queue: any[] = []
  const waiters: ((m: any) => void)[] = []
  socket.on('message', d => {
    const m = JSON.parse(d.toString())
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  })
  return () => new Promise<any>(r => { if (queue.length) r(queue.shift()); else waiters.push(r) })
}

describe('Pages and validation', () => {
  it('pages need no token; the URL token follows # and is not sent to the server', async () => {
    expect(host.url).toBe(`${origin()}/#t=${host.token}`)
    const res = await http('/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('<title>vis</title>')
    expect((await http('/sessions/abc')).body).toContain('<title>vis</title>')
  })

  it('serves build output by path with correct types (directory argument has a trailing slash)', async () => {
    const res = await http('/assets/index-abc.js')
    expect(res).toMatchObject({ status: 200, body: 'console.log(1)' })
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
  })

  it('rejects all Host mismatches to prevent DNS rebinding', async () => {
    const res = await http('/', { headers: { host: 'evil.example:80' } })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'forbidden', message: 'Host mismatch', data: { code: 'forbidden', reason: 'host.host_mismatch' } } })
    expect((await http(`/assets/spc/astv_1?${t()}`, { headers: { host: `localhost:${host.port}` } })).status).toBe(403)
  })

  it('static files cannot escape the directory', async () => {
    const res = await http('/%2e%2e/secret.txt')
    expect(res.body).not.toContain('outside')
  })
})

describe('Assets', () => {
  it('missing assets preserve RPC error data unchanged', async () => {
    rpcErrorData = { reason: 'asset.not_found', params: { id: 'missing' } }
    const res = await http(`/assets/spc/missing?${t()}`)
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'not_found', message: 'not_found', data: { code: 'not_found', ...rpcErrorData } } })
  })

  it('SVG asset responses isolate scripts and retain nosniff', async () => {
    assetMetadata = { kind: 'image', mime: 'image/svg+xml' }
    writeFileSync(assetFile(), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    for (const headers of [{}, { range: 'bytes=0-3' }]) {
      const res = await http(`/assets/spc/astv_1?${t()}`, { headers })
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'")
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-type']).toBe('image/svg+xml')
    }
  })

  it('rejects missing tokens; supports full and range reads', async () => {
    expect((await http('/assets/spc/astv_1')).status).toBe(403)
    const full = await http(`/assets/spc/astv_1?${t()}`)
    expect(full).toMatchObject({ status: 200, body: '0123456789' })
    expect(full.headers['content-type']).toBe('video/mp4')
    expect(full.headers['accept-ranges']).toBe('bytes')
    expect(full.headers['content-disposition']).toBeUndefined()
    const part = await http(`/assets/spc/astv_1?${t()}`, { headers: { range: 'bytes=2-5' } })
    expect(part).toMatchObject({ status: 206, body: '2345' })
    expect(part.headers['content-range']).toBe('bytes 2-5/10')
    expect((await http(`/assets/spc/astv_1?${t()}`, { headers: { range: 'bytes=20-' } })).status).toBe(416)
  })

  it('missing assets: 404', async () => {
    expect((await http(`/assets/spc/astv_x?${t()}`)).status).toBe(404)
  })

  it('downloads require tokens, preserve asset names, and provide UTF-8 attachment filenames', async () => {
    assetMetadata.displayName = "镜头 (终版)'.mp4"
    expect((await http('/assets/spc/astv_1?download=1')).status).toBe(403)
    expect((await http('/assets/spc/astv_1?download=1&t=wrong')).status).toBe(403)
    const res = await http(`/assets/spc/astv_1?${t()}&download=1`)
    expect(res).toMatchObject({ status: 200, body: '0123456789' })
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['content-disposition']).toBe("attachment; filename=\"__ (__)'.mp4\"; filename*=UTF-8''%E9%95%9C%E5%A4%B4%20%28%E7%BB%88%E7%89%88%29%27.mp4")
    expect((await http(`/assets/spc/astv_1?${t()}&download=0`)).headers['content-disposition']).toBeUndefined()
    expect((await http(`/assets/spc/astv_x?${t()}&download=1`)).status).toBe(404)
  })

  it('downloads sanitize filename paths and control characters; missing extensions are inferred from MIME', async () => {
    assetMetadata.displayName = '../目录\\镜头\r\n\u0000"\u0085'
    const res = await http(`/assets/spc/astv_1?${t()}&download=1`)
    expect(res.status).toBe(200)
    const disposition = res.headers['content-disposition'] as string
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe('_目录_镜头_____.mp4')
  })

  it.each([
    ['image', 'image/jpeg', 'jpg'],
    ['video', 'video/webm', 'webm'],
    ['image', 'application/octet-stream', 'bin'],
  ] as const)('unnamed assets: %s uses a date and the correct extension', async (kind, mime, extension) => {
    assetMetadata = { kind, mime }
    const res = await http(`/assets/spc/astv_1?${t()}&download=1`)
    const disposition = res.headers['content-disposition'] as string
    expect(disposition).toMatch(new RegExp(`^attachment; filename="${kind}-\\d{4}-\\d{2}-\\d{2}\\.${extension}"; filename\\*=UTF-8''${kind}-\\d{4}-\\d{2}-\\d{2}\\.${extension}$`))
  })

  it('downloads preserve Range and HEAD behavior', async () => {
    const path = `/assets/spc/astv_1?${t()}&download=1`
    const part = await http(path, { headers: { range: 'bytes=2-5' } })
    expect(part).toMatchObject({ status: 206, body: '2345' })
    expect(part.headers['content-range']).toBe('bytes 2-5/10')
    expect(part.headers['content-disposition']).toMatch(/^attachment;/)
    const head = await http(path, { method: 'HEAD' })
    expect(head).toMatchObject({ status: 200, body: '' })
    expect(head.headers['content-length']).toBe('10')
    expect(head.headers['content-disposition']).toBe(part.headers['content-disposition'])
    expect((await http(path, { headers: { range: 'bytes=20-' } })).status).toBe(416)
  })
})

describe.each(['filmstrip', 'poster', 'thumbnail'] as const)('%s previews', kind => {
  it('requires a token, validates Host and Origin, and only allows reads', async () => {
    const path = `/previews/spc/astv_1/${kind}`
    expect((await http(path)).status).toBe(403)
    expect((await http(`${path}?t=wrong`)).status).toBe(403)
    expect((await http(`${path}?${t()}`, { headers: { host: 'evil.example' } })).status).toBe(403)
    expect((await http(`${path}?${t()}`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await http(`${path}?${t()}`, { method: 'POST' })).status).toBe(405)
    expect(previews).toEqual([])
  })

  it('serves the cached JPEG with immutable private caching and asset security headers', async () => {
    const path = `/previews/spc/astv_1/${kind}?${t()}`
    const full = await http(path, { headers: { origin: origin() } })
    expect(full).toMatchObject({ status: 200, body: '0123456789' })
    expect(full.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'content-length': '10',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'",
    })
    expect(previews).toEqual([{ assetVersionId: 'astv_1', kind }])
    expect(await http(path, { method: 'HEAD' })).toMatchObject({ status: 200, body: '' })
  })

  it('returns a host reason for unknown versions and missing cached files', async () => {
    const missing = await http(`/previews/spc/missing/${kind}?${t()}`)
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body).error.data).toEqual({ code: 'not_found', reason: 'host.preview_not_found' })
    for (const path of [undefined, join(dir, 'missing.jpg')]) {
      previewPath = path
      const fileMissing = await http(`/previews/spc/astv_1/${kind}?${t()}`)
      expect(fileMissing.status).toBe(404)
      expect(JSON.parse(fileMissing.body).error.data.reason).toBe('host.preview_file_missing')
    }
  })

  it('preserves preview kind and tool errors from studiod', async () => {
    const path = `/previews/spc/astv_1/${kind}?${t()}`
    previewError = 'invalid_params'
    rpcErrorData = { reason: 'media.kind_mismatch' }
    const mismatch = await http(path)
    expect(mismatch.status).toBe(400)
    expect(JSON.parse(mismatch.body).error.data).toEqual({ code: 'invalid_params', reason: 'media.kind_mismatch' })
    previewError = 'unavailable'
    rpcErrorData = { reason: 'media.tool_missing' }
    const unavailable = await http(path)
    expect(unavailable.status).toBe(503)
    expect(JSON.parse(unavailable.body).error.data).toEqual({ code: 'unavailable', reason: 'media.tool_missing' })
  })
})

describe('Uploads', () => {
  it.each(['space=spc', 'name=a.png'])('missing upload parameters (%s) return translatable reasons', async query => {
    const res = await http(`/upload?${t()}&${query}`, { method: 'POST', headers: { origin: origin() } })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'invalid_params', message: 'space and name are required', data: { code: 'invalid_params', reason: 'upload.missing_fields' } } })
    expect(imported).toEqual([])
    expect(staged).toEqual([])
  })

  it('rejects Origin mismatches; successful uploads import via temporary files and delete them afterward', async () => {
    expect((await http(`/upload?${t()}&space=spc&name=a.png`, { method: 'POST', body: 'x', headers: { origin: 'http://evil.example' } })).status).toBe(403)
    const res = await http(`/upload?${t()}&space=spc&name=${encodeURIComponent('../镜头.png')}`, { method: 'POST', body: 'pixels', headers: { origin: origin() } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ assetVersionId: 'astv_2', displayName: '镜头.png' })
    expect(imported).toEqual([{ path: expect.stringMatching(/upload\.png$/), existed: true, content: 'pixels', displayName: '镜头.png' }])
    expect(existsSync(imported[0]!.path)).toBe(false)
  })

  it('exceeding the size limit: 413', async () => {
    const res = await http(`/upload?${t()}&space=spc&name=a.mp4`, { method: 'POST', body: 'x'.repeat(2000), headers: { origin: origin() } })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'invalid_params', message: 'File too large', data: { code: 'invalid_params', reason: 'upload.too_large', params: { maxBytes: 1000 } } } })
    expect(imported).toEqual([])
  })

  it('Skill uploads validate tokens and Origin without staging rejected uploads', async () => {
    const path = '/upload?kind=skill&space=spc&name=a.skill'
    for (const query of ['', '&t=wrong']) {
      expect((await http(`${path}${query}`, { method: 'POST', body: 'zip', headers: { origin: origin() } })).status).toBe(403)
    }
    for (const headers of [{}, { origin: 'http://evil.example' }]) {
      expect((await http(`${path}&${t()}`, { method: 'POST', body: 'zip', headers })).status).toBe(403)
    }
    expect(staged).toEqual([])
    expect(imported).toEqual([])
  })

  it.each(['导入.zip', '导入.skill'])('Skill upload %s stages in the specified project, returns results unchanged, and cleans temporary directories before acknowledgment', async name => {
    const res = await http(`/upload?${t()}&kind=skill&space=spc&name=${encodeURIComponent(`../${name}`)}`, { method: 'POST', body: 'zip', headers: { origin: origin() } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual(stagedResult)
    expect(staged).toEqual([{ params: { spaceId: 'spc', path: expect.stringContaining(name) }, existed: true, content: 'zip' }])
    expect(existsSync(staged[0]!.params.path)).toBe(false)
    expect(existsSync(dirname(staged[0]!.params.path))).toBe(false)
    expect(imported).toEqual([])
  })

  it.each([
    ['invalid_params', 400],
    ['not_found', 400],
    ['internal', 500],
  ])('Skill staging failure %s also cleans temporary directories before acknowledgment', async (code, status) => {
    stageError = code
    const res = await http(`/upload?${t()}&kind=skill&space=spc&name=a.zip`, { method: 'POST', body: 'zip', headers: { origin: origin() } })
    expect(res.status).toBe(status)
    expect(JSON.parse(res.body)).toEqual({ error: { code, message: code, data: { code } } })
    expect(staged).toHaveLength(1)
    expect(existsSync(dirname(staged[0]!.params.path))).toBe(false)
    expect(imported).toEqual([])
  })

  it.each([
    ['invalid_params', 400],
    ['not_found', 400],
    ['internal', 500],
  ])('Skill staging failure %s returns reason, params, and revision data unchanged over HTTP', async (code, status) => {
    stageError = code
    rpcErrorData = { reason: 'skill.name_conflict', params: { name: '分镜', count: 2 }, expectedRevision: 3, currentRevision: 4 }
    const res = await http(`/upload?${t()}&kind=skill&space=spc&name=a.zip`, { method: 'POST', body: 'zip', headers: { origin: origin() } })
    expect(res.status).toBe(status)
    expect(JSON.parse(res.body)).toEqual({ error: { code, message: code, data: { code, ...rpcErrorData } } })
    expect(existsSync(dirname(staged[0]!.params.path))).toBe(false)
  })

  it('Skill uploads share the size limit and do not stage oversized files', async () => {
    const res = await http(`/upload?${t()}&kind=skill&space=spc&name=a.zip`, { method: 'POST', body: 'x'.repeat(2000), headers: { origin: origin() } })
    expect(res.status).toBe(413)
    expect(staged).toEqual([])
    expect(imported).toEqual([])
  })
})

describe('studiod connection errors', () => {
  it('HTTP returns translatable connection errors when studiod is not running', async () => {
    rmSync(join(dir, 'run', 'studiod.token'))
    const res = await http(`/assets/spc/astv_1?${t()}`)
    expect(res.status).toBe(503)
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'unavailable', message: 'studiod is not running', data: { code: 'unavailable', reason: 'host.studiod_unavailable' } } })
  })

  it('RPC failures preserve complete ErrorData', async () => {
    rpcErrorData = { reason: 'asset.not_found', params: { id: 'missing' }, expectedRevision: 3, currentRevision: 4 }
    const link = await openStudiodLink({ socketPath, tokenPath: join(dir, 'run', 'studiod.token') })
    try {
      const error = await link.call('asset.get', { assetVersionId: 'missing' }).catch(e => e)
      expect(error).toBeInstanceOf(LinkError)
      expect(error).toMatchObject({ code: 'not_found', message: 'not_found', data: { code: 'not_found', ...rpcErrorData } })
    } finally {
      link.close()
    }
  })
})

describe('WebSocket forwarding', () => {
  it('token or Origin mismatches reject the handshake', async () => {
    await expect(opened(ws({ token: 'wrong' }))).rejects.toThrow()
    await expect(opened(ws({ origin: 'http://evil.example' }))).rejects.toThrow()
  })

  it('forwards requests and acknowledgments unchanged and pushes events to browsers; browsers cannot handshake themselves or impersonate host IDs', async () => {
    const socket = ws()
    const next = inbox(socket)
    await opened(socket)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'canvas.get', params: {} }))
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 7, result: { echo: 'canvas.get' } })

    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'events.subscribe', params: { spaceId: 'spc' } }))
    expect((await next()).id).toBe(8)
    expect(await next()).toMatchObject({ method: 'events.event', params: { seq: 1 } })

    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'runtime.hello', params: {} }))
    expect(await next()).toMatchObject({ id: 9, error: { data: { code: 'forbidden' } } })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'host:1', method: 'canvas.get' }))
    expect(await next()).toMatchObject({ id: null, error: { data: { code: 'forbidden' } } })
    socket.close()
  })

  it('studiod not running: rejects the handshake', async () => {
    await new Promise(r => fake.close(r))
    rmSync(join(dir, 'run', 'studiod.sock'), { force: true })
    await expect(opened(ws())).rejects.toThrow(/503/)
  })
})

describe('parseRange', () => {
  it.each([
    [undefined, null],
    ['bytes=0-', { start: 0, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=5-100', { start: 5, end: 9 }],
    ['bytes=9-2', 'invalid'],
    ['bytes=1-2,4-5', 'invalid'],
    ['items=0-1', 'invalid'],
  ])('%s', (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected)
  })
})


it('protects MOV download artifacts with token, Host and Origin checks and resolves only a task id', async () => {
  const url = `/exports/spc/media_1?${t()}`
  expect((await http('/exports/spc/media_1')).status).toBe(403)
  expect((await http('/exports/spc/media_1?t=wrong')).status).toBe(403)
  expect((await http(url, { headers: { Host: 'evil.test', Origin: origin() } })).status).toBe(403)
  expect((await http(url, { headers: { Origin: 'https://evil.test' } })).status).toBe(403)
  expect((await http(url, { method: 'POST' })).status).toBe(405)
  const result = await http(`${url}&path=/etc/passwd`)
  expect(result).toMatchObject({ status: 200, body: '0123456789', headers: { 'content-type': 'video/quicktime', 'content-disposition': 'attachment; filename="video.mov"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  expect(await http(url, { method: 'HEAD' })).toMatchObject({ status: 200, body: '', headers: { 'content-length': '10' } })
  expect(await http(url, { headers: { Range: 'bytes=2-4' } })).toMatchObject({ status: 206, body: '234' })
  expect((await http(`/exports/spc/missing?${t()}&path=${assetFile()}`)).status).toBe(404)
})
