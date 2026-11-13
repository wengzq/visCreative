import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFfmpegMedia } from '@vis/assets'
import type { ContractScenario } from '../../contract'
import type { ProviderRequest } from '../../types'
import { createDashScopeProvider, DASHSCOPE_REGIONS } from '../index'
import { DASHSCOPE_MODELS } from '../models'
import { createIsolatedHttpServer } from '../../../../../../scripts/testing/isolated-http'

export const SECRET = 'dashscope-fixture-key/never-real'
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
export const ALPHA_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')

export async function fakeDashScope(scenario: ContractScenario = 'normal', kind: 'image' | 'video' = 'video') {
  const dir = await mkdtemp(join(tmpdir(), 'vis-dashscope-'))
  const mp4 = await readFile(new URL('../../mock/fixtures/sample.mp4', import.meta.url))
  const tasks: { id: string; kind: 'image' | 'video' }[] = []
  const requests: { path: string; method: string | undefined; body: Record<string, unknown>; authenticated: boolean; async: boolean }[] = []
  const routedHosts: string[] = []
  const controls = {
    status: scenario === 'cancel-confirmed' || scenario === 'cancel-unconfirmed' ? 'PENDING' : scenario === 'lost' ? 'RUNNING' : 'SUCCEEDED',
    cancel: scenario === 'cancel-unconfirmed' ? 'refused' : 'confirmed',
    createStatus: 200,
    createCode: '',
    createMessage: '',
    taskCode: '',
    taskMessage: '',
    partialModeration: false,
    malformedCreate: false,
    malformedQuery: false,
    wrongTaskId: false,
    secretId: false,
    secretUrl: false,
    hideTask: false,
    outputMime: kind === 'video' ? 'video/mp4' : 'image/png',
    outputBytes: kind === 'video' ? mp4 : PNG,
    outputStatus: 200,
    queryStatus: 200,
    actualPrompt: undefined as unknown,
  }
  let origin = ''
  let calls = 0
  let outputCalls = 0
  let outputAuthenticated = false
  const isolated = createIsolatedHttpServer(async (req, res) => {
    const send = (body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url?.startsWith('/output')) {
      outputCalls++
      outputAuthenticated ||= req.headers.authorization !== undefined
      res.writeHead(controls.outputStatus, { 'Content-Type': scenario === 'wrong-mime' ? 'text/html' : controls.outputMime, ...(scenario === 'oversized' ? { 'Content-Length': String(256 * 1024 * 1024 + 1) } : {}) })
      res.end(controls.outputBytes)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
    const authenticated = req.headers.authorization === `Bearer ${SECRET}`
    requests.push({ path: req.url!, method: req.method, body, authenticated, async: req.headers['x-dashscope-async'] === 'enable' })
    if (!authenticated) { send({ code: 'InvalidApiKey' }, 401); return }
    if (req.url?.startsWith('/api/v1/services/')) {
      calls++
      if (scenario === 'moderation') { send({ code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, 400); return }
      if (scenario === 'secret-error') { send({ code: 'InvalidParameter', message: `Authorization: Bearer ${SECRET}; key=${encodeURIComponent(SECRET)}` }, 400); return }
      if (controls.createCode || controls.createStatus !== 200) {
        send({ code: controls.createCode, message: controls.createMessage }, controls.createStatus)
        return
      }
      const task = { id: `task-${tasks.length + 1}`, kind: req.url.includes('image-generation') ? 'image' as const : 'video' as const }
      tasks.push(task)
      if (scenario === 'lost') { res.destroy(); return }
      if (controls.malformedCreate) { res.writeHead(200); res.end('{'); return }
      send({ output: { task_id: controls.secretId ? SECRET : task.id, task_status: 'PENDING' }, request_id: 'create-request' })
      return
    }
    const id = req.url?.split('/')[4]
    const task = tasks.find(task => task.id === id)
    if (req.method === 'POST' && req.url?.endsWith('/cancel')) {
      if (controls.status !== 'PENDING' || controls.cancel === 'refused') { send({ code: 'UnsupportedOperation' }, 400); return }
      if (controls.cancel === 'race') { controls.status = 'RUNNING'; send({ code: 'UnsupportedOperation' }, 400); return }
      if (controls.cancel === 'unconfirmed') { send({ request_id: 'only-acknowledged' }); return }
      controls.status = 'CANCELED'
      send('45ac7f13-aaaa-bbbb-cccc-e03c35068d83')
      return
    }
    if (controls.queryStatus !== 200) { send({ code: 'InternalError', message: SECRET }, controls.queryStatus); return }
    if (controls.malformedQuery) { send({ output: {} }); return }
    const url = controls.secretUrl ? `${origin}/output?key=${encodeURIComponent(SECRET)}` : `${origin}/output`
    send({ output: {
      task_id: controls.wrongTaskId ? 'unrelated-task' : id,
      task_status: !task || controls.hideTask ? 'UNKNOWN' : controls.status,
      ...(controls.taskCode ? { code: controls.taskCode, message: controls.taskMessage } : {}),
      ...(task?.kind === 'video' ? { video_url: url } : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'image', image: url }] } }] }),
      ...(controls.actualPrompt !== undefined ? { actual_prompt: controls.actualPrompt } : {}),
      ...(controls.partialModeration ? { results: [{ url }, { code: 'DataInspectionFailed', message: 'Output data may contain inappropriate content.' }] } : {}),
    } })
  })
  const { server } = isolated
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = isolated.baseUrl
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    if (DASHSCOPE_REGIONS.some(region => new URL(region.baseUrl).origin === url.origin)) {
      routedHosts.push(url.origin)
      return fetch(`${origin}${url.pathname}${url.search}`, init)
    }
    if (url.origin === new URL(origin).origin) return fetch(input, init)
    throw new Error('Fake DashScope transport refuses external requests')
  }
  const options = {
    id: 'dashscope-fixture', label: 'DashScope fixture', baseUrl: DASHSCOPE_REGIONS[0].baseUrl, dataDir: dir,
    imageModels: DASHSCOPE_MODELS.filter(model => model.kind === 'image').map(({ id }) => ({ id, label: id })),
    videoModels: DASHSCOPE_MODELS.filter(model => model.kind === 'video').map(({ id }) => ({ id, label: id })),
    audioModels: [], getKey: async () => SECRET, fetch: fetcher, timeoutMs: 2000,
    media: { ...createFfmpegMedia(), probe: async (path: string) => path.endsWith('.mp4') ? { kind: 'video' as const, mime: 'video/mp4', width: 512, height: 512, durationMs: 1000, fps: 24 } : { kind: 'image' as const, mime: 'image/png', width: 512, height: 512 } },
  }
  const request: ProviderRequest = { operation: 'generate', kind, model: kind === 'image' ? 'wan2.7-image-pro' : 'wan2.7-t2v', prompt: 'A tree in the sun', params: {}, inputs: [] }
  return {
    dir, controls, requests, routedHosts, tasks, options, request, adapter: createDashScopeProvider(options), secret: SECRET,
    creates: () => tasks.length, createCalls: () => calls, recoversLost: false,
    output: { outputIndex: 0, ref: `${origin}/output` }, outputCalls: () => outputCalls, outputAuthenticated: () => outputAuthenticated,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}
