import { SkillContent, type LibrarySkill, type MethodParams, type MethodResult, type SkillDraft, type SkillView } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useId, useRef, useState } from 'react'
import { SkillCopyBadges } from '@vis/workbench-ui'
import { mySkillsMessages } from './messages'
import './my-skills.css'

type Rpc = { call<T = any>(method: string, params?: any): Promise<T>; onSkillsChanged?(listener: () => void): () => void }
type Editor = { draftId?: string; skillId?: string; revision: number; name: string; description: string; body: string }
const rid = () => `web-${crypto.randomUUID()}`

export function MySkills({ rpc, active, spaceId, onDirtyChange, onUsed, draftId }: { rpc: Rpc; active: boolean; spaceId?: string; onDirtyChange(dirty: boolean): void; onUsed?(): void; draftId?: string | undefined }) {
  const m = useMessages(mySkillsMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const prefix = useId()
  const [list, setList] = useState<MethodResult<'skill.libraryList'>>({ skills: [], drafts: [] })
  const [copies, setCopies] = useState<SkillView[]>([])
  const upload = useRef<HTMLInputElement>(null)
  const reads = useRef(0)
  const [pendingAuto, setPendingAuto] = useState<{ skillId: string; enabled: boolean } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [base, setBase] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [status, setStatus] = useState<'saved' | 'discarded' | 'used' | null>(null)
  const generation = useRef(0)
  const dirty = JSON.stringify(editor) !== JSON.stringify(base)
  const valid = editor && SkillContent.safeParse(editor).success
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  async function refresh() {
    const attempt = ++reads.current
    const [result, project] = await Promise.all([rpc.call<MethodResult<'skill.libraryList'>>('skill.libraryList', {}), spaceId ? rpc.call<MethodResult<'skill.list'>>('skill.list', { spaceId }) : Promise.resolve(null)])
    if (attempt !== reads.current) return
    setList(result); setCopies(project?.skills.filter(skill => skill.copy) ?? []); setLoaded(true)
  }
  useEffect(() => {
    if (!active) return
    let current = true
    void refresh().catch(error => { if (current) setError(error) })
    const unsubscribe = rpc.onSkillsChanged?.(() => { void refresh().catch(setError) })
    return () => { current = false; reads.current++; unsubscribe?.() }
  }, [active, rpc, spaceId])
  useEffect(() => {
    if (!draftId || editor?.draftId === draftId) return
    const draft = list.drafts.find(item => item.draftId === draftId)
    if (draft) openDraft(draft)
  }, [draftId, list.drafts])
  function edit(value: Editor) { setEditor(value); setStatus(null) }
  function canLeave() { return !dirty || window.confirm(m.leaveEdits) }
  function select(value: Editor | null) { generation.current++; setEditor(value); setBase(value); setError(null); setStatus(null) }
  function openDraft(draft: SkillDraft) {
    if (canLeave()) select({ draftId: draft.draftId, revision: draft.revision, name: draft.name, description: draft.description, body: draft.body })
  }
  async function openSkill(skill: LibrarySkill) {
    if (!canLeave()) return
    const attempt = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const value = await rpc.call<MethodResult<'skill.libraryGet'>>('skill.libraryGet', { skillId: skill.skillId })
      if (attempt === generation.current) select({ skillId: value.skillId, revision: value.revision, name: value.name, description: value.description, body: value.body })
    } catch (error) { setError(error) } finally { setBusy(false) }
  }
  async function save() {
    if (!editor || !valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const { revision, ...content } = editor
      const result = await rpc.call<MethodResult<'skill.librarySave'>>('skill.librarySave', { ...content, requestId: rid(), expectedRevision: revision } satisfies MethodParams<'skill.librarySave'>)
      select({ skillId: result.skillId, revision: result.revision, name: editor.name.trim(), description: editor.description.trim(), body: editor.body })
      setStatus('saved')
      await refresh()
    } catch (error) { setError(error) } finally { setBusy(false) }
  }
  async function discard() {
    if (!editor || busy) return
    if (editor.draftId && !window.confirm(m.discardConfirm)) return
    setBusy(true)
    setError(null)
    try {
      if (editor.draftId) await rpc.call('skill.discardDraft', { draftId: editor.draftId, expectedRevision: editor.revision })
      select(null)
      setStatus('discarded')
      await refresh()
    } catch (error) { setError(error) } finally { setBusy(false) }
  }
  async function use(skill: LibrarySkill) {
    if (!spaceId || busy) return
    setBusy(true)
    setError(null)
    try {
      await rpc.call('skill.use', { requestId: rid(), spaceId, skillId: skill.skillId, version: skill.version })
      await refresh()
      setStatus('used')
      onUsed?.()
    } catch (error) { setError(error) } finally { setBusy(false) }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(null)
    try { await action(); await refresh(); onUsed?.() } catch (error) { setError(error) } finally { setBusy(false) }
  }
  async function mutateCopy(skill: SkillView, method: 'copyUpdate' | 'copyReset' | 'copyPublish') {
    if (!spaceId || !skill.copy) return
    if (method !== 'copyPublish' && skill.copy.edited && !window.confirm(m.replaceConfirm)) return
    const entry = list.skills.find(entry => entry.skillId === skill.copy!.skillId)
    await run(async () => { await rpc.call(`skill.${method}`, { requestId: rid(), spaceId, path: skill.path, expectedHash: skill.copy!.currentHash, ...(entry ? { expectedRevision: entry.revision } : {}) }) })
  }
  async function importFiles(files: File[]) {
    await run(async () => {
      const values = await Promise.all(files.map(async file => ({ filename: file.name, content: await file.text() })))
      await rpc.call('skill.importDrafts', { requestId: rid(), files: values })
    })
  }
  async function download(skill: LibrarySkill) {
    await run(async () => {
      const result = await rpc.call<MethodResult<'skill.export'>>('skill.export', { skillId: skill.skillId })
      const url = URL.createObjectURL(new Blob([result.content], { type: 'text/markdown;charset=utf-8' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  const row = (skill: LibrarySkill) => <li key={skill.skillId}>
    <button type="button" className="my-skills-open" disabled={busy} aria-label={m.editName(skill.name)} onClick={() => { void openSkill(skill) }}><strong>{skill.name}</strong><span>{skill.description}</span></button>
    <label className="my-skills-auto"><input type="checkbox" disabled={busy} checked={pendingAuto?.skillId === skill.skillId ? pendingAuto.enabled : skill.addToNewProjects} aria-label={m.autoName(skill.name)} onChange={event => { const enabled = event.currentTarget.checked; setPendingAuto({ skillId: skill.skillId, enabled }); void run(async () => { await rpc.call('skill.setAutoAdd', { skillId: skill.skillId, expectedRevision: skill.revision, enabled }) }).finally(() => setPendingAuto(null)) }} />{m.auto}</label>
    <button type="button" disabled={busy} aria-label={m.exportName(skill.name)} onClick={() => { void download(skill) }}>{m.export}</button>
    <button type="button" disabled={busy} aria-label={m.deleteName(skill.name)} onClick={() => { if (window.confirm(m.deleteConfirm)) void run(async () => { await rpc.call('skill.libraryDelete', { skillId: skill.skillId, expectedRevision: skill.revision }) }) }}>{m.delete}</button>
    <button type="button" disabled={busy || !spaceId || dirty} aria-label={m.useName(skill.name)} onClick={() => { void use(skill) }}>{m.use}</button>
  </li>
  return <section hidden={!active} className="my-skills" aria-label={m.title}>
    <header><h2>{m.title}</h2><button type="button" disabled={busy} onClick={() => { void refresh().catch(setError) }}>{m.refresh}</button>{editor ? <button type="button" disabled={busy} onClick={() => { if (canLeave()) select(null) }}>{m.back}</button> : null}</header>
    <p className="provider-settings-hint">{m.hint}</p>
    {error ? <p role="alert" className="provider-settings-error">{describeError(error, locale)} <button type="button" disabled={busy} onClick={() => { void refresh().then(() => setError(null), setError) }}>{m.refresh}</button></p> : null}
    {status ? <p role="status">{m[status]}</p> : null}
    {!loaded ? <p role="status">{m.loading}</p> : null}
    {editor ? <div className="my-skills-editor">
      <h3>{editor.draftId ? m.draftTitle : m.editTitle}</h3>
      <p className="provider-settings-hint">{editor.draftId ? m.draftHint : m.editHint}</p>
      <fieldset disabled={busy}>
        <label htmlFor={`${prefix}-name`}>{m.name}</label>
        <input id={`${prefix}-name`} value={editor.name} maxLength={64} onChange={event => edit({ ...editor, name: event.currentTarget.value })} />
        <label htmlFor={`${prefix}-description`}>{m.description}</label>
        <textarea id={`${prefix}-description`} rows={2} value={editor.description} maxLength={4000} onChange={event => edit({ ...editor, description: event.currentTarget.value })} />
        <label htmlFor={`${prefix}-body`}>{m.body}</label>
        <textarea id={`${prefix}-body`} className="my-skills-body" rows={12} value={editor.body} maxLength={1024 * 1024} spellCheck={false} onChange={event => edit({ ...editor, body: event.currentTarget.value })} />
      </fieldset>
      {!valid ? <p className="provider-settings-hint">{m.invalid}</p> : null}
      <div className="my-skills-actions"><button type="button" className="is-primary" disabled={busy || !valid || (!editor.draftId && !dirty)} onClick={() => { void save() }}>{m.save}</button><button type="button" disabled={busy} onClick={() => { void discard() }}>{editor.draftId ? m.discard : m.discardEdits}</button></div>
    </div> : loaded ? <>
      {list.drafts.length ? <><h3>{m.drafts(format.number(list.drafts.length))}</h3><ul aria-label={m.draftList}>{list.drafts.map(draft => <li key={draft.draftId}><button type="button" className="my-skills-open" disabled={busy} aria-label={m.editDraft(draft.name)} onClick={() => openDraft(draft)}><strong>{draft.name}<small>{m.draftBadge}</small></strong><span>{draft.description}</span></button></li>)}</ul></> : null}
      <h3>{m.savedList(format.number(list.skills.length))}</h3>
      {!list.skills.length ? <p className="my-skills-empty">{m.empty}</p> : <ul aria-label={m.title}>{list.skills.map(row)}</ul>}
      {!spaceId ? <p className="provider-settings-hint">{m.chooseProject}</p> : null}
      <button type="button" disabled={busy} onClick={() => upload.current?.click()}>{m.import}</button>
      <p className="provider-settings-hint">{m.importHint}</p>
      <input ref={upload} type="file" accept=".md" multiple hidden aria-label={m.importFiles} onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; if (files.length) void importFiles(files) }} />
      {spaceId ? <><h3>{m.projectCopies}</h3><ul aria-label={m.projectCopies}>{copies.map(skill => <li key={skill.path}><div className="my-skills-open"><strong>{skill.name}</strong><span>{skill.description}</span><SkillCopyBadges copy={skill.copy} /></div><div className="my-skills-actions">
        <button type="button" disabled={busy || !skill.copy?.newer || skill.copy?.missing} aria-label={m.updateName(skill.name)} onClick={() => { void mutateCopy(skill, 'copyUpdate') }}>{m.update}</button>
        <button type="button" disabled={busy || !skill.copy?.edited} aria-label={m.resetName(skill.name)} onClick={() => { void mutateCopy(skill, 'copyReset') }}>{m.reset}</button>
        <button type="button" disabled={busy || !skill.copy?.edited || skill.copy?.missing} aria-label={m.publishName(skill.name)} onClick={() => { void mutateCopy(skill, 'copyPublish') }}>{m.publish}</button>
      </div></li>)}</ul></> : null}
    </> : null}
  </section>
}
