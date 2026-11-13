import { randomBytes, randomUUID } from 'node:crypto'
import { VisError } from '@vis/domain'
import type { HostingConfig, MethodResult } from '@vis/protocol'
import { createHostedInputs, createTosClient, hostingFailure, type HostingOptions } from './hosted-inputs'
import { loadHostingConfig, saveHostingConfig } from './hosting-config'

export type HostingManager = ReturnType<typeof createHostingManager>

export function createHostingManager(opts: HostingOptions) {
  let hasSecret: boolean | undefined
  // Studiod is the only writer. Hand edits take effect after a restart, rather than on catalog or redaction reads.
  let config = loadHostingConfig(opts.dataDir)
  const getConfig = () => config
  const inputsOptions = { ...opts, getConfig, hasSecret: () => hasSecret === true }
  const inputs = createHostedInputs(inputsOptions)
  const tos = createTosClient(inputsOptions)
  let initialized = false
  let pending: Promise<unknown> = Promise.resolve()
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }
  let lastAttempt = -Infinity
  const now = () => opts.now?.().getTime() ?? Date.now()
  const notConfigured = () => VisError.of('unavailable', 'hosting.not_configured', {}, 'Media hosting is not configured')
  async function readState(): Promise<MethodResult<'hosting.get'>> {
    const config = getConfig()
    lastAttempt = now()
    try { hasSecret = await opts.secrets.has('tos') }
    catch { hasSecret = undefined; throw hostingFailure('hosting.store_failed') }
    return { config, hasSecret }
  }
  async function retryUnknown() {
    if (hasSecret !== undefined || now() - lastAttempt < 30_000) return
    await serialize(async () => {
      if (hasSecret !== undefined || now() - lastAttempt < 30_000) return
      try { await readState() } catch { /* Unknown readiness remains unavailable until the next allowed check. */ }
    })
  }
  async function get(): Promise<MethodResult<'hosting.get'>> {
    await retryUnknown()
    return { config: getConfig(), hasSecret: hasSecret === true }
  }
  async function mutate(operation: () => Promise<void>) {
    return serialize(async () => {
      let failure: 'hosting.not_configured' | 'hosting.store_failed' | undefined
      try { await operation() }
      catch (error) { failure = error instanceof VisError && error.details?.reason === 'hosting.not_configured' ? 'hosting.not_configured' : 'hosting.store_failed' }
      // Either store may have changed on failure. A presence-check failure does not undo a successful operation.
      config = loadHostingConfig(opts.dataDir)
      try { await readState() } catch { /* Unknown readiness is retried with the normal cooldown. */ }
      if (failure) throw failure === 'hosting.not_configured' ? notConfigured() : hostingFailure(failure)
      return { config, hasSecret: hasSecret === true }
    })
  }
  return {
    inputs, get,
    async ready() {
      // A successful check is cached until a mutation. External deletion is detected by the next upload, as upload_failed.
      if (getConfig()) await retryUnknown()
      return inputs.configured
    },
    initialize() {
      return serialize(async () => {
        if (initialized) return
        initialized = true
        // Missing configuration cannot enable hosting; the settings get still discovers orphan credentials when opened.
        if (getConfig()) { try { await readState() } catch { /* Locked stores cannot disable unrelated providers. */ } }
      })
    },
    async update(config: HostingConfig | null): Promise<MethodResult<'hosting.update'>> {
      return mutate(async () => {
        const previous = getConfig()
        if (config === null || previous?.accessKeyId !== config.accessKeyId) await opts.secrets.delete('tos')
        saveHostingConfig(opts.dataDir, config)
      })
    },
    async setSecret(secret: string): Promise<MethodResult<'hosting.setSecret'>> {
      const state = await mutate(async () => {
        if (!getConfig()) throw notConfigured()
        await opts.secrets.set('tos', secret)
      })
      return { hasSecret: state.hasSecret }
    },
    async clearSecret(): Promise<MethodResult<'hosting.clearSecret'>> {
      const state = await mutate(async () => { await opts.secrets.delete('tos') })
      return { hasSecret: state.hasSecret }
    },
    async test(): Promise<MethodResult<'hosting.test'>> {
      let auth: Awaited<ReturnType<typeof tos.credentials>>
      try { auth = await tos.credentials() }
      catch { return { ok: false, step: 'config', reason: 'hosting.not_configured' } }
      const key = `${auth.config.prefix}test/${randomUUID()}.bin`
      const body = randomBytes(1024)
      let step: 'upload' | 'read' | 'delete' = 'upload'
      try {
        await tos.put(auth, key, body, 'application/octet-stream')
        step = 'read'
        const bytes = await tos.read(tos.presign(auth, key, 60))
        if (!bytes.equals(body)) throw hostingFailure('hosting.test_failed')
        step = 'delete'
        await tos.delete(auth, key)
        return { ok: true }
      } catch {
        // Read and ambiguous upload failures still attempt cleanup; keep the original failing step.
        if (step !== 'delete') { try { await tos.delete(auth, key) } catch { /* Bucket lifecycle is the final backstop. */ } }
        return { ok: false, step, reason: 'hosting.test_failed' }
      }
    },
  }
}
