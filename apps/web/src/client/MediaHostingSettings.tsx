import { useEffect, useId, useRef, useState } from 'react'
import { HostingConfigSchema, type HostingConfig, type MethodResult } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import { settingsMessages } from './messages'

type Props = {
  active: boolean
  rpc: { call<T = any>(method: string, params?: any): Promise<T>; onProvidersChanged?(listener: () => void): () => void }
  agentIsolation?: 'sandbox' | 'none' | undefined
  onDirtyChange(dirty: boolean): void
  onChanged(): Promise<void>
}
const empty: HostingConfig = { type: 'tos', region: '', bucket: '', accessKeyId: '', prefix: 'vis-creative/refs/' }

export function MediaHostingSettings({ active, rpc, agentIsolation, onDirtyChange, onChanged }: Props) {
  const m = useMessages(settingsMessages)
  const id = useId()
  const secretInput = useRef<HTMLInputElement>(null)
  const [base, setBase] = useState<HostingConfig | null>(null)
  const [draft, setDraft] = useState<HostingConfig>(empty)
  const [hasSecret, setHasSecret] = useState(false)
  const [secretEntered, setSecretEntered] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [status, setStatus] = useState<'saved' | 'secretSaved' | 'secretCleared' | 'removed' | null>(null)
  const [failed, setFailed] = useState(false)
  const [test, setTest] = useState<MethodResult<'hosting.test'> | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(base ?? empty)
  const validation = HostingConfigSchema.safeParse(draft)
  const errors = new Set(attempted && !validation.success ? validation.error.issues.map(issue => issue.path[0]) : [])

  const current = useRef({ dirty, busy })
  current.current = { dirty, busy }
  useEffect(() => {
    let sequence = 0
    let connected = true
    async function refresh() {
      if (!active && !loaded) return
      const request = ++sequence
      try {
        const result = await rpc.call<MethodResult<'hosting.get'>>('hosting.get')
        if (!connected || request !== sequence) return
        setBase(result.config)
        if (!current.current.dirty && !current.current.busy) setDraft(result.config ?? empty)
        setHasSecret(result.hasSecret)
        setLoaded(true)
        setTest(null)
      } catch { if (connected && request === sequence) setFailed(true) }
    }
    if (active && !loaded) void refresh()
    const unsubscribe = rpc.onProvidersChanged?.(() => { void refresh() })
    return () => { connected = false; unsubscribe?.() }
  }, [active, rpc, loaded])
  useEffect(() => {
    if (!active && secretInput.current) { secretInput.current.value = ''; setSecretEntered(false) }
  }, [active])
  useEffect(() => { onDirtyChange(dirty || secretEntered || busy) }, [dirty, secretEntered, busy, onDirtyChange])

  async function act(operation: () => Promise<void>) {
    if (busy || !loaded) return
    setBusy(true)
    setFailed(false)
    setStatus(null)
    setTest(null)
    try { await operation() }
    catch { setFailed(true) }
    finally { setBusy(false) }
  }
  async function refreshCatalog() {
    // The save has already succeeded; a catalog refresh failure must not disguise that result.
    try { await onChanged() } catch { /* The next provider refresh will read hosting readiness. */ }
  }
  function save() {
    setAttempted(true)
    if (!validation.success) return
    if (hasSecret && (!base || draft.accessKeyId !== base.accessKeyId) && !window.confirm(m.hostingKeyChangeConfirm)) return
    void act(async () => {
      const result = await rpc.call<MethodResult<'hosting.update'>>('hosting.update', { config: validation.data })
      setBase(result.config)
      setDraft(result.config ?? empty)
      setHasSecret(result.hasSecret)
      setAttempted(false)
      setStatus('saved')
      await refreshCatalog()
    })
  }
  function changeSecret(clear = false) {
    if (!clear && !base) return
    const secret = secretInput.current?.value.trim() ?? ''
    if (secretInput.current) secretInput.current.value = ''
    setSecretEntered(false)
    if (!clear && !secret) return
    void act(async () => {
      const result = await rpc.call<MethodResult<'hosting.setSecret'>>(clear ? 'hosting.clearSecret' : 'hosting.setSecret', clear ? {} : { secret })
      setHasSecret(result.hasSecret)
      setStatus(clear ? 'secretCleared' : 'secretSaved')
      await refreshCatalog()
    })
  }
  const labels = { region: m.hostingRegion, bucket: m.hostingBucket, accessKeyId: m.hostingAccessKeyId, prefix: m.hostingPrefix }
  const steps = { upload: m.hostingStepUpload, read: m.hostingStepRead, delete: m.hostingStepDelete, config: m.hostingStepConfig }
  const statuses = { saved: m.hostingSaved, secretSaved: m.hostingSecretSaved, secretCleared: m.hostingSecretCleared, removed: m.hostingRemoved }
  return <section aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{m.hostingTitle}</h2>
    <p className="provider-settings-isolation-notice">{m.hostingDisclosure}</p>
    <p className="provider-settings-hint">{m.hostingLifecycle}</p>
    {agentIsolation === 'none' ? <p className="provider-settings-isolation-notice">{m.settingsNoAgentIsolation}</p> : null}
    <fieldset className="provider-settings-fields" disabled={!loaded || busy}>
      {(Object.keys(labels) as (keyof typeof labels)[]).map(key => <div className="provider-settings-field" key={key}>
        <label htmlFor={`${id}-${key}`}>{labels[key]}</label>
        <input id={`${id}-${key}`} value={draft[key]} spellCheck={false} autoComplete="off" aria-invalid={errors.has(key)} aria-describedby={errors.has(key) ? `${id}-invalid` : undefined} onChange={event => {
          const value = event.currentTarget.value
          setDraft(current => ({ ...current, [key]: value }))
          setStatus(null)
          setTest(null)
        }} />
      </div>)}
      {attempted && !validation.success ? <p id={`${id}-invalid`} className="provider-settings-error" role="alert">{m.hostingInvalid}</p> : null}
      <div className="provider-settings-hosting-actions">
        <button type="button" disabled={!dirty} onClick={save}>{m.hostingSave}</button>
        {base ? <button type="button" onClick={() => void act(async () => {
          const result = await rpc.call<MethodResult<'hosting.update'>>('hosting.update', { config: null })
          setBase(null)
          setDraft(empty)
          setHasSecret(result.hasSecret)
          if (secretInput.current) secretInput.current.value = ''
          setSecretEntered(false)
          setAttempted(false)
          setStatus('removed')
          await refreshCatalog()
        })}>{m.hostingRemove}</button> : null}
      </div>
      <div className="provider-settings-section-head">
        <h3>{m.hostingSecret}</h3>
        <span className={`provider-settings-key-status${hasSecret ? ' is-configured' : ''}`}>{hasSecret ? m.settingsConfigured : m.settingsNotConfigured}</span>
      </div>
      <p className="provider-settings-hint">{m.hostingSecretStorage}</p>
      {!base ? <p id={`${id}-save-first`} className="provider-settings-hint">{m.hostingSaveBeforeSecret}</p> : null}
      <div className="provider-settings-key-entry">
        <div className="provider-settings-field">
          <label htmlFor={`${id}-secret`}>{m.hostingSecret}</label>
          <input ref={secretInput} id={`${id}-secret`} type="password" autoComplete="off" spellCheck={false} disabled={!base} aria-describedby={!base ? `${id}-save-first` : undefined} onInput={event => setSecretEntered(Boolean(event.currentTarget.value))} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); changeSecret() }
          }} />
        </div>
        <button type="button" disabled={!base || !secretEntered} onClick={() => changeSecret()}>{m.hostingSetSecret}</button>
        {hasSecret ? <button type="button" onClick={() => changeSecret(true)}>{m.hostingClearSecret}</button> : null}
      </div>
      <button type="button" disabled={dirty || secretEntered} onClick={() => void act(async () => setTest(await rpc.call<MethodResult<'hosting.test'>>('hosting.test')))}>{m.hostingTest}</button>
      {secretEntered ? <p className="provider-settings-hint">{m.hostingSaveSecretBeforeTest}</p> : dirty ? <p className="provider-settings-hint">{m.hostingSaveBeforeTest}</p> : null}
    </fieldset>
    {failed ? <p role="alert" className="provider-settings-error">{m.hostingOperationFailed}</p> : null}
    <p role="status">{busy ? m.settingsSaving : test ? test.ok ? m.hostingTestPassed : m.hostingTestFailed(steps[test.step], test.reason === 'hosting.not_configured' ? m.hostingNotConfigured : m.hostingTestRetry) : status ? statuses[status] : ''}</p>
  </section>
}
