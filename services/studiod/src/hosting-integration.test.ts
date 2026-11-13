import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFfmpegMedia } from '@vis/assets'
import { createMockProvider, createArkProvider, ProviderError, type ProviderAdapter } from '@vis/generation'
import { afterEach, expect, it } from 'vitest'
import { createHostingManager } from './hosting'
import { createMemorySecretStore } from './secret-store'
import { createProviderManager } from './providers'
import { createIsolatedHttpServer } from '../../../scripts/testing/isolated-http'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup(builtins = [createMockProvider()]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vis-hosting-integration-'))
  dirs.push(dataDir)
  const hosting = createHostingManager({ dataDir, secrets: createMemorySecretStore() })
  const manager = createProviderManager({ dataDir, hosting, builtins, defaults: {}, secrets: createMemorySecretStore(), media: createFfmpegMedia(), onChange() {} })
  return { hosting, manager, dataDir }
}
const metadata = [{ kind: 'video' as const, mime: 'video/mp4', durationMs: 3000, width: 1280, height: 720, fps: 30, bytes: 1000 }]
const ark = { id: 'ark', type: 'volcengine-ark', label: 'Ark', baseUrl: 'http://127.0.0.1:1/api/v3', imageModels: [{ id: 'doubao-seedream-5-0', label: 'Image' }], audioModels: [], videoModels: [{ id: 'doubao-seedance-2-0-mini-260615', label: '2.0' }, { id: 'doubao-seedance-2-5-260628', label: '2.5' }] }

it('makes hosting available to an Ark adapter created before the author configures it', async () => {
  const { hosting, manager } = setup()
  await manager.update({ providers: [ark], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } })
  const before = manager.adapters().find(adapter => adapter.id === 'ark')!
  expect(() => before.validateInputs!('video', ark.videoModels[0]!.id, metadata, {}, 'generate')).toThrow(ProviderError)
  await hosting.update({ type: 'tos', region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: 'testAK', prefix: 'refs/' })
  await hosting.setSecret('testSK')
  expect(() => before.validateInputs!('video', ark.videoModels[0]!.id, metadata, {}, 'generate')).not.toThrow()
  const rebuilt = manager.adapters().find(adapter => adapter.id === 'ark')!
  manager.refreshHosting()
  expect(rebuilt).toBe(before)
  expect(manager.adapters().find(adapter => adapter.id === 'ark')).toBe(before)
  expect(() => rebuilt.validateInputs!('video', ark.videoModels[0]!.id, metadata, {}, 'generate')).not.toThrow()
  await hosting.clearSecret()
  expect(() => rebuilt.validateInputs!('video', ark.videoModels[0]!.id, metadata, {}, 'generate')).toThrow(ProviderError)
})

it('publishes adapter-declared Seedance, mock video and audio, and image-only reference limits', async () => {
  const { manager } = setup()
  await manager.update({ providers: [ark], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } })
  const catalog = await manager.list()
  const models = catalog.providers.find(provider => provider.id === 'ark')!.models
  expect(models.find(model => model.label === '2.0')!.referenceInputs).toEqual({ image: 9, video: { max: 3, minMs: 2000, maxMs: 15000, totalMs: 15000, requiresHosting: true }, audio: { max: 3, minMs: 2000, maxMs: 15000, totalMs: 15000 } })
  expect(models.find(model => model.label === '2.5')!.referenceInputs).toEqual({ image: 30, video: { max: 10, minMs: 2000, maxMs: 30000, totalMs: 30000, requiresHosting: true }, audio: { max: 10, minMs: 2000, maxMs: 30000, totalMs: 30000 }, total: 50 })
  expect(models.find(model => model.label === 'Image')!.referenceInputs).toEqual({ image: 10 })
  const mock = catalog.providers.find(provider => provider.id === 'mock')!.models.find(model => model.id === 'mock-video-1')!
  expect(mock.referenceInputs?.video).toEqual({ max: 3, minMs: 1, maxMs: 30000, totalMs: 30000 })
  expect(mock.referenceInputs?.audio).toEqual({ max: 3, minMs: 1, maxMs: 30000, totalMs: 30000 })
  expect(mock.referenceInputs?.video).not.toHaveProperty('requiresHosting')
})


it('falls back to a legacy image limit and prefers a model-specific declaration', async () => {
  const legacy: ProviderAdapter = { ...createMockProvider(), referenceImageLimitFor: () => 0 }
  delete legacy.referenceLimitsFor
  const { manager } = setup([legacy])
  for (const model of (await manager.list()).providers[0]!.models) expect(model.referenceInputs).toEqual({ image: 0 })
  legacy.referenceLimitsFor = () => ({ image: 7 })
  legacy.referenceImageLimitFor = () => { throw new Error('The declared limits must not consult the legacy hook') }
  for (const model of (await manager.list()).providers[0]!.models) expect(model.referenceInputs).toEqual({ image: 7 })
})


it('redacts an earlier access key and all TOS host forms from an Ark failure after an AK change and restart', async () => {
  const { dataDir, hosting } = setup()
  const oldId = 'AKLT' + 'OldExample_1-2'
  const urls = [
    'https://tos-cn-beijing.volces.com/bucket/clip.mp4?X-Tos-Signature=old-signature',
    'https://bucket.tos-cn-beijing.ivolces.com/clip.mp4?X-Tos-Credential=old-credential',
  ]
  const config = { type: 'tos' as const, region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: oldId, prefix: 'refs/' }
  await hosting.update(config)
  await hosting.setSecret('testSK')
  await hosting.update({ ...config, accessKeyId: 'currentAK' })
  const restarted = createHostingManager({ dataDir, secrets: createMemorySecretStore() })
  let echo = oldId
  const isolated = createIsolatedHttpServer((_req, response) => response.end(JSON.stringify({ status: 'failed', error: { code: 'InvalidAccessKey', message: echo } })))
  const { server } = isolated
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const provider = createArkProvider({ id: 'ark', dataDir, baseUrl: isolated.baseUrl, getKey: async () => 'provider-key', imageModels: [], videoModels: [{ id: 'doubao-seedance-2-0-mini-260615', label: 'Video' }], audioModels: [], hosted: restarted.inputs })
    for (const message of [oldId, ...urls]) {
      echo = message
      const state = await provider.getTask('earlier-task')
      expect(state).toMatchObject({ state: 'failed', error: { code: 'InvalidAccessKey' } })
      const result = JSON.stringify(state)
      for (const forbidden of [oldId, 'old-signature', 'old-credential', 'tos-cn-beijing']) expect(result.includes(forbidden)).toBe(false)
      const direct = restarted.inputs.redact(message)
      for (const forbidden of [oldId, 'old-signature', 'old-credential', 'tos-cn-beijing']) expect(direct.includes(forbidden)).toBe(false)
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
