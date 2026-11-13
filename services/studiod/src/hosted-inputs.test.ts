import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostingConfig } from '@vis/protocol'
import { createHostingManager } from './hosting'
import { createMemorySecretStore } from './secret-store'
import { createFakeTos } from './testing/fake-tos'
import { presignTosGet, signTosRequest } from './tos-signing'

const config: HostingConfig = { type: 'tos', region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: 'testAK', prefix: 'vis-creative/refs/' }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
let dir: string
let tos: Awaited<ReturnType<typeof createFakeTos>>
let secrets: ReturnType<typeof createMemorySecretStore>
let hosting: ReturnType<typeof createHostingManager>
let path: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-hosted-'))
  path = join(dir, 'pinned.mp4')
  writeFileSync(path, 'pinned reference bytes')
  tos = await createFakeTos()
  secrets = createMemorySecretStore()
  hosting = createHostingManager({ dataDir: dir, secrets, fetch: tos.fetch, uploadRequest: tos.uploadRequest })
})
afterEach(async () => { await tos.close(); rmSync(dir, { recursive: true, force: true }) })
async function configure() { await hosting.update(config); await hosting.setSecret('testSK') }

describe('Hosted inputs', () => {
  it('requires valid configuration and a secret, refreshes readiness and keeps secrets in memory only', async () => {
    expect(hosting.inputs.configured).toBe(false)
    expect(await hosting.ready()).toBe(false)
    expect(await hosting.test()).toEqual({ ok: false, step: 'config', reason: 'hosting.not_configured' })
    await hosting.update(config)
    expect(await hosting.ready()).toBe(false)
    await hosting.setSecret('testSK')
    expect(hosting.inputs.configured).toBe(true)
    expect(await hosting.get()).toEqual({ config, hasSecret: true })
    expect(readFileSync(join(dir, 'hosting.json'), 'utf8')).not.toContain('testSK')
    writeFileSync(join(dir, 'hosting.json'), '{')
    expect(await hosting.ready()).toBe(true)
    expect(await hosting.get()).toEqual({ config, hasSecret: true })
    const restarted = createHostingManager({ dataDir: dir, secrets })
    await restarted.initialize()
    expect(await restarted.ready()).toBe(false)
    expect(await restarted.get()).toEqual({ config: null, hasSecret: true })
    expect(readFileSync(join(dir, 'hosting.json'), 'utf8')).toBe('{')
  })

  it('keeps the secret on bucket and region changes and deletes it with the configuration', async () => {
    await configure()
    await hosting.update({ ...config, bucket: 'other-clips', region: 'cn-shanghai' })
    expect(await secrets.get('tos')).toBe('testSK')
    await hosting.update(null)
    expect(await hosting.get()).toEqual({ config: null, hasSecret: false })
    expect(await secrets.has('tos')).toBe(false)
    await hosting.update(null)
    await hosting.clearSecret()
  })

  it('overwrites deterministic ordinal objects on retry, separates jobs and maps MIME extensions', async () => {
    await configure()
    const url = await hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:with:colons:0' }, 25200)
    const object = `${config.prefix}${digest('job:with:colons')}/0.mp4`
    expect(new URL(url).pathname).toBe(`/${object}`)
    expect(new URL(url).searchParams.get('X-Tos-Expires')).toBe('25200')
    expect(await (await tos.fetch(url)).text()).toBe('pinned reference bytes')
    writeFileSync(path, 'retry')
    await hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:with:colons:0' }, 25200)
    await hosting.inputs.url({ path, mime: 'video/quicktime', key: 'job:with:colons:1' }, 25200)
    await hosting.inputs.url({ path, mime: 'image/jpeg', key: 'other-job:0' }, 25200)
    expect(tos.objects.get(object)?.toString()).toBe('retry')
    expect([...tos.objects.keys()]).toContain(`${config.prefix}${digest('job:with:colons')}/1.mov`)
    expect(tos.objects.size).toBe(3)
    expect(tos.rejected).toBe(0)
    expect(tos.verified).toBe(5)
  })

  it('starts the link lifetime after the upload has completed', async () => {
    await configure()
    let now = new Date()
    const start = now
    const delayed = createHostingManager({ dataDir: dir, secrets, now: () => now, uploadRequest: ((...args) => { now = new Date(start.getTime() + 300_000); return tos.uploadRequest(...args) }) as typeof tos.uploadRequest, fetch: async (url, init) => {
      const response = await tos.fetch(url, init)
      if (init?.method === 'PUT') now = new Date(start.getTime() + 300_000)
      return response
    } })
    const url = new URL(await delayed.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 60))
    expect(url.searchParams.get('X-Tos-Date')).toBe(now.toISOString().replace(/[:-]|\.\d{3}/g, ''))
  })

  it('lists all pages and deletes only the job prefix, tolerating missing objects and repeated cleanup', async () => {
    await configure()
    for (let ordinal = 0; ordinal < 5; ordinal++) await hosting.inputs.url({ path, mime: 'video/mp4', key: `job:${ordinal}` }, 60)
    await hosting.inputs.url({ path, mime: 'audio/mpeg', key: 'other:0' }, 60)
    tos.missingOnDelete = true
    await hosting.inputs.release('job')
    await hosting.inputs.release('job')
    expect([...tos.objects.keys()]).toEqual([`${config.prefix}${digest('other')}/0.mp3`])
    expect(tos.requests.filter(request => request.method === 'LIST')).toHaveLength(4)
    expect(tos.rejected).toBe(0)
  })

  it('refuses malformed cleanup listings and repeated continuation tokens without widening deletion', async () => {
    await configure()
    tos.listOutsidePrefix = true
    await expect(hosting.inputs.release('job')).rejects.toThrow('Media hosting operation failed')
    expect(tos.requests.some(request => request.method === 'DELETE')).toBe(false)
    tos.listOutsidePrefix = false
    tos.repeatToken = true
    await expect(hosting.inputs.release('job')).rejects.toThrow('Media hosting operation failed')
    expect(tos.requests.filter(request => request.method === 'LIST')).toHaveLength(3)
  })

  it('the fake server independently rejects modified payloads, paths and query signatures', async () => {
    const signed = signTosRequest({ config, secret: 'testSK', key: 'clip.mp4', method: 'PUT', body: Buffer.from('original') })
    expect((await tos.fetch(signed.url, { method: 'PUT', headers: signed.headers, body: 'modified' })).status).toBe(403)
    const url = new URL(presignTosGet({ config, secret: 'testSK', key: 'clip.mp4', ttlSeconds: 60 }))
    url.searchParams.set('X-Tos-Expires', '61')
    expect((await tos.fetch(url.href)).status).toBe(403)
    const path = new URL(presignTosGet({ config, secret: 'testSK', key: 'clip.mp4', ttlSeconds: 60 }))
    path.pathname = '/different.mp4'
    expect((await tos.fetch(path.href)).status).toBe(403)
    expect(tos.rejected).toBe(3)
    expect(tos.verified).toBe(0)
  })

  it('reads the secret per call and redacts store, file, network, HTTP and list errors completely', async () => {
    await configure()
    const get = vi.spyOn(secrets, 'get')
    await hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 60)
    await hosting.inputs.release('job')
    expect(get).toHaveBeenCalledTimes(2)
    const leak = 'https://reference-clips.tos-cn-beijing.volces.com/private?X-Tos-Signature=private-signature testAK testSK'
    get.mockRejectedValue(new Error(leak))
    await expect(hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 60)).rejects.toMatchObject({ details: { reason: 'hosting.store_failed' } })
    get.mockRestore()
    const broken = createHostingManager({ dataDir: dir, secrets, fetch: async () => { throw new Error(leak) } })
    for (const operation of [() => broken.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 60), () => broken.inputs.release('job')]) {
      await expect(operation()).rejects.toThrow('Media hosting operation failed')
      await expect(operation()).rejects.not.toThrow(/testAK|testSK|private-signature|https:/)
    }
    tos.fail = 'upload'
    await expect(hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 60)).rejects.toThrow('Media hosting operation failed')
    tos.fail = 'list'
    await expect(hosting.inputs.release('job')).rejects.toThrow('Media hosting operation failed')
    await expect(hosting.inputs.url({ path: leak, mime: 'video/mp4', key: 'job:0' }, 60)).rejects.toThrow('Media hosting operation failed')
  })

  it('rejects invalid keys, MIME types, lifetimes and aborted requests before upload without echoing input', async () => {
    await configure()
    for (const key of ['private-key', 'private-key:-1', 'private-key:1.5', ':1', 'private-key:01', 'private-key:9007199254740993']) {
      await expect(hosting.inputs.url({ path, mime: 'video/mp4', key }, 60)).rejects.not.toThrow('private-key')
    }
    await expect(hosting.inputs.url({ path, mime: 'unknown/private', key: 'job:0' }, 60)).rejects.toThrow()
    await expect(hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 0)).rejects.toThrow()
    await expect(hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 604801)).rejects.toThrow()
    const controller = new AbortController()
    controller.abort(new Error('testSK testAK'))
    await expect(hosting.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 60, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(tos.verified).toBe(0)
  })

  it('forwards cancellation during upload without exposing the abort reason', async () => {
    await configure()
    const controller = new AbortController()
    let started!: () => void
    const uploading = new Promise<void>(resolve => { started = resolve })
    const cancelled = createHostingManager({ dataDir: dir, secrets, fetch: tos.fetch, uploadRequest: ((...args) => {
      started()
      const call = tos.uploadRequest(...args)
      return call
    }) as typeof tos.uploadRequest })
    tos.stallUpload = true
    writeFileSync(path, Buffer.alloc(8 * 1024 ** 2))
    const result = cancelled.inputs.url({ path, mime: 'video/mp4', key: 'job:0' }, 60, controller.signal)
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Media hosting operation aborted' })
    await uploading
    controller.abort(new Error('testSK testAK private-signature'))
    await assertion
  })

  it('checks a 1 KB upload, presigned read and delete and reports only the failing step', async () => {
    await configure()
    expect(await hosting.test()).toEqual({ ok: true })
    expect(tos.uploadSizes).toEqual([1024])
    expect(tos.objects.size).toBe(0)
    for (const step of ['upload', 'read', 'delete'] as const) {
      tos.fail = step
      expect(await hosting.test()).toEqual({ ok: false, step, reason: 'hosting.test_failed' })
    }
    tos.fail = undefined
    tos.corruptRead = true
    expect(await hosting.test()).toEqual({ ok: false, step: 'read', reason: 'hosting.test_failed' })
    await hosting.clearSecret()
    expect(await hosting.test()).toEqual({ ok: false, step: 'config', reason: 'hosting.not_configured' })
    expect(tos.rejected).toBe(0)
  })
})
