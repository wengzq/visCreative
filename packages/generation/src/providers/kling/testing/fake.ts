import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFfmpegMedia } from '@vis/assets'
import type { ContractScenario } from '../../contract'
import type { ProviderRequest } from '../../types'
import { createKlingProvider, KLING_REGIONS } from '../index'

export const SECRET = 'kling-fixture-key/never-real'
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')
type Task = { id: string; external: string; kind: 'image' | 'video' }

export async function fakeKling(scenario: ContractScenario = 'normal', kind: 'image' | 'video' = 'video') {
  const dir = await mkdtemp(join(tmpdir(), 'vis-kling-'))
  const tasks: Task[] = []
  const requests: { path: string; method: string | undefined; body: Record<string, unknown>; authenticated: boolean }[] = []
  const controls = {
    status: scenario === 'lost' ? 'processing' : 'succeeded',
    message: '',
    createError: 0,
    acceptOnError: false,
    httpStatus: 400,
    duplicateMessage: 'external_task_id already exists',
    malformedCreate: false,
    queryError: '' as '' | 'image' | 'video',
    queryErrorCode: 5000,
    dropQuery: '' as '' | 'image' | 'video',
    malformedQuery: '' as '' | 'image' | 'video',
    videoTaskShape: 'array' as 'array' | 'object',
    wrongTaskId: false,
    hideTasks: false,
    secretId: false,
    secretUrl: false,
    outputMime: 'image/png',
    outputBytes: PNG as Buffer,
  }
  let origin = ''
  let outputAuthenticated = false
  let createCalls = 0
  let outputCalls = 0
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const send = (data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/output') {
      outputCalls++
      outputAuthenticated ||= req.headers.authorization !== undefined
      res.writeHead(200, { 'Content-Type': scenario === 'wrong-mime' ? 'text/html' : controls.outputMime, ...(scenario === 'oversized' ? { 'Content-Length': String(256 * 1024 * 1024 + 1) } : {}) })
      res.end(controls.outputBytes)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {}
    const authenticated = req.headers.authorization === `Bearer ${SECRET}`
    requests.push({ path: req.url!, method: req.method, body, authenticated })
    if (!authenticated) { send({ code: 1002 }, 401); return }
    if (req.method === 'POST') {
      createCalls++
      if (scenario === 'moderation') { send({ code: 1301, message: 'Content security policy' }, 400); return }
      if (scenario === 'secret-error') { send({ code: 1201, message: `Authorization: Bearer ${SECRET}` }, 400); return }
      if (controls.createError && !controls.acceptOnError) { send({ code: controls.createError, message: controls.message }, controls.httpStatus); return }
      const taskKind = url.pathname === '/v1/images/omni-image' ? 'image' : 'video'
      const external = String(taskKind === 'image' ? body.external_task_id : (body.options as Record<string, unknown>).external_task_id)
      if (tasks.some(task => task.external === external)) { send({ code: 1201, message: controls.duplicateMessage }, 400); return }
      const task = { id: `task-${tasks.length + 1}`, external, kind: taskKind } as Task
      tasks.push(task)
      if (controls.createError) { send({ code: controls.createError, message: controls.message }, controls.httpStatus); return }
      if (scenario === 'lost') { res.destroy(); return }
      if (controls.malformedCreate) { res.writeHead(200); res.end('{'); return }
      const id = controls.secretId ? SECRET : task.id
      send({ code: 0, data: taskKind === 'image' ? { task_id: id, task_status: 'submit' } : { id, status: 'submitted' } })
      return
    }
    const queryKind = url.pathname === '/tasks' ? 'video' : 'image'
    if (controls.dropQuery === queryKind) { res.destroy(); return }
    if (controls.queryError === queryKind) { send({ code: controls.queryErrorCode }, controls.queryErrorCode === 1103 ? 403 : 500); return }
    if (controls.malformedQuery === queryKind) { send({ code: 0, data: {} }); return }
    const key = queryKind === 'video' ? url.searchParams.get('task_ids') ?? url.searchParams.get('external_task_ids') : url.pathname.split('/').at(-1)
    const task = controls.hideTasks ? undefined : tasks.find(task => task.kind === queryKind && (task.id === key || task.external === key))
    if (!task) { send(queryKind === 'video' ? { code: 0, data: [] } : { code: 1203, message: 'Task does not exist' }, queryKind === 'video' ? 200 : 404); return }
    const output = controls.secretUrl ? `${origin}/output?key=${encodeURIComponent(SECRET)}` : `${origin}/output`
    const id = controls.wrongTaskId ? 'unrelated-task' : task.id
    const video = { id, external_id: task.external, status: controls.status, message: controls.message, outputs: [{ type: 'video', url: output }, { type: 'audio', mp3_url: output }] }
    send({ code: 0, data: queryKind === 'image' ? {
      task_id: id, task_status: controls.status, task_status_msg: controls.message,
      task_info: { external_task_id: task.external }, task_result: { images: [{ url: output }, { url: output }] },
    } : controls.videoTaskShape === 'object' ? video : [video] })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake Kling server did not start')
  origin = `http://127.0.0.1:${address.port}`
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    if (KLING_REGIONS.some(region => region.baseUrl === url.origin)) return fetch(`${origin}${url.pathname}${url.search}`, init)
    if (url.origin === origin) return fetch(input, init)
    throw new Error('Fake Kling transport refuses external requests')
  }
  const options = {
    id: 'kling-fixture', label: 'Kling fixture', baseUrl: KLING_REGIONS[0].baseUrl, dataDir: dir,
    imageModels: [{ id: 'kling-v3-omni', label: 'Image' }],
    videoModels: ['kling-3.0', 'kling-3.0-omni', 'kling-4.0'].map(id => ({ id, label: id })),
    audioModels: [], getKey: async () => SECRET, fetch: fetcher, timeoutMs: 2000,
    media: { ...createFfmpegMedia(), probe: async () => ({ kind: 'image' as const, mime: 'image/png', width: 512, height: 512 }) },
  }
  const request: ProviderRequest = { operation: 'generate', kind, model: kind === 'image' ? 'kling-v3-omni' : 'kling-3.0', prompt: 'A tree in the sun', params: {}, inputs: [] }
  return {
    dir, controls, requests, tasks, options, request, adapter: createKlingProvider(options), secret: SECRET,
    creates: () => tasks.length, createCalls: () => createCalls, recoversLost: true,
    output: { outputIndex: 0, ref: `${origin}/output` }, outputAuthenticated: () => outputAuthenticated, outputCalls: () => outputCalls,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}
