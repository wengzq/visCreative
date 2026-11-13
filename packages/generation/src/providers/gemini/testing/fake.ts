import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFfmpegMedia } from '@vis/assets'
import type { ContractScenario } from '../../contract'
import type { ProviderRequest } from '../../types'
import { createGeminiProvider } from '../index'
import { GEMINI_BASE_URL, GEMINI_MODELS } from '../models'
import { createIsolatedHttpServer } from '../../../../../../scripts/testing/isolated-http'

export const SECRET = 'gemini-fixture-key/never-real'
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')
export type Scenario = ContractScenario | 'candidate-safety' | 'server' | 'malformed' | 'invalid-output'

export async function fakeGemini(scenario: Scenario = 'normal', kind: 'image' | 'video' = 'video') {
  const dir = await mkdtemp(join(tmpdir(), 'vis-gemini-'))
  const mp4 = await readFile(new URL('../../mock/fixtures/sample.mp4', import.meta.url))
  const requests: { path: string; method: string; body: Record<string, unknown>; authenticated: boolean; revision: string | undefined }[] = []
  let count = 0
  const controls = {
    status: scenario === 'lost' ? 'in_progress' : 'completed',
    pollError: '',
    cancelReply: 'cancelled',
    afterCancel: scenario === 'cancel-confirmed' ? 'cancelled' : 'in_progress',
    fileState: 'ACTIVE',
    fileStatus: 200,
    uriOutput: false,
    outputUri: `${GEMINI_BASE_URL}/files/video-result:download?alt=media`,
    createStatus: 200,
    createBody: undefined as Record<string, unknown> | undefined,
    pollBody: undefined as Record<string, unknown> | undefined,
  }
  const isolated = createIsolatedHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {}
    const path = req.url ?? ''
    const method = req.method ?? 'GET'
    const authenticated = req.headers['x-goog-api-key'] === SECRET
    requests.push({ path, method, body, authenticated, revision: req.headers['api-revision'] as string | undefined })
    const send = (value: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    if (!authenticated) { send({ error: { code: 'unauthenticated' } }, 401); return }
    if (path.startsWith('/v1beta/files/')) {
      if (path.includes(':download')) {
        res.writeHead(controls.fileStatus, {
          'Content-Type': scenario === 'wrong-mime' ? 'text/html' : 'video/mp4',
          ...(scenario === 'oversized' ? { 'Content-Length': String(256 * 1024 + 1) } : {}),
        }).end(mp4)
      } else send({ name: 'files/video-result', state: controls.fileState, expirationTime: '2026-11-06T00:00:00Z' })
      return
    }
    if (path.endsWith('/cancel')) {
      controls.status = controls.afterCancel
      send({ id: path.split('/')[3], status: controls.cancelReply })
      return
    }
    const creating = method === 'POST'
    if (creating) {
      count++
      if (scenario === 'lost') { res.destroy(); return }
      if (scenario === 'server') { send({ error: { message: SECRET } }, 503); return }
      if (scenario === 'malformed') { res.writeHead(200).end('{'); return }
      if (scenario === 'secret-error') { send({ error: { code: 'invalid_argument', message: `x-goog-api-key: ${SECRET}; Authorization: Bearer ${SECRET}` } }, 400); return }
      if (controls.createBody) { send(controls.createBody, controls.createStatus); return }
      if (scenario === 'moderation') {
        send(kind === 'image' ? { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ blocked: true }] } } : { error: { code: 'content_blocked' } }, kind === 'image' ? 200 : 400)
        return
      }
      if (kind === 'image') {
        send({ candidates: [{ finishReason: scenario === 'candidate-safety' ? 'IMAGE_SAFETY' : 'STOP', content: { parts: scenario === 'candidate-safety' ? [] : [{ inlineData: { mimeType: 'image/png', data: scenario === 'invalid-output' ? '!!!!' : PNG.toString('base64') } }] } }] })
        return
      }
      send({ id: `interaction-${count}`, status: 'in_progress', object: 'interaction', steps: [] })
      return
    }
    if (controls.pollBody) { send(controls.pollBody); return }
    send({
      id: path.split('/')[3], status: controls.status,
      ...(controls.pollError ? { errors: [{ code: controls.pollError, message: SECRET }] } : {}),
      steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', ...(controls.uriOutput ? { uri: controls.outputUri } : { data: mp4.toString('base64') }) }] }],
    })
  })
  const { server } = isolated
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = isolated.baseUrl
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://generativelanguage.googleapis.com') throw new Error('Fake Gemini transport refuses external requests')
    return fetch(`${origin}${url.pathname}${url.search}`, init)
  }
  const options = {
    id: 'gemini-fixture', label: 'Gemini fixture', baseUrl: GEMINI_BASE_URL, dataDir: dir,
    imageModels: GEMINI_MODELS.filter(model => model.kind === 'image').map(({ id, label }) => ({ id, label })),
    videoModels: [{ id: 'gemini-omni-1.1-flash', label: 'Omni' }], audioModels: [],
    getKey: async () => SECRET, fetch: fetcher, timeoutMs: 5000, maxImageBytes: 1024, maxVideoBytes: 256 * 1024,
    media: { ...createFfmpegMedia(), probe: async (path: string) => ({ kind: path.endsWith('.mp4') ? 'video' as const : 'image' as const, mime: path.endsWith('.mp4') ? 'video/mp4' : 'image/png', width: 640, height: 480 }) },
  }
  const request: ProviderRequest = { kind, model: kind === 'image' ? 'gemini-nano-banana-2.1' : 'gemini-omni-1.1-flash', operation: 'generate', prompt: 'A blue bird', inputs: [], params: {} }
  return {
    dir, controls, requests, options, request, adapter: createGeminiProvider(options), secret: SECRET, mp4,
    creates: () => count, recoversLost: false,
    output: { outputIndex: 0, ref: controls.outputUri },
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}
