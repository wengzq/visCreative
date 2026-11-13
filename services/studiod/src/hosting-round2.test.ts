import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFfmpegMedia } from '@vis/assets'
import { createMockProvider, builtinProviderTypes } from '@vis/generation'
import { afterEach, expect, it, vi } from 'vitest'
import { createHostingManager } from './hosting'
import { createMemorySecretStore } from './secret-store'
import { createProviderManager } from './providers'
import * as files from './hosting-config'

const config = { type: 'tos' as const, region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: 'testAK', prefix: 'refs/' }
const directories: string[] = []
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'vis-hosting-round2-'))
  directories.push(dataDir)
  const secrets = createMemorySecretStore()
  let now = 100000
  const hosting = createHostingManager({ dataDir, secrets, now: () => new Date(now) })
  return { dataDir, secrets, hosting, advance(ms: number) { now += ms } }
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('clears the secret and reconciles readiness when the subsequent configuration write fails', async () => {
  const { dataDir, hosting, secrets } = setup()
  await hosting.update(config)
  await hosting.setSecret('testSK')
  vi.spyOn(files, 'saveHostingConfig').mockImplementationOnce(() => { throw new Error('Private file diagnostic') })
  await expect(hosting.update({ ...config, accessKeyId: 'nextAK' })).rejects.toMatchObject({ details: { reason: 'hosting.store_failed' } })
  expect(await secrets.get('tos')).toBeUndefined()
  expect(files.loadHostingConfig(dataDir)).toEqual(config)
  expect(hosting.inputs.configured).toBe(false)
})

it('returns success with unknown readiness when the post-write presence check fails once', async () => {
  const { hosting, secrets, advance } = setup()
  await hosting.update(config)
  const has = vi.spyOn(secrets, 'has').mockRejectedValueOnce(new Error('Private credential diagnostic'))
  await expect(hosting.setSecret('testSK')).resolves.toEqual({ hasSecret: false })
  expect(await secrets.get('tos')).toBe('testSK')
  expect((await hosting.get()).hasSecret).toBe(false)
  expect(await hosting.ready()).toBe(false)
  expect(has).toHaveBeenCalledTimes(1)
  advance(30000)
  expect(await hosting.ready()).toBe(true)
  expect(has).toHaveBeenCalledTimes(2)
})

it.each(['changed', 'orphan'])('keeps the configuration intact after a failed %s secret deletion and clears it on retry', async mode => {
  const { dataDir, hosting, secrets } = setup()
  if (mode === 'changed') {
    await hosting.update(config)
    await hosting.setSecret('testSK')
  } else {
    await secrets.set('tos', 'testSK')
    await hosting.get()
  }
  const before = await hosting.get()
  const next = { ...config, accessKeyId: 'nextAK' }
  vi.spyOn(secrets, 'delete').mockRejectedValueOnce(new Error('Private deletion failure'))
  await expect(hosting.update(next)).rejects.toMatchObject({ details: { reason: 'hosting.store_failed' } })
  expect(files.loadHostingConfig(dataDir)).toEqual(before.config)
  expect(await hosting.get()).toEqual(before)
  expect(await secrets.get('tos')).toBe('testSK')
  await expect(hosting.update(next)).resolves.toEqual({ config: next, hasSecret: false })
  expect(await secrets.has('tos')).toBe(false)
})

it('requires a valid saved configuration before accepting a hosting secret', async () => {
  const { hosting, secrets } = setup()
  const set = vi.spyOn(secrets, 'set')
  await expect(hosting.setSecret('testSK')).rejects.toMatchObject({ details: { reason: 'hosting.not_configured' } })
  expect(set).not.toHaveBeenCalled()
})

it('caches hosting configuration across catalog, readiness and redaction reads until a mutation', async () => {
  const { dataDir, hosting } = setup()
  await hosting.update(config)
  await hosting.setSecret('testSK')
  const load = vi.spyOn(files, 'loadHostingConfig')
  const manager = createProviderManager({ dataDir, hosting, builtins: [createMockProvider()], defaults: {}, secrets: createMemorySecretStore(), media: createFfmpegMedia(), onChange() {} })
  for (let index = 0; index < 4; index++) {
    expect((await manager.list()).videoReferences).toBe('ready')
    expect(await hosting.ready()).toBe(true)
    expect((await hosting.get()).config).toEqual(config)
    expect(hosting.inputs.redact('vendor testAK')).not.toContain('testAK')
    expect(hosting.inputs.configured).toBe(true)
  }
  expect(load).not.toHaveBeenCalled()
  await hosting.update({ ...config, accessKeyId: 'nextAK' })
  expect(load).toHaveBeenCalledTimes(1)
  expect((await hosting.get()).config?.accessKeyId).toBe('nextAK')
  expect(hosting.inputs.redact('vendor nextAK')).not.toContain('nextAK')
})

