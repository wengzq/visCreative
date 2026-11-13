import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { replaceRecord } from './ark/persistence'
import { ProviderError, type DownloadedOutput, type ProviderAdapter, type ProviderRequest } from './types'

const inflight = new Map<string, Promise<{ externalTaskId: string }>>()

/** Persist an intent before calling a synchronous API; a missing result never licenses another paid call. */
export function stageSyncOutput(opts: {
  dataDir: string
  providerId: string
  maxBytes: number
  mimeTypes: readonly string[]
  call(request: ProviderRequest, options: { idempotencyKey: string; signal?: AbortSignal }): Promise<DownloadedOutput[] | { state: 'failed'; error: { code: string; message: string; reason?: string } }>
}): Pick<ProviderAdapter, 'submit' | 'getTask' | 'download' | 'cleanup'> {
  const root = resolve(opts.dataDir, 'generation-sync', createHash('sha256').update(opts.providerId).digest('hex'))
  const taskId = (key: string) => createHash('sha256').update(key).digest('hex')
  const directory = (id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ProviderError('not_found', 'Synchronous generation task does not exist')
    return join(root, id)
  }
  type Record = { state: 'submitting' } | { state: 'succeeded'; outputs: Omit<DownloadedOutput, 'data'>[]; released?: boolean } | { state: 'failed'; error: { code: string; message: string; data?: { reason: string } } }
  async function save(id: string, value: Record) {
    const temporary = join(directory(id), `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true })
    await replaceRecord(temporary, join(directory(id), 'task.json'))
  }
  async function releaseBytes(id: string) {
    for (const name of await readdir(directory(id))) {
      if (/^\d+\.bin$/.test(name) || /^[a-f0-9-]+\.tmp$/.test(name)) await rm(join(directory(id), name), { force: true })
    }
  }
  async function record(id: string): Promise<Record> {
    try { return JSON.parse(await readFile(join(directory(id), 'task.json'), 'utf8')) as Record }
    catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('not_found', 'Synchronous generation task does not exist')
    }
  }
  async function submit(request: ProviderRequest, options: { idempotencyKey: string; signal?: AbortSignal }) {
    options.signal?.throwIfAborted()
    const id = taskId(options.idempotencyKey)
    const dir = directory(id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try { await writeFile(join(dir, 'task.json'), JSON.stringify({ state: 'submitting' }), { flag: 'wx', mode: 0o600, flush: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ProviderError('rejected', 'Cannot stage synchronous generation intent')
      if ((await record(id)).state !== 'submitting') return { externalTaskId: id }
      throw new ProviderError('timeout', 'Synchronous generation result is unknown; not resubmitted')
    }
    let outputs: Awaited<ReturnType<typeof opts.call>>
    try { outputs = await opts.call(request, options) }
    catch (error) {
      // Adapters sanitize known provider errors; transport exceptions may contain credentials and must not escape.
      if (error instanceof ProviderError) {
        if (error.kind === 'transient' || error.kind === 'rejected') await rm(join(dir, 'task.json'), { force: true })
        throw error
      }
      throw new ProviderError('timeout', 'Synchronous generation result is unknown; not resubmitted')
    }
    if (!Array.isArray(outputs)) {
      const { code, message, reason } = outputs.error
      await releaseBytes(id)
      await save(id, { state: 'failed', error: { code, message, ...(reason ? { data: { reason } } : {}) } })
      return { externalTaskId: id }
    }
    if (!outputs.length || outputs.some(({ data, mime }) => !opts.mimeTypes.includes(mime) || data.byteLength > opts.maxBytes)) {
      await releaseBytes(id)
      await save(id, { state: 'failed', error: { code: 'sync_output_invalid', message: 'The generation call completed but returned unusable output' } })
      return { externalTaskId: id }
    }
    const metadata: Omit<DownloadedOutput, 'data'>[] = []
    try {
      for (const [index, { data, ...info }] of outputs.entries()) {
        await writeFile(join(dir, `${index}.bin`), data, { mode: 0o600, flush: true })
        metadata.push(info)
      }
      await save(id, { state: 'succeeded', outputs: metadata })
    } catch {
      await releaseBytes(id)
      throw new ProviderError('timeout', 'The generation call completed but its output could not be staged; not resubmitted')
    }
    return { externalTaskId: id }
  }
  return {
    submit(request, options) {
      const key = directory(taskId(options.idempotencyKey))
      const existing = inflight.get(key)
      if (existing) return existing
      const pending = submit(request, options).finally(() => inflight.delete(key))
      inflight.set(key, pending)
      return pending
    },
    async getTask(id) {
      const saved = await record(id)
      if (saved.state === 'failed') return saved
      if (saved.state !== 'succeeded') throw new ProviderError('timeout', 'Synchronous generation result is unknown')
      return { state: 'succeeded', outputs: saved.outputs.map((_, outputIndex) => ({ outputIndex, ref: id })) }
    },
    async download(output) {
      const saved = await record(output.ref)
      if (saved.state !== 'succeeded' || saved.released || !Number.isInteger(output.outputIndex) || output.outputIndex < 0 || !saved.outputs[output.outputIndex]) throw new ProviderError('not_found', 'Synchronous generation output does not exist')
      const info = saved.outputs[output.outputIndex]!
      const data = await readFile(join(directory(output.ref), `${output.outputIndex}.bin`))
      if (!opts.mimeTypes.includes(info.mime) || data.byteLength > opts.maxBytes) throw new ProviderError('rejected', 'Invalid synchronous generation output type or size')
      return { ...info, data: new Uint8Array(data) }
    },
    async cleanup({ idempotencyKey, status }) {
      // Rechecking an unknown job may still need its paid output; only conclusive settlement releases bytes.
      if (status === 'unknown') return
      const id = taskId(idempotencyKey)
      // A cancelled job may still be completing its paid call; release only after that writer finishes.
      await inflight.get(directory(id))
      let saved: Record
      try { saved = await record(id) } catch (error) {
        if (error instanceof ProviderError && error.kind === 'not_found') return
        throw error
      }
      if (saved.state === 'succeeded') await save(id, { ...saved, released: true })
      await releaseBytes(id)
    },
  }
}
