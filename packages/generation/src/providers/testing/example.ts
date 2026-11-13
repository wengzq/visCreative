import { z } from 'zod'
import { boundedBody } from '../download'
import type { ProviderType } from '../registry'
import { ProviderError, type ProviderAdapter } from '../types'
import { createIsolatedHttpServer } from '../../../../../scripts/testing/isolated-http'

export const EXAMPLE_SECRET = 'fake-example-key-contract'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')
type Scenario = 'normal' | 'lost' | 'cancel-confirmed' | 'cancel-unconfirmed' | 'wrong-mime' | 'oversized' | 'moderation' | 'secret-error'

/** Only tests import this fixture; registering it is the entire integration seam. */
export async function exampleService(scenario: Scenario = 'normal') {
  const tasks = new Map<string, string>()
  let creates = 0
  let cancelled = false
  let authenticated = 0
  let origin = ''
  const isolated = createIsolatedHttpServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    const send = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (path.endsWith('/output')) {
      res.writeHead(200, { 'Content-Type': scenario === 'wrong-mime' ? 'text/html' : 'image/png', ...(scenario === 'oversized' ? { 'Content-Length': '2048' } : {}) })
      res.end(PNG)
      return
    }
    if (req.headers.authorization !== `Bearer ${EXAMPLE_SECRET}`) { send({ error: 'Unauthorized' }, 401); return }
    authenticated++
    if (req.method === 'POST') {
      for await (const _chunk of req) { /* Drain the request before simulating acceptance. */ }
      if (scenario === 'moderation') { send({ error: 'moderation' }, 400); return }
      if (scenario === 'secret-error') { send({ error: `Authorization: Bearer ${EXAMPLE_SECRET}` }, 400); return }
      const key = String(req.headers['idempotency-key'])
      if (!tasks.has(key)) { tasks.set(key, `example-task-${++creates}`) }
      if (scenario === 'lost') res.destroy()
      else send({ id: tasks.get(key) })
    } else if (path.includes('/lookup/')) {
      send({ id: tasks.get(decodeURIComponent(path.split('/lookup/')[1]!)) ?? null })
    } else if (req.method === 'DELETE') {
      cancelled = scenario === 'cancel-confirmed'
      send({ cancelled })
    } else send({ state: cancelled ? 'cancelled' : scenario === 'lost' || scenario.startsWith('cancel-') ? 'pending' : 'succeeded', url: `${origin}/output` })
  })
  const { server } = isolated
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = isolated.baseUrl
  const type: ProviderType = {
    type: 'example', label: { zh: '示例服务', en: 'Example' }, needsKey: true, kinds: ['image'],
    regions: [
      { id: 'east', label: { zh: '东区', en: 'East' }, baseUrl: `${origin}/east` },
      { id: 'west', label: { zh: '西区', en: 'West' }, baseUrl: `${origin}/west` },
    ],
    allowCustomBaseUrl: false, verified: false,
    knownModels: [{ id: 'example-image', label: 'Example Image', kind: 'image' }, { id: 'example-fast', label: 'Example Fast', kind: 'image' }],
    settingsSchema: z.strictObject({ project: z.string().min(1).default('demo').meta({ title: 'Project', description: 'Example project name' }) }),
    settingsFields: { project: { label: { zh: '项目', en: 'Project' }, description: { zh: '示例项目名称', en: 'Example project name' } } },
    help: { consoleUrl: 'https://example.invalid/console', key: { zh: '仅用于本地测试的示例密钥。', en: 'A fake key for local tests only.' }, model: { zh: '选择已知模型或输入自定义模型 ID。', en: 'Choose a known model or enter a custom model id.' } },
    create(config, deps): ProviderAdapter {
      async function api(path: string, method = 'GET', key?: string) {
        let response: Response
        try {
          response = await fetch(`${config.baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${await deps.getKey()}`, ...(key ? { 'Idempotency-Key': key } : {}) } })
        } catch { throw new ProviderError(method === 'POST' ? 'timeout' : 'transient', 'Example request result is unknown') }
        if (!response.ok) {
          const result = await response.json() as { error: string }
          throw new ProviderError('rejected', 'Example request rejected', result.error === 'moderation' ? 'generation.moderation_rejected' : undefined)
        }
        return await response.json() as { id: string | null; state: 'pending' | 'succeeded' | 'cancelled'; url: string; cancelled: boolean }
      }
      return {
        id: config.id, type: 'example', kinds: ['image'], models: config.imageModels.map(model => model.id),
        defaultModels: config.imageModels[0] ? { image: config.imageModels[0].id } : {}, paramsSchema: z.object({}),
        async submit(_request, options) {
          const result = await api('/tasks', 'POST', options.idempotencyKey)
          if (!result.id) throw new ProviderError('timeout', 'Example response has no task id')
          return { externalTaskId: result.id }
        },
        async findTaskByIdempotencyKey(key) {
          const result = await api(`/lookup/${encodeURIComponent(key)}`)
          return result.id ? { externalTaskId: result.id } : null
        },
        async getTask(id) {
          const result = await api(`/tasks/${encodeURIComponent(id)}`)
          return result.state === 'succeeded' ? { state: 'succeeded', outputs: [{ outputIndex: 0, ref: result.url }] } : { state: result.state }
        },
        async cancel(id) { return { cancelled: (await api(`/tasks/${encodeURIComponent(id)}`, 'DELETE')).cancelled } },
        async download(output) {
          const response = await fetch(output.ref)
          if (response.headers.get('content-type') !== 'image/png') throw new ProviderError('rejected', 'Example output MIME type is invalid')
          return { data: await boundedBody(response, 1024), mime: 'image/png', width: 1, height: 1 }
        },
      }
    },
  }
  return {
    type, origin, creates: () => creates, authenticated: () => authenticated,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