it.each(['missing', 'invalid'])('clears an orphan secret when saving over %s prior configuration', async mode => {
  const { dataDir, hosting, secrets } = setup()
  if (mode === 'invalid') writeFileSync(join(dataDir, 'hosting.json'), '{')
  await secrets.set('tos', 'orphan-secret')
  const result = await hosting.update(config)
  expect(result.hasSecret).toBe(false)
  expect(await secrets.has('tos')).toBe(false)
})

it('discovers an orphan secret for the settings warning without a valid configuration', async () => {
  const { hosting, secrets } = setup()
  await secrets.set('tos', 'orphan-secret')
  await hosting.initialize()
  expect(await hosting.get()).toEqual({ config: null, hasSecret: true })
})

it('retries unknown startup readiness at most once per 30 seconds until a check succeeds', async () => {
  const { dataDir, secrets } = setup()
  files.saveHostingConfig(dataDir, config)
  await secrets.set('tos', 'testSK')
  let now = 100000
  const hosting = createHostingManager({ dataDir, secrets, now: () => new Date(now) })
  const has = vi.spyOn(secrets, 'has').mockRejectedValueOnce(new Error('Locked store')).mockRejectedValueOnce(new Error('Still locked'))
  await hosting.initialize()
  expect(await hosting.ready()).toBe(false)
  expect((await hosting.get()).hasSecret).toBe(false)
  expect(has).toHaveBeenCalledTimes(1)
  now += 30000
  await Promise.all([hosting.get(), hosting.ready(), hosting.get()])
  expect(has).toHaveBeenCalledTimes(2)
  now += 29999
  expect(await hosting.ready()).toBe(false)
  expect(has).toHaveBeenCalledTimes(2)
  now++
  expect(await hosting.ready()).toBe(true)
  expect(has).toHaveBeenCalledTimes(3)
  now += 60000
  expect((await hosting.get()).hasSecret).toBe(true)
  expect(has).toHaveBeenCalledTimes(3)
})

it('keeps successful readiness cached after external deletion but reports an upload failure', async () => {
  const { hosting, secrets } = setup()
  await hosting.update(config)
  await hosting.setSecret('testSK')
  const has = vi.spyOn(secrets, 'has')
  await secrets.delete('tos')
  expect(await hosting.ready()).toBe(true)
  expect((await hosting.get()).hasSecret).toBe(true)
  expect(has).not.toHaveBeenCalled()
  await expect(hosting.inputs.url({ path: '/not-read.mp4', mime: 'video/mp4', key: 'missing:0' }, 60)).rejects.toMatchObject({ details: { reason: 'hosting.upload_failed' } })
})

it('rejects an excessive lifetime as an internal programming error before credentials or upload', async () => {
  const { hosting, secrets } = setup()
  const get = vi.spyOn(secrets, 'get')
  const error = await hosting.inputs.url({ path: '/not-read.mp4', mime: 'video/mp4', key: 'ttl:0' }, 604801).catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toHaveProperty('details')
  expect(get).not.toHaveBeenCalled()
})

it('provides a redact-only unavailable context when no hosting manager is installed', async () => {
  const { dataDir, secrets } = setup()
  files.saveHostingConfig(dataDir, config)
  const type = builtinProviderTypes.find(type => type.type === 'volcengine-ark')!
  let hosted: Parameters<typeof type.create>[1]['hosted']
  const create = vi.fn<typeof type.create>((entry, deps) => { hosted = deps.hosted; return { ...createMockProvider(), id: entry.id } })
  const manager = createProviderManager({ dataDir, secrets, builtins: [], defaults: {}, media: createFfmpegMedia(), providerTypes: [{ ...type, create }], onChange() {} })
  await manager.update({ providers: [{ id: 'ark', type: type.type, label: 'Ark', baseUrl: 'http://127.0.0.1:1', imageModels: [], videoModels: [], audioModels: [] }], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } })
  expect(hosted!.configured).toBe(false)
  await expect(hosted!.url({ path: '/not-read.mp4', mime: 'video/mp4', key: 'none:0' }, 60)).rejects.toMatchObject({ details: { reason: 'hosting.not_configured' } })
  await expect(hosted!.release('none')).rejects.toMatchObject({ details: { reason: 'hosting.not_configured' } })
  const load = vi.spyOn(files, 'loadHostingConfig')
  for (let index = 0; index < 4; index++) expect(hosted!.redact('vendor testAK')).not.toContain('testAK')
  expect(load).not.toHaveBeenCalled()
})
