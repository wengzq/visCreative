import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFfmpegMedia } from '@vis/assets'
import type { ContractScenario } from '../../contract'
import type { ProviderRequest } from '../../types'
import { createMiniMaxProvider, MINIMAX_REGIONS } from '../index'
import { MINIMAX_MODELS } from '../models'
import { createIsolatedHttpServer } from '../../../../../../scripts/testing/isolated-http'

export const SECRET = 'minimax-fixture-key/never-real'
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')
export async function fakeMiniMax(scenario: ContractScenario = 'normal', kind: 'image' | 'video' = 'video') {
  const dir = await mkdtemp(join(tmpdir(), 'vis-minimax-'))
  const mp4 = await readFile(new URL('../../mock/fixtures/sample.mp4', import.meta.url))
  const requests: { path: string; method: string | undefined; body: Record<string, unknown>; authenticated: boolean; origin?: string }[] = []
  const hosts: string[] = []
  let count = 0
  let outputCalls = 0
  let outputAuthenticated = false
  let origin = ''
  const controls = {
    status: 'succeeded', code: 0, httpStatus: 200, errorMessage: 'Fake request error',
    malformed: false, truncated: false, secretId: false, wrongId: false, missing: false,
    invalidImage: false, outputModeration: false, secretUrl: false,
    expired: 0, queryCount: 0, outputMime: 'video/mp4', outputBytes: mp4,
    createOverride: undefined as { status: number; body: string } | undefined,
  }
  const isolated = createIsolatedHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
    const authenticated = req.headers.authorization === `Bearer ${SECRET}`
    requests.push({ path: req.url!, method: req.method, body, authenticated })
    const send = (body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (req.url?.startsWith('/output')) {
      outputCalls++
      outputAuthenticated ||= req.headers.authorization !== undefined
      if (controls.expired > 0) { controls.expired--; res.writeHead(403).end(); return }
      res.writeHead(200, { 'Content-Type': scenario === 'wrong-mime' ? 'text/html' : controls.outputMime, ...(scenario === 'oversized' ? { 'Content-Length': String(4097) } : {}) }).end(controls.outputBytes)
      return
    }
    if (!authenticated) { send({ error: { type: 'authorized_error' } }, 401); return }
    if (req.method === 'POST') {
      count++
      if (scenario === 'lost') { res.destroy(); return }
      if (controls.truncated) { res.writeHead(200, { 'Content-Length': 200 }); res.flushHeaders(); res.write('{'); setImmediate(() => res.destroy()); return }
      if (controls.malformed) { res.writeHead(200).end('{'); return }
      if (controls.createOverride) { res.writeHead(controls.createOverride.status, { 'Content-Type': 'application/json' }).end(controls.createOverride.body); return }
      const code = scenario === 'moderation' ? 1026 : scenario === 'secret-error' ? 2013 : controls.code
      if (code || controls.httpStatus !== 200) {
        const message = scenario === 'secret-error' ? `Authorization: Bearer ${SECRET}; key=${encodeURIComponent(SECRET)}` : controls.errorMessage
        send(req.url === '/v1/image_generation' ? { base_resp: { status_code: code, status_msg: message } } : { type: 'error', error: { type: 'bad_request_error', message: `${message} (${code})` } }, controls.httpStatus === 200 && req.url === '/v2/video_generation' ? 400 : controls.httpStatus)
        return
      }
      if (req.url === '/v1/image_generation') {
        send({ base_resp: { status_code: 0 }, data: { image_base64: Array.from({ length: Number(body.n ?? 1) }, () => controls.invalidImage ? '!!!!' : PNG.toString('base64')) }, metadata: { failed_count: controls.outputModeration ? 1 : 0 } })
        return
      }
      if (req.url !== '/v2/video_generation') { send({}, 404); return }
      send({ task_id: controls.secretId ? SECRET : `task-${count}` })
      return
    }
    if (req.method !== 'GET' || !req.url?.startsWith('/v2/query/video_generation/')) { send({}, 404); return }
    controls.queryCount++
    if (controls.missing) { send({}, 404); return }
    const id = req.url.split('/').at(-1)
    send({ task: { id: controls.wrongId ? 'another-task' : id, status: controls.status, model: 'MiniMax-H3', content: { url: controls.secretUrl ? `${origin}/output?key=${encodeURIComponent(SECRET)}` : `${origin}/output?revision=${controls.queryCount}` }, error: { code: String(controls.code), message: controls.errorMessage }, task_type: 'generation', modality: 'video' } })
  })
  const { server } = isolated
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = isolated.baseUrl
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    if (MINIMAX_REGIONS.some(region => region.baseUrl === url.origin)) {
      hosts.push(url.origin)
      return fetch(`${origin}${url.pathname}${url.search}`, init)
    }
    if (url.origin === new URL(origin).origin) return fetch(input, init)
    throw new Error('Fake MiniMax transport refuses external requests')
  }
  const options = {
    id: 'minimax-fixture', label: 'MiniMax fixture', baseUrl: MINIMAX_REGIONS[0].baseUrl, dataDir: dir,
    imageModels: [{ id: 'image-01', label: 'Image' }], videoModels: MINIMAX_MODELS.filter(model => model.kind === 'video').map(({ id, label }) => ({ id, label })), audioModels: [],
    getKey: async () => SECRET, fetch: fetcher, timeoutMs: 2000, maxOutputBytes: 4096,
    media: { ...createFfmpegMedia(), probe: async (path: string) => ({ kind: path.endsWith('.mp4') ? 'video' as const : 'image' as const, mime: path.endsWith('.mp4') ? 'video/mp4' : 'image/png', width: 512, height: 512 }) },
  }
  const request: ProviderRequest = { operation: 'generate', kind, model: kind === 'image' ? 'image-01' : 'MiniMax-H3', prompt: 'A tree in the sun', params: {}, inputs: [] }
  return {
    dir, options, request, controls, requests, hosts, secret: SECRET, recoversLost: false,
    adapter: createMiniMaxProvider(options), creates: () => count, outputCalls: () => outputCalls, outputAuthenticated: () => outputAuthenticated,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) },
  }
}
