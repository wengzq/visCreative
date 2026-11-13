import { CloseIcon, IconButton, describeError, type Locale, messagesFor, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { defaultParams, schemaFields as parameterFields, type ProviderCatalog } from '@vis/canvas-ui'
import { isBuiltinProviderType as isBuiltin, isSceneInputModel, type ProviderConfig, ProviderConfigSchema, type WorkSlotsView } from '@vis/protocol'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { MySkills } from './MySkills'
import { MediaHostingSettings } from './MediaHostingSettings'
import { mySkillsMessages } from './messages'
import { RecentlyDeleted } from './RecentlyDeleted'
import { settingsMessages } from './messages'
import { localizedProvider } from './providerLabels'
import './provider-settings.css'

type Provider = ProviderConfig['providers'][number]
type Kind = 'image' | 'video' | 'audio'
type Props = {
  catalog: ProviderCatalog
  localePreference: Locale | null
  onLocaleChange(locale: Locale | null): Promise<void>
  slots?: WorkSlotsView
  projects?: { spaceId: string; name: string }[]
  spaceId?: string
  onSkillsUsed?(): void
  draftId?: string | undefined
  initialSection?: 'guardrails' | 'mySkills' | 'hosting'
  rpc: { call<T = any>(method: string, params?: any): Promise<T>; onSkillsChanged?(listener: () => void): () => void; onProvidersChanged?(listener: () => void): () => void }
  onClose(): void
  onUpdated(catalog: ProviderCatalog): void
  onProjectsChanged?(): Promise<void>
  onProjectNotice?(text: string): void
}

function configuration(catalog: ProviderCatalog): ProviderConfig {
  return {
    providers: catalog.providers.filter(provider => !isBuiltin(provider.type)).map(provider => ({
      id: provider.id,
      type: provider.type,
      label: provider.label,
      baseUrl: provider.baseUrl ?? '',
      ...(provider.region !== undefined ? { region: provider.region } : {}),
      ...(provider.settings !== undefined ? { settings: provider.settings } : {}),
      ...(provider.endpoints !== undefined ? { endpoints: provider.endpoints } : {}),
      imageModels: provider.models.filter(model => model.kind === 'image').map(({ id, label }) => ({ id, label })),
      videoModels: provider.models.filter(model => model.kind === 'video').map(({ id, label }) => ({ id, label })),
      audioModels: provider.models.filter(model => model.kind === 'audio').map(({ id, label }) => ({ id, label })),
    })),
    defaults: { ...catalog.defaults },
    limits: { ...catalog.limits },
  }
}

function safeError(error: unknown, fallback: string, locale: Locale, hidden: string, secret = '') {
  let message = describeError(error instanceof Error || (error && typeof error === 'object' && 'message' in error) ? error : new Error(fallback), locale)
  if (secret) {
    message = message.replaceAll(secret, hidden)
    try { message = message.replaceAll(encodeURIComponent(secret), hidden) } catch { /* Invalid Unicode has no corresponding URL encoding */ }
  }
  return message.replace(/\bBearer\s+[^\s"'<>]+/gi, `Bearer ${hidden}`)
}

export function ProviderSettings({ catalog, localePreference, onLocaleChange, slots, projects = [], spaceId, onSkillsUsed, initialSection, draftId, rpc, onClose, onUpdated, onProjectsChanged, onProjectNotice }: Props) {
  const m = useMessages(settingsMessages)
  const skillMessages = useMessages(mySkillsMessages)
  const [skillsDirty, setSkillsDirty] = useState(false)
  const [hostingDirty, setHostingDirty] = useState(false)
  const { locale, setLocale } = useLocale()
  const format = useFormat()
  const kindLabel = { image: m.settingsImage, video: m.settingsVideo, audio: m.settingsAudio }
  const [languagePreference, setLanguagePreference] = useState(localePreference)
  const [languageBusy, setLanguageBusy] = useState(false)
  const [languageError, setLanguageError] = useState<unknown>(null)
  useEffect(() => { setLanguagePreference(localePreference) }, [localePreference])
  async function changeLanguage(next: Locale | null) {
    if (languageBusy) return
    const previous = languagePreference
    setLanguagePreference(next)
    setLocale(next)
    setLanguageBusy(true)
    setLanguageError(null)
    try { await onLocaleChange(next) }
    catch (error) {
      setLanguagePreference(previous)
      setLocale(previous)
      setLanguageError(error)
    } finally { setLanguageBusy(false) }
  }
  const dialog = useRef<HTMLDialogElement>(null)
  const keyInput = useRef<HTMLInputElement>(null)
  const prefix = useId()
  const addButton = useRef<HTMLButtonElement>(null)
  const chooser = useRef<HTMLDivElement>(null)
  const [choosingType, setChoosingType] = useState(false)
  const text = (value: Record<'zh' | 'en', string>) => value[locale === 'zh-CN' ? 'zh' : 'en']
  useEffect(() => { if (choosingType) chooser.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [choosingType])
  const [knownCatalog, setKnownCatalog] = useState(catalog)
  const currentCatalog = useRef(knownCatalog)
  currentCatalog.current = knownCatalog
  const [base, setBase] = useState(() => configuration(catalog))
  const [draft, setDraft] = useState(() => configuration(catalog))
  const [latest, setLatest] = useState<ProviderCatalog | null>(null)
  const [selectedId, setSelectedId] = useState(catalog.providers[0]?.id ?? '')
  const [section, setSection] = useState<'providers' | 'defaults' | 'guardrails' | 'recentlyDeleted' | 'general' | 'appearance' | 'mySkills' | 'hosting'>(initialSection ?? 'providers')
  const [knownSlots, setKnownSlots] = useState(slots)
  const [slotLimits, setSlotLimits] = useState<Record<string, number | null>>({})
  const [keyEntered, setKeyEntered] = useState(false)
  const [busy, setBusy] = useState<'config' | 'key' | 'slots' | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState<{ key: 'settingsSaveFailed' | 'settingsSlotSaveFailed' | 'settingsKeyClearFailed' | 'settingsKeySaveFailed'; details: Record<Locale, string> } | 'slotInvalid' | null>(null)
  const [status, setStatus] = useState<'settingsSaved' | 'settingsSlotSaved' | 'settingsKeyCleared' | 'settingsKeySaved' | 'settingsLoaded' | null>(null)
  function reportError(key: 'settingsSaveFailed' | 'settingsSlotSaveFailed' | 'settingsKeyClearFailed' | 'settingsKeySaveFailed', error: unknown, secret = '') {
    const detail = (locale: Locale) => {
      const texts = messagesFor(settingsMessages, locale)
      return safeError(error, key === 'settingsKeyClearFailed' || key === 'settingsKeySaveFailed' ? texts.settingsKeyRetry : texts.settingsConnectionRetry, locale, texts.settingsHidden, secret)
    }
    setError({ key, details: { 'zh-CN': detail('zh-CN'), en: detail('en') } })
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)
  const slotsDirty = Object.keys(slotLimits).length > 0
  const validation = ProviderConfigSchema.safeParse(draft)
  const errors: Record<string, string> = {}
  if (attempted && !validation.success) {
    for (const issue of validation.error.issues) {
      const path = issue.path.join('.')
      errors[path] ??= path.includes('.endpoints.') ? m.settingsEndpointPolicy : path.startsWith('limits.') ? m.settingsNonnegative : issue.code === 'too_small' ? m.settingsRequired : locale === 'zh-CN' ? issue.message : path.endsWith('.baseUrl') ? m.settingsUrlPolicy : path.startsWith('defaults.') ? m.settingsDefaultPolicy : issue.code === 'custom' && path.includes('Models.') ? m.settingsDuplicateModel : m.settingsInvalidField
    }
  }

  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement
    element.showModal()
    return () => {
      if (keyInput.current) keyInput.current.value = ''
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const next = configuration(catalog)
    setKnownCatalog(catalog)
    if (JSON.stringify(next) === JSON.stringify(base)) {
      setLatest(null)
    } else if (dirty || keyEntered) {
      setLatest(catalog)
    } else {
      setBase(next)
      setDraft(next)
      setLatest(null)
    }
  }, [catalog])

  useEffect(() => { setKnownSlots(slots) }, [slots])

  const builtins = knownCatalog.providers.filter(provider => isBuiltin(provider.type)).map(provider => localizedProvider(provider, locale))
  const providerIndex = draft.providers.findIndex(provider => provider.id === selectedId)
  const provider = draft.providers[providerIndex]
  const builtin = builtins.find(provider => provider.id === selectedId)
  const savedProvider = knownCatalog.providers.find(provider => provider.id === selectedId && !isBuiltin(provider.type))
  const descriptor = knownCatalog.providerTypes.find(type => type.type === provider?.type)
  const readOnly = Boolean(provider && (!descriptor || savedProvider?.available === false))
  const region = provider?.region ?? descriptor?.regions.find(region => region.baseUrl === provider?.baseUrl)?.id ?? 'custom'
  function serviceStatus(entry: { id: string; type: string }) {
    if (isBuiltin(entry.type)) return 'configured'
    const type = knownCatalog.providerTypes.find(type => type.type === entry.type)
    const saved = knownCatalog.providers.find(item => item.id === entry.id)
    return !type || saved?.available === false ? 'unavailable' : type.needsKey && !saved?.hasKey ? 'keyMissing' : 'configured'
  }
  const statusLabel = { configured: m.settingsConfigured, keyMissing: m.settingsNotConfigured, unavailable: m.settingsUnavailable }
  const fieldPath = `providers.${providerIndex}`
  const fieldError = (path: string) => errors[path]
    ? <span className="provider-settings-error" id={`${prefix}-${path}`}>{errors[path]}</span>
    : null
  const errorProps = (path: string) => ({ 'aria-invalid': Boolean(errors[path]), 'aria-describedby': errors[path] ? `${prefix}-${path}` : undefined })

  function clearInput() {
    if (keyInput.current) keyInput.current.value = ''
    setKeyEntered(false)
  }

  function close() {
    if (languageBusy) return
    if ((dirty || keyEntered || slotsDirty || skillsDirty || hostingDirty) && !window.confirm(m.settingsDiscard)) return
    clearInput()
    onClose()
  }

  function select(id: string) {
    clearInput()
    setSection('providers')
    setSelectedId(id)
    setError(null)
    setStatus(null)
  }

  function edit(next: Provider) {
    setDraft(current => {
      const defaults = { ...current.defaults }
      for (const kind of ['image', 'video', 'audio'] as const) {
        const selected = defaults[kind]
        if (selected?.provider === next.id && !next[`${kind}Models`].some(model => model.id === selected.model)) delete defaults[kind]
      }
      return { ...current, providers: current.providers.map(provider => provider.id === next.id ? next : provider), defaults }
    })
    setStatus(null)
  }

  function closeChooser() {
    setChoosingType(false)
    addButton.current?.focus()
  }

  function add(type: ProviderCatalog['providerTypes'][number]) {
    const first = type.regions[0]
    const next: Provider = { id: `${type.type}-${crypto.randomUUID()}`, type: type.type, label: text(type.label), baseUrl: first?.baseUrl ?? '', ...(first ? { region: first.id } : {}), ...(type.settingsSchema ? { settings: defaultParams(type.settingsSchema) } : {}), imageModels: [], videoModels: [], audioModels: [] }
    setDraft(current => ({ ...current, providers: [...current.providers, next] }))
    select(next.id)
    closeChooser()
  }

  function remove() {
    if (!provider || !window.confirm(m.settingsRemoveProvider(provider.label))) return
    setDraft(current => {
      const defaults = { ...current.defaults }
      for (const kind of ['image', 'video', 'audio'] as const) if (defaults[kind]?.provider === provider.id) delete defaults[kind]
      return { ...current, providers: current.providers.filter(item => item.id !== provider.id), defaults }
    })
    select(builtins[0]?.id ?? draft.providers.find(item => item.id !== provider.id)?.id ?? '')
  }

  function accept(result: ProviderCatalog) {
    const next = configuration(result)
    setBase(next)
    setDraft(next)
    setKnownCatalog(result)
    setLatest(null)
    setAttempted(false)
    onUpdated(result)
  }

  async function save() {
    setAttempted(true)
    setError(null)
    setStatus(null)
    if (busy) return
    if (!validation.success) {
      const issue = validation.error.issues[0]
      if (issue?.path[0] === 'limits') setSection('guardrails')
      if (issue?.path[0] === 'defaults') setSection('defaults')
      if (issue?.path[0] === 'providers' && typeof issue.path[1] === 'number') {
        const invalid = draft.providers[issue.path[1]]
        if (invalid) select(invalid.id)
      }
      requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    if (latest && !window.confirm(m.settingsOverwrite)) return
    setBusy('config')
    try {
      accept(await rpc.call<ProviderCatalog>('providers.update', { config: validation.data }))
      setStatus('settingsSaved')
    } catch (error) {
      reportError('settingsSaveFailed', error)
    } finally {
      setBusy(null)
    }
  }

  function savedSlotLimit(spaceId = '') {
    return spaceId ? knownSlots?.bySpace.find(space => space.spaceId === spaceId)?.limit ?? null : knownSlots!.limit
  }

  async function saveSlotLimit(spaceId = '') {
    if (busy || !Object.hasOwn(slotLimits, spaceId)) return
    const limit = slotLimits[spaceId]!
    if ((limit === null && !spaceId) || (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 32))) {
      setError('slotInvalid')
      return
    }
    setBusy('slots')
    setError(null)
    setStatus(null)
    try {
      setKnownSlots(await rpc.call<WorkSlotsView>('work.setSlotLimit', { ...(spaceId ? { spaceId } : {}), limit }))
      setSlotLimits(current => {
        const next = { ...current }
        delete next[spaceId]
        return next
      })
      setStatus('settingsSlotSaved')
    } catch (error) {
      reportError('settingsSlotSaveFailed', error)
    } finally {
      setBusy(null)
    }
  }

  function slotLimitField(label: string, spaceId = '') {
    const limit = Object.hasOwn(slotLimits, spaceId) ? slotLimits[spaceId]! : savedSlotLimit(spaceId)
    const invalid = limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 32)
    return <div className="provider-settings-key-entry" key={spaceId}>
      <div className="provider-settings-field">
        <label htmlFor={`${prefix}-slot-${spaceId}`}>{label}</label>
        <input id={`${prefix}-slot-${spaceId}`} type="number" min={1} max={32} step={1} required={!spaceId} placeholder={spaceId ? m.unlimited : undefined} disabled={Boolean(busy)} value={limit === null || Number.isNaN(limit) ? '' : limit} aria-invalid={invalid} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void saveSlotLimit(spaceId) }
        }} onChange={event => {
          const value = spaceId && event.currentTarget.value === '' && !event.currentTarget.validity.badInput ? null : event.currentTarget.valueAsNumber
          setSlotLimits(current => {
            const next = { ...current }
            if (value === savedSlotLimit(spaceId)) delete next[spaceId]
            else next[spaceId] = value
            return next
          })
          setStatus(null)
        }} />
      </div>
      <button type="button" aria-label={m.settingsSaveLabel(label)} disabled={Boolean(busy) || !Object.hasOwn(slotLimits, spaceId)} onClick={() => void saveSlotLimit(spaceId)}>{m.save}</button>
    </div>
  }

  async function changeKey(clear = false) {
    if (!savedProvider || busy) return
    if (clear && !window.confirm(m.settingsClearKeyConfirm)) return
    const apiKey = keyInput.current?.value.trim() ?? ''
    clearInput()
    if (!clear && !apiKey) return
    setError(null)
    setStatus(null)
    setBusy('key')
    try {
      const result = await rpc.call<{ providerId: string; hasKey: boolean }>(clear ? 'providers.clearKey' : 'providers.setKey', clear
        ? { providerId: savedProvider.id }
        : { providerId: savedProvider.id, apiKey })
      const catalog = currentCatalog.current
      const next = { ...catalog, providers: catalog.providers.map(provider => provider.id === result.providerId ? { ...provider, hasKey: result.hasKey } : provider) }
      setKnownCatalog(next)
      onUpdated(next)
      setStatus(clear ? 'settingsKeyCleared' : 'settingsKeySaved')
    } catch (error) {
      reportError(clear ? 'settingsKeyClearFailed' : 'settingsKeySaveFailed', error, apiKey)
    } finally {
      setBusy(null)
    }
  }

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation()
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length)
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  function defaults(kind: Kind) {
    const groups = [
      ...builtins.map(provider => ({ id: provider.id, label: provider.label, models: provider.models.filter(model => model.kind === kind && !isSceneInputModel(provider.id, model.id)), keyMissing: false })),
      ...draft.providers.filter(provider => serviceStatus(provider) !== 'unavailable').map(provider => ({ id: provider.id, label: provider.label, models: provider[`${kind}Models`], keyMissing: serviceStatus(provider) === 'keyMissing' })),
    ].filter(group => group.models.length)
    const selected = draft.defaults[kind]
    return (
      <div className="provider-settings-field" key={kind}>
        <label htmlFor={`${prefix}-default-${kind}`}>{m.settingsDefaultModel(kindLabel[kind])}</label>
        <select id={`${prefix}-default-${kind}`} disabled={Boolean(busy)} value={selected ? JSON.stringify([selected.provider, selected.model]) : ''} {...errorProps(`defaults.${kind}`)} onChange={event => {
          const value = event.currentTarget.value
          const choice = groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id }))).find(choice => JSON.stringify([choice.provider, choice.model]) === value)
          setDraft(current => {
            const defaults = { ...current.defaults }
            if (choice) defaults[kind] = choice
            else delete defaults[kind]
            return { ...current, defaults }
          })
          setStatus(null)
        }}>
          <option value="">{kind === 'audio' ? m.settingsBuiltinDefaultMock : m.settingsBuiltinDefault}</option>
          {groups.map(group => <optgroup key={group.id} label={group.label}>{group.models.map((model, index) => <option key={index} value={JSON.stringify([group.id, model.id])}>{model.label || model.id || m.settingsUnnamedModel}{group.keyMissing ? m.settingsMissingKeySuffix : ''}</option>)}</optgroup>)}
        </select>
        {fieldError(`defaults.${kind}`)}
      </div>
    )
  }

  return (
    <dialog ref={dialog} className="vis-dialog provider-settings" aria-label={m.settingsTitle} onCancel={event => { event.preventDefault(); if (choosingType) closeChooser(); else close() }} onKeyDown={trapFocus} onClick={event => { if (event.target === event.currentTarget && !dirty && !keyEntered && !slotsDirty && !skillsDirty && !hostingDirty) close() }}>
      <form noValidate onSubmit={event => { event.preventDefault(); if (section !== 'mySkills' && section !== 'hosting') void save() }}>
        <header className="vis-dialog-header provider-settings-header">
          <h1 id={`${prefix}-title`}>{section === 'providers' || section === 'defaults' ? m.settingsProviders : m.settingsTitle}</h1>
          <IconButton type="button" label={m.settingsClose} disabled={languageBusy} onClick={close}><CloseIcon /></IconButton>
        </header>
        {latest ? <div className="provider-settings-update" role="status">
          <span>{m.settingsUpdatedElsewhere}</span>
          <button type="button" disabled={Boolean(busy)} onClick={() => {
            if ((dirty || keyEntered) && !window.confirm(m.settingsLoadConfirm)) return
            clearInput()
            accept(latest)
            setError(null)
            setStatus('settingsLoaded')
          }}>{m.settingsLoadLatest}</button>
        </div> : null}
        <div className="provider-settings-body">
          <nav className="provider-settings-list" aria-label={m.settingsProviders} onClick={event => { if (!addButton.current?.contains(event.target as Node)) setChoosingType(false) }}>
            <h2>{m.settingsGeneral}</h2>
            <button type="button" aria-pressed={section === 'general'} className={section === 'general' ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => {
              clearInput()
              setSection('general')
              setError(null)
              setStatus(null)
            }}>{m.settingsLanguage}</button>
            <button type="button" aria-pressed={section === 'appearance'} className={section === 'appearance' ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => {
              clearInput()
              setSection('appearance')
              setError(null)
              setStatus(null)
            }}>{m.settingsAppearance}</button>
            <button type="button" aria-pressed={section === 'guardrails'} className={section === 'guardrails' ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => {
              clearInput()
              setSection('guardrails')
              setError(null)
              setStatus(null)
            }}>{m.settingsGuardrails}</button>
            <button type="button" aria-pressed={section === 'mySkills'} className={section === 'mySkills' ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => { clearInput(); setSection('mySkills'); setError(null); setStatus(null) }}>{skillMessages.title}</button>
            <h2>{m.settingsProviders}</h2>
            {[...builtins, ...draft.providers].map(provider => <button type="button" key={provider.id} aria-pressed={section === 'providers' && selectedId === provider.id} className={section === 'providers' && selectedId === provider.id ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => select(provider.id)}>
              <span>{provider.label || m.settingsUnnamedProvider}{!isBuiltin(provider.type) ? <small className="provider-settings-type-label">{knownCatalog.providerTypes.find(type => type.type === provider.type) ? text(knownCatalog.providerTypes.find(type => type.type === provider.type)!.label) : provider.type}</small> : null}</span>
              <span className={`provider-settings-dot${serviceStatus(provider) === 'configured' ? ' is-configured' : ''}`} role="img" aria-label={statusLabel[serviceStatus(provider)]} />
            </button>)}
            <button ref={addButton} type="button" disabled={Boolean(busy)} aria-expanded={choosingType} onClick={() => setChoosingType(true)}>{m.settingsAddService}</button>
            <button type="button" aria-pressed={section === 'defaults'} className={section === 'defaults' ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => { clearInput(); setSection('defaults') }}>{m.settingsDefaultsLimits}</button>
            <button type="button" aria-pressed={section === 'hosting'} className={section === 'hosting' ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => { clearInput(); setSection('hosting') }}>{m.hostingTitle}</button>
            <h2>{m.settingsData}</h2>
            <button type="button" aria-pressed={section === 'recentlyDeleted'} className={section === 'recentlyDeleted' ? 'is-active' : ''} disabled={Boolean(busy)} onClick={() => {
              clearInput()
              setSection('recentlyDeleted')
              setError(null)
              setStatus(null)
            }}>{m.recentlyDeleted}</button>
          </nav>
          <div className="provider-settings-content">
            <div hidden={section !== 'hosting'}>
              <MediaHostingSettings active={section === 'hosting'} rpc={rpc} agentIsolation={knownCatalog.agentIsolation} onDirtyChange={setHostingDirty} onChanged={async () => {
                const next = await rpc.call<ProviderCatalog>('providers.list')
                setKnownCatalog(next)
                onUpdated(next)
              }} />
            </div>
            <MySkills draftId={draftId} rpc={rpc} active={section === 'mySkills'} {...(spaceId ? { spaceId } : {})} onDirtyChange={setSkillsDirty} {...(onSkillsUsed ? { onUsed: onSkillsUsed } : {})} />
            {section === 'general' ? <section aria-labelledby={`${prefix}-general-title`}>
              <h2 id={`${prefix}-general-title`}>{m.settingsGeneral}</h2>
              <div className="provider-settings-field">
                <label htmlFor={`${prefix}-language`}>{m.settingsLanguage}</label>
                <select id={`${prefix}-language`} disabled={languageBusy} value={languagePreference ?? 'system'} onChange={event => { void changeLanguage(event.currentTarget.value === 'system' ? null : event.currentTarget.value as Locale) }}>
                  <option value="system">{m.settingsFollowSystem}</option>
                  <option value="zh-CN">{m.settingsChinese}</option>
                  <option value="en">{m.settingsEnglish}</option>
                </select>
              </div>
              {languageBusy ? <p role="status">{m.settingsLanguageSaving}</p> : null}
              {languageError ? <p className="provider-settings-error" role="alert">{m.settingsLanguageError(describeError(languageError, locale))}</p> : null}
            </section> : null}
            {section === 'appearance' ? <p>{m.settingsAppearancePlaceholder}</p> : null}
            {section === 'recentlyDeleted' ? <RecentlyDeleted rpc={rpc} refreshKey={projects} onChanged={onProjectsChanged ?? (() => Promise.resolve())} notify={onProjectNotice ?? (() => {})} /> : null}
            <fieldset className="provider-settings-fields" hidden={section !== 'providers'} disabled={Boolean(busy)}>
              {provider ? <>
                <div className="provider-settings-section-head"><h2>{descriptor ? text(descriptor.label) : m.settingsUnavailable}</h2><button type="button" className="provider-settings-danger" onClick={remove}>{m.settingsRemoveService}</button></div>
                {readOnly ? <p role="status">{m.settingsUnavailableReadOnly(describeError({ message: m.settingsUnavailable, data: { reason: savedProvider?.unavailableReason ?? 'provider.type_unavailable', params: { type: provider.type } } }, locale))}</p> : null}
                <fieldset className="provider-settings-fields" disabled={readOnly}>
                <div className="provider-settings-provider-fields">
                  <div className="provider-settings-field">
                    <label htmlFor={`${prefix}-name`}>{m.settingsName}</label>
                    <input id={`${prefix}-name`} required value={provider.label} {...errorProps(`${fieldPath}.label`)} onChange={event => edit({ ...provider, label: event.currentTarget.value })} />
                    {fieldError(`${fieldPath}.label`)}
                  </div>
                  {descriptor ? <div className="provider-settings-field">
                    <label htmlFor={`${prefix}-region`}>{m.settingsRegion}</label>
                    <select id={`${prefix}-region`} value={region} onChange={event => {
                      const selected = descriptor.regions.find(region => region.id === event.currentTarget.value)
                      const { region: _region, endpoints: _endpoints, ...entry } = provider
                      edit({ ...entry, ...(selected ? { region: selected.id } : descriptor.endpoints?.length ? { endpoints: {} } : {}), baseUrl: selected?.baseUrl ?? '' })
                    }}>
                      {descriptor.regions.map(region => <option key={region.id} value={region.id}>{text(region.label)}</option>)}
                      {descriptor.allowCustomBaseUrl ? <option value="custom">{m.settingsCustomUrl}</option> : null}
                    </select>
                  </div> : null}
                  {region === 'custom' || !descriptor ? <div className="provider-settings-field">
                    <label htmlFor={`${prefix}-url`}>{m.settingsBaseUrl}</label>
                    <input id={`${prefix}-url`} type="url" required value={provider.baseUrl} spellCheck={false} {...errorProps(`${fieldPath}.baseUrl`)} onChange={event => edit({ ...provider, baseUrl: event.currentTarget.value })} />
                    {fieldError(`${fieldPath}.baseUrl`)}
                  </div> : null}
                </div>
                {region === 'custom' && descriptor?.endpoints?.length ? <div className="provider-settings-endpoints">
                  <h3>{m.settingsEndpoints}</h3>
                  <p className="provider-settings-hint">{m.settingsEndpointsHint}</p>
                  {descriptor.endpoints.map(endpoint => <div className="provider-settings-field" key={endpoint.id}>
                    <label htmlFor={`${prefix}-endpoint-${endpoint.id}`}>{text(endpoint.label)}</label>
                    <input id={`${prefix}-endpoint-${endpoint.id}`} value={provider.endpoints ? provider.endpoints[endpoint.id] ?? '' : endpoint.path} placeholder={m.settingsEndpointExample(endpoint.path)} spellCheck={false} {...errorProps(`${fieldPath}.endpoints.${endpoint.id}`)} onChange={event => {
                      // A custom URL saved before paths existed relies on the declared ones; keep them when its first path changes.
                      const current = provider.endpoints ?? Object.fromEntries(descriptor.endpoints!.map(({ id, path }) => [id, path]))
                      const { [endpoint.id]: _previous, ...others } = current
                      const value = event.currentTarget.value.trim()
                      edit({ ...provider, endpoints: value ? { ...others, [endpoint.id]: value } : others })
                    }} />
                    {fieldError(`${fieldPath}.endpoints.${endpoint.id}`)}
                  </div>)}
                </div> : null}
                {descriptor?.settingsSchema ? parameterFields(descriptor.settingsSchema).map(([key, field]) => {
                  const value = provider.settings?.[key] ?? field.default
                  const update = (value: unknown) => edit({ ...provider, settings: { ...provider.settings, [key]: value } })
                  const copy = descriptor.settingsFields?.[key]
                  const description = copy?.description ? text(copy.description) : field.description
                  return <div className="provider-settings-field" key={key}>
                    <label htmlFor={`${prefix}-setting-${key}`}>{copy ? text(copy.label) : field.title ?? field.description ?? key}</label>
                    {field.enum ? <select id={`${prefix}-setting-${key}`} value={String(value ?? '')} onChange={event => update(field.enum!.find(value => String(value) === event.currentTarget.value))}>
                      {value === undefined ? <option value="" /> : null}
                      {field.enum.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
                    </select> : field.type === 'boolean' ? <input id={`${prefix}-setting-${key}`} type="checkbox" checked={Boolean(value)} onChange={event => update(event.currentTarget.checked)} />
                      : <input id={`${prefix}-setting-${key}`} type={field.type === 'string' ? 'text' : 'number'} min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : 'any'} value={String(value ?? '')} onChange={event => update(field.type === 'string' ? event.currentTarget.value : event.currentTarget.valueAsNumber)} />}
                    {description && (copy || field.title) ? <p className="provider-settings-hint">{description}</p> : null}
                  </div>
                }) : null}
                {descriptor?.needsKey ? <section className="provider-settings-key" aria-labelledby={`${prefix}-key-title`}>
                  <div className="provider-settings-section-head">
                    <h3 id={`${prefix}-key-title`}>{m.settingsServiceKey}</h3>
                    <span className={`provider-settings-key-status${savedProvider?.hasKey ? ' is-configured' : ''}`}>{savedProvider?.hasKey ? m.settingsConfigured : m.settingsNotConfigured}</span>
                  </div>
                  {knownCatalog.agentIsolation === 'none' ? <p className="provider-settings-isolation-notice">{m.settingsNoAgentIsolation}</p> : null}
                  <p className="provider-settings-hint">{savedProvider ? m.settingsKeyStorage : m.settingsSaveBeforeKey}</p>
                  <div className="provider-settings-key-entry">
                    <div className="provider-settings-field">
                      <label htmlFor={`${prefix}-key`}>{m.settingsApiKey}</label>
                      <input ref={keyInput} id={`${prefix}-key`} key={selectedId} type="password" autoComplete="off" spellCheck={false} disabled={!savedProvider} onInput={event => setKeyEntered(Boolean(event.currentTarget.value))} onKeyDown={event => {
                        if (event.key === 'Enter') { event.preventDefault(); void changeKey() }
                      }} />
                    </div>
                    <button type="button" disabled={!savedProvider || !keyEntered} onClick={() => void changeKey()}>{m.settingsSaveKey}</button>
                    {savedProvider?.hasKey ? <button type="button" onClick={() => void changeKey(true)}>{m.settingsClearKey}</button> : null}
                  </div>
                </section> : null}
                {descriptor ? <p className="provider-settings-hint">{text(descriptor.help.key)} <a href={descriptor.help.consoleUrl} target="_blank" rel="noreferrer noopener">{m.settingsConsole}</a></p> : null}
                {descriptor?.help.model ? <p className="provider-settings-hint">{text(descriptor.help.model)}</p> : null}
                {(descriptor?.kinds ?? ['image', 'video', 'audio'] as const).filter(kind => !readOnly || provider[`${kind}Models`].length > 0).map(kind => <fieldset className="provider-settings-models" key={kind}>
                  <legend>{m.settingsModels(kindLabel[kind])}</legend>
                  {!readOnly ? <div className="provider-settings-model-chips">{descriptor?.knownModels.filter(model => model.kind === kind && !provider[`${kind}Models`].some(added => added.id === model.id)).map(model => <button key={model.id} type="button" aria-label={m.settingsAddKnownModel(model.label)} onClick={() => edit({ ...provider, [`${kind}Models`]: [...provider[`${kind}Models`], { id: model.id, label: model.label }] })}>{m.settingsKnownModelChip(model.label)}</button>)}</div> : null}
                  {provider[`${kind}Models`].map((model, index) => <div className="provider-settings-model" key={index}>
                    <div className="provider-settings-field">
                      <label htmlFor={`${prefix}-${kind}-${index}-label`}>{m.settingsModelLabel}</label>
                      <input id={`${prefix}-${kind}-${index}-label`} required value={model.label} {...errorProps(`${fieldPath}.${kind}Models.${index}.label`)} onChange={event => edit({ ...provider, [`${kind}Models`]: provider[`${kind}Models`].map((item, i) => i === index ? { ...item, label: event.currentTarget.value } : item) })} />
                      {fieldError(`${fieldPath}.${kind}Models.${index}.label`)}
                    </div>
                    <div className="provider-settings-field">
                      <label htmlFor={`${prefix}-${kind}-${index}-id`}>{m.settingsModelId}</label>
                      <input id={`${prefix}-${kind}-${index}-id`} className="provider-settings-model-id" placeholder={m.settingsCustomModel} required value={model.id} spellCheck={false} {...errorProps(`${fieldPath}.${kind}Models.${index}.id`)} onChange={event => edit({ ...provider, [`${kind}Models`]: provider[`${kind}Models`].map((item, i) => i === index ? { ...item, id: event.currentTarget.value } : item) })} />
                      {fieldError(`${fieldPath}.${kind}Models.${index}.id`)}
                    </div>
                    {!readOnly ? <button type="button" aria-label={m.settingsRemoveModel(kindLabel[kind], model.label || format.number(index + 1))} onClick={() => edit({ ...provider, [`${kind}Models`]: provider[`${kind}Models`].filter((_, i) => i !== index) })}>{m.delete}</button> : null}
                  </div>)}
                  {!readOnly ? <button type="button" onClick={() => edit({ ...provider, [`${kind}Models`]: [...provider[`${kind}Models`], { id: '', label: '' }] })}>{m.settingsCustomModel}</button> : null}
                </fieldset>)}
                </fieldset>
              </> : builtin ? <section aria-labelledby={`${prefix}-builtin-title`}>
                <h2 id={`${prefix}-builtin-title`}>{builtin.label}</h2>
                <p className="provider-settings-hint">{m.settingsBuiltinHint}</p>
                {builtin.id === 'render' ? <p className="provider-settings-hint">{m.settingsRenderLibraries}</p> : null}
                {(['image', 'video', 'audio'] as const).map(kind => <div key={kind} className="provider-settings-builtin-models"><h3>{m.settingsModels(kindLabel[kind])}</h3>{builtin.models.filter(model => model.kind === kind).length
                  ? <ul>{builtin.models.filter(model => model.kind === kind).map(model => <li key={model.id}>{model.label}{model.label !== model.id ? <> <code>{model.id}</code></> : null}</li>)}</ul>
                  : <p className="provider-settings-hint">{m.settingsUnsupported(kindLabel[kind])}</p>}</div>)}
              </section> : <p className="provider-settings-hint">{m.settingsChooseProvider}</p>}
            </fieldset>
            {section === 'guardrails' || section === 'defaults' ? <section aria-labelledby={`${prefix}-guardrails-title`}>
              <h2 id={`${prefix}-guardrails-title`}>{section === 'defaults' ? m.settingsDefaultsLimits : m.settingsGuardrails}</h2>
              {knownCatalog.agentIsolation === 'none' ? <p className="provider-settings-isolation-notice">{m.settingsNoAgentIsolation}</p> : null}
              <h3 id={`${prefix}-limits-title`}>{m.settingsGenerationLimits}</h3>
              <p className="provider-settings-hint">{m.settingsAgentLimitsHint}</p>
              <p className="provider-settings-hint">{m.settingsConcurrentHint}</p>
              {([
                ['maxConcurrent', m.settingsMaxConcurrent], ['dailyImage', m.settingsDailyImage], ['dailyVideo', m.settingsDailyVideo], ['dailyAudio', m.settingsDailyAudio],
              ] as const).map(([key, label]) => <div className="provider-settings-field" key={key}>
                <label htmlFor={`${prefix}-${key}`}>{label}</label>
                <input id={`${prefix}-${key}`} type="number" min={0} step={1} required disabled={Boolean(busy)} value={Number.isNaN(draft.limits[key]) ? '' : draft.limits[key]} {...errorProps(`limits.${key}`)} onChange={event => {
                  const value = event.currentTarget.valueAsNumber
                  setDraft(current => ({ ...current, limits: { ...current.limits, [key]: value } }))
                  setStatus(null)
                }} />
                {fieldError(`limits.${key}`)}
              </div>)}
              {knownSlots ? <>
                <h3>{m.settingsSlotLimits}</h3>
                <p className="provider-settings-hint">{m.settingsSlotHint}</p>
                {slotLimitField(m.settingsGlobalLimit)}
                {projects.map(project => slotLimitField(m.settingsProjectLimit(project.name), project.spaceId))}
              </> : null}
            </section> : null}
          </div>
          {/* Outside the scrolling content, so the page underneath cannot scroll into view */}
          {choosingType ? <div ref={chooser} className="provider-settings-chooser" role="dialog" aria-modal="true" aria-label={m.settingsChooseType} onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeChooser() }
            if (event.key === 'Tab') {
              event.stopPropagation()
              const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
              if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
              else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
            }
            if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
              event.preventDefault()
              const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-provider-card]')]
              const index = cards.indexOf(document.activeElement as HTMLButtonElement)
              cards[(index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : cards.length - 1)) % cards.length]?.focus()
            }
          }}>
            <h2>{m.settingsChooseType}</h2>
            {knownCatalog.providerTypes.map(type => <button data-provider-card type="button" key={type.type} onClick={() => add(type)}>
              <strong>{text(type.label)}</strong><span>{type.kinds.map(kind => kindLabel[kind]).join(' · ')}</span>
              {type.availability ? <small>{text(type.availability)}</small> : null}
              {!type.verified ? <small className="provider-settings-unverified">{m.settingsUnverified}</small> : null}
            </button>)}
            <div className="provider-settings-chooser-actions"><button type="button" onClick={closeChooser}>{m.settingsChooserBack}</button></div>
          </div> : null}
        </div>
        <section className="provider-settings-defaults" hidden={section !== 'defaults' || choosingType} aria-labelledby={`${prefix}-defaults-title`}>
          <h3 id={`${prefix}-defaults-title`}>{m.settingsDefaultModels}</h3>
          {knownCatalog.unavailableDefaults?.length ? <p role="status">{m.settingsDefaultUnavailable}</p> : null}
          <div>{defaults('image')}{defaults('video')}{defaults('audio')}</div>
        </section>
        <div className="provider-settings-messages">
          {error ? <p className="provider-settings-error" role="alert">{error === 'slotInvalid' ? m.settingsSlotInvalid : m[error.key](error.details[locale])}</p> : null}
          {attempted && !validation.success ? <p className="provider-settings-error" role="alert">{m.settingsValidationError(draft.providers.some((_, index) => index !== providerIndex && Object.keys(errors).some(path => path.startsWith(`providers.${index}.`))))}</p> : null}
          <span role="status">{busy ? m.settingsSaving : (status ? m[status] : dirty || slotsDirty ? m.settingsUnsaved : '')}</span>
        </div>
        {/* Recently deleted actions take effect immediately without Save configuration */}
        {section === 'mySkills' || section === 'recentlyDeleted' || section === 'general' || section === 'appearance' || section === 'hosting' ? null : <footer className="vis-dialog-footer provider-settings-footer">
          <button type="button" disabled={languageBusy} onClick={close}>{m.cancel}</button>
          <button type="submit" className="is-primary" disabled={Boolean(busy) || !dirty}>{m.settingsSaveConfig}</button>
        </footer>}
      </form>
    </dialog>
  )
}
