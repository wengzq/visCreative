import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, type ReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { getEventListeners } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHostingManager } from './hosting'
import { createMemorySecretStore } from './secret-store'
import { createFakeTos } from './testing/fake-tos'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), open: vi.fn() }))
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let dir: string
let path: string
let tos: Awaited<ReturnType<typeof createFakeTos>>
let hosting: ReturnType<typeof createHostingManager>
const streams: { path: string; stream: ReadStream }[] = []
const closing: { destroyed: boolean; abortListeners: number }[] = []
let observedSignal: AbortSignal | undefined
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-tos-lifecycle-'))
  path = join(dir, 'reference.mp4')
  writeFileSync(path, Buffer.alloc(128 * 1024 + 5, 42))
  streams.length = 0
  closing.length = 0
  observedSignal = undefined
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closing.push({ destroyed: streams.filter(input => input.path === String(args[0])).at(-1)?.stream.destroyed ?? true, abortListeners: observedSignal ? getEventListeners(observedSignal, 'abort').length : 0 })
      await close()
    })
    const create = handle.createReadStream.bind(handle)
    vi.spyOn(handle, 'createReadStream').mockImplementation(options => {
      const stream = create(options)
      streams.push({ path: String(args[0]), stream })
      return stream
    })
    return handle
  })
  tos = await createFakeTos()
  hosting = createHostingManager({ dataDir: dir, secrets: createMemorySecretStore(), fetch: tos.fetch, uploadRequest: tos.uploadRequest })
  await hosting.update({ type: 'tos', region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: 'testAK', prefix: 'refs/' })
  await hosting.setSecret('testSK')
})
afterEach(async () => {
  for (const { stream } of streams) stream.destroy()
  await tos.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})
const upload = () => hosting.inputs.url({ path, mime: 'video/mp4', key: 'retry:0' }, 60)

it('destroys the upload body and removes abort listeners when transport construction throws', async () => {
  const controller = new AbortController()
  observedSignal = controller.signal
  const secrets = createMemorySecretStore()
  await secrets.set('tos', 'testSK')
  const broken = createHostingManager({ dataDir: dir, secrets, fetch: tos.fetch, uploadRequest: () => { throw new Error('Private transport diagnostic') } })
  await expect(broken.inputs.url({ path, mime: 'video/mp4', key: 'broken:0' }, 60, controller.signal)).rejects.toMatchObject({ details: { reason: 'hosting.upload_failed' } })
  expect(streams).toHaveLength(2)
  expect(closing.length).toBeGreaterThan(0)
  expect(closing.every(state => state.destroyed && state.abortListeners === 0)).toBe(true)
  expect(streams.every(({ stream }) => stream.destroyed)).toBe(true)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('sends exactly the hashed length when the file grows before upload starts', async () => {
  const size = statSync(path).size
  const secrets = createMemorySecretStore()
  await secrets.set('tos', 'testSK')
  const growing = createHostingManager({ dataDir: dir, secrets, fetch: tos.fetch, uploadRequest: (...args) => {
    appendFileSync(path, 'extra bytes beyond the signed length')
    return tos.uploadRequest(...args)
  } })
  await growing.inputs.url({ path, mime: 'video/mp4', key: 'growing:0' }, 60)
  expect(tos.uploadWriteSizes.reduce((total, bytes) => total + bytes, 0)).toBe(size)
  expect(tos.uploadSizes).toEqual([size])
  expect(tos.rejected).toBe(0)
})

it('memoizes the hash on retries and invalidates it when size or modification time changes', async () => {
  await upload()
  expect(streams).toHaveLength(2)
  await upload()
  expect(streams).toHaveLength(3)
  const stat = statSync(path)
  utimesSync(path, new Date(stat.atimeMs), new Date(stat.mtimeMs + 5000))
  await upload()
  expect(streams).toHaveLength(5)
  appendFileSync(path, 'changed size')
  await upload()
  expect(streams).toHaveLength(7)
})

it('keeps different paths separate even when their size and modification time match', async () => {
  const other = join(dir, 'same-metadata.mp4')
  const size = statSync(path).size
  writeFileSync(other, Buffer.alloc(size, 43))
  const timestamp = new Date(1000000000)
  utimesSync(path, timestamp, timestamp)
  utimesSync(other, timestamp, timestamp)
  await upload()
  await hosting.inputs.url({ path: other, mime: 'video/mp4', key: 'other:0' }, 60)
  expect(streams.filter(input => input.path === other)).toHaveLength(2)
  expect(tos.rejected).toBe(0)
})

it.each(['replacement', 'in-place'])('invalidates a same-size, same-mtime digest after an %s change', async mode => {
  const timestamp = new Date(1000000000)
  utimesSync(path, timestamp, timestamp)
  const before = statSync(path)
  await upload()
  if (mode === 'replacement') {
    const other = join(dir, 'replacement.mp4')
    writeFileSync(other, Buffer.alloc(before.size, 43))
    utimesSync(other, timestamp, timestamp)
    renameSync(other, path)
    expect(statSync(path).ino).not.toBe(before.ino)
  } else {
    await vi.waitFor(() => {
      writeFileSync(path, Buffer.alloc(before.size, 43))
      utimesSync(path, timestamp, timestamp)
      expect(statSync(path).ctimeMs).not.toBe(before.ctimeMs)
    })
    expect(statSync(path).ino).toBe(before.ino)
  }
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  await upload()
  expect(streams).toHaveLength(4)
  expect(tos.rejected).toBe(0)
})

it('keeps path-specific hashes and evicts old hashes from a bounded cache', async () => {
  await upload()
  await upload()
  for (let ordinal = 0; ordinal < 65; ordinal++) {
    const other = join(dir, `other-${ordinal}.mp4`)
    writeFileSync(other, 'different reference bytes')
    await hosting.inputs.url({ path: other, mime: 'video/mp4', key: `other:${ordinal}` }, 60)
  }
  await upload()
  expect(streams.filter(input => input.path === path)).toHaveLength(5)
  expect(tos.rejected).toBe(0)
})
