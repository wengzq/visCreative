import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFfmpegMedia } from '@vis/assets'
import { createMockProvider } from '@vis/generation'
import { afterEach, expect, it, vi } from 'vitest'
import { createHostingManager } from './hosting'
import { createMemorySecretStore } from './secret-store'
import { createProviderManager } from './providers'
import { saveHostingConfig } from './hosting-config'
import { presignTosGet } from './tos-signing'

const config = { type: 'tos' as const, region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: 'testAK', prefix: 'vis-creative/refs/' }
const dirs: string[] = []
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'vis-hosting-review-'))
  dirs.push(dataDir)
  const secrets = createMemorySecretStore()
  const hosting = createHostingManager({ dataDir, secrets })
  return { dataDir, secrets, hosting }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('clears a secret on access key changes while preserving it on bucket, region and prefix changes', async () => {
  const { hosting, secrets } = setup()
  await hosting.update(config)
  await hosting.setSecret('testSK')
  await hosting.update({ ...config, region: 'cn-shanghai', bucket: 'other-clips', prefix: 'other/' })
  expect(await secrets.get('tos')).toBe('testSK')
  const changed = await hosting.update({ ...config, accessKeyId: 'nextAK' })
  expect(changed.hasSecret).toBe(false)
  expect(hosting.inputs.configured).toBe(false)
  expect(await secrets.get('tos')).toBeUndefined()
})

it('does not spawn credential checks when listing providers or reading hosting settings', async () => {
  const { dataDir, hosting, secrets } = setup()
  await hosting.update(config)
  await hosting.setSecret('testSK')
  const has = vi.spyOn(secrets, 'has')
  const manager = createProviderManager({ dataDir, hosting, builtins: [createMockProvider()], defaults: {}, secrets: createMemorySecretStore(), media: createFfmpegMedia(), onChange() {} })
  for (let index = 0; index < 4; index++) {
    expect((await manager.list()).videoReferences).toBe('ready')
    expect((await hosting.get()).hasSecret).toBe(true)
  }
  expect(has).not.toHaveBeenCalled()
})

it('an older readiness lookup cannot restore a secret after a newer clear', async () => {
  const { dataDir, hosting, secrets } = setup()
  saveHostingConfig(dataDir, config)
  await secrets.set('tos', 'testSK')
  let resolve!: (value: boolean) => void
  const lookup = new Promise<boolean>(done => { resolve = done })
  vi.spyOn(secrets, 'has').mockImplementationOnce(() => lookup)
  const initial = hosting.update(config)
  await vi.waitFor(() => expect(secrets.has).toHaveBeenCalled())
  const cleared = hosting.clearSecret()
  resolve(true)
  await Promise.all([initial, cleared])
  expect(hosting.inputs.configured).toBe(false)
  expect((await hosting.get()).hasSecret).toBe(false)
})

it('distinguishes credential and file write failures from a connection test failure', async () => {
  const { dataDir, hosting, secrets } = setup()
  await hosting.update(config)
  vi.spyOn(secrets, 'set').mockRejectedValue(new Error('private credential diagnostic'))
  await expect(hosting.setSecret('testSK')).rejects.toMatchObject({ details: { reason: 'hosting.store_failed', params: {} } })
  writeFileSync(join(dataDir, 'blocked'), 'file')
  const blocked = createHostingManager({ dataDir: join(dataDir, 'blocked'), secrets })
  await expect(blocked.update(config)).rejects.toMatchObject({ details: { reason: 'hosting.store_failed', params: {} } })
})

it('rejects oversized link lifetimes instead of silently shortening them', () => {
  expect(() => presignTosGet({ config, secret: 'testSK', key: 'clip.mp4', ttlSeconds: 604801 })).toThrow()
  expect(new URL(presignTosGet({ config, secret: 'testSK', key: 'clip.mp4', ttlSeconds: 604800 })).searchParams.get('X-Tos-Expires')).toBe('604800')
})


it('checks credentials once at startup and refreshes after each hosting mutation', async () => {
  const { dataDir, secrets } = setup()
  saveHostingConfig(dataDir, config)
  await secrets.set('tos', 'testSK')
  const hosting = createHostingManager({ dataDir, secrets })
  const has = vi.spyOn(secrets, 'has')
  await hosting.initialize()
  await hosting.initialize()
  expect(await hosting.ready()).toBe(true)
  expect(has).toHaveBeenCalledTimes(1)
  await hosting.setSecret('replacement')
  expect(has).toHaveBeenCalledTimes(2)
  await hosting.clearSecret()
  expect(has).toHaveBeenCalledTimes(3)
  await hosting.update({ ...config, bucket: 'other-clips' })
  expect(has).toHaveBeenCalledTimes(4)
})

it('redacts current credentials and signed TOS URLs after a restart without an upload in flight', async () => {
  const { dataDir, hosting } = setup()
  await hosting.update(config)
  const restarted = createHostingManager({ dataDir, secrets: createMemorySecretStore() })
  const url = 'https://reference-clips.tos-cn-beijing.volces.com/refs/clip.mp4?X-Tos-Signature=private-signature&X-Tos-Credential=private-credential'
  for (const value of [url, encodeURIComponent(url), encodeURIComponent(encodeURIComponent(url)), url.replaceAll('/', '\\/'), 'X-Tos-Signature=private-signature X-Tos-Credential=private-credential', '"X-Tos-Signature": "private-signature", "X-Tos-Credential": "private-credential"']) {
    const redacted = restarted.inputs.redact(`vendor testAK ${value}`)
    expect(redacted).not.toMatch(/testAK|private-signature|private-credential|tos-cn-beijing/)
  }
  expect(restarted.inputs.redact('ordinary result%2Fid')).toBe('ordinary result%2Fid')
})
