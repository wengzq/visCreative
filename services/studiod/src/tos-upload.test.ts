import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHostingManager } from './hosting'
import { createMemorySecretStore } from './secret-store'
import { createFakeTos } from './testing/fake-tos'

let dir: string
let path: string
let tos: Awaited<ReturnType<typeof createFakeTos>>
let hosting: ReturnType<typeof createHostingManager>
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-tos-stream-'))
  path = join(dir, 'reference.mp4')
  writeFileSync(path, Buffer.alloc(8 * 1024 ** 2, 42))
  tos = await createFakeTos()
  hosting = createHostingManager({ dataDir: dir, secrets: createMemorySecretStore(), fetch: tos.fetch, uploadRequest: tos.uploadRequest, uploadStallMs: 250 })
  await hosting.update({ type: 'tos', region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: 'testAK', prefix: 'refs/' })
  await hosting.setSecret('testSK')
})
afterEach(async () => { vi.restoreAllMocks(); await tos.close(); rmSync(dir, { recursive: true, force: true }) })

it('streams bounded chunks with a signed payload hash and explicit length while network progress exceeds the stall window', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => timeout(milliseconds === 60_000 ? 250 : milliseconds))
  tos.uploadChunkDelayMs = 10
  const start = Date.now()
  const url = await hosting.inputs.url({ path, mime: 'video/mp4', key: 'slow:0' }, 60)
  expect(Date.now() - start).toBeGreaterThan(250)
  expect(new URL(url).pathname.endsWith('/0.mp4')).toBe(true)
  expect(tos.uploadSizes).toEqual([8 * 1024 ** 2])
  expect(tos.uploadContentLengths).toEqual([8 * 1024 ** 2])
  expect(tos.uploadSignedLengths).toEqual([true])
  expect(tos.uploadWriteSizes.length).toBeGreaterThan(1)
  expect(Math.max(...tos.uploadWriteSizes)).toBeLessThanOrEqual(64 * 1024)
  expect(tos.rejected).toBe(0)
})

it('aborts a stalled upload and returns an upload-specific error without waiting for the caller deadline', async () => {
  tos.stallUpload = true
  await expect(hosting.inputs.url({ path, mime: 'video/mp4', key: 'stalled:0' }, 60, AbortSignal.timeout(3000))).rejects.toMatchObject({ details: { reason: 'hosting.upload_failed', params: {} } })
})

it('closes the pinned stream when a transport rejects synchronously and keeps its diagnostic private', async () => {
  const broken = createHostingManager({ dataDir: dir, secrets: createMemorySecretStore(), fetch: tos.fetch, uploadRequest: () => { throw new Error('private upload diagnostic') } })
  await broken.setSecret('testSK')
  await expect(broken.inputs.url({ path, mime: 'video/mp4', key: 'transport:0' }, 60)).rejects.toMatchObject({ details: { reason: 'hosting.upload_failed', params: {} } })
})
