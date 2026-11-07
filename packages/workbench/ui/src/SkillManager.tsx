import { CloseIcon, IconButton, ChevronDownIcon, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { SkillCopyBadges } from './SkillCopyBadges'
import { dialogMessages } from './messages'
import type { MethodParams, MethodResult, SkillProblem } from '@vis/protocol'
import { useModal, type ProjectOption } from './WorkspaceDialog'

export interface SkillManagerActions {
  list(spaceId?: string): Promise<MethodResult<'skill.list'>>
  projects(): Promise<ProjectOption[]>
  folder(): Promise<MethodResult<'skill.stage'> | undefined>
  upload(file: File): Promise<MethodResult<'skill.stage'>>
  stage(input: { fromSpaceId: string; names: string[] }): Promise<MethodResult<'skill.stage'>>
  import(input: MethodParams<'skill.import'>): Promise<MethodResult<'skill.import'>>
  discard(stagingId: string): Promise<void>
  remove(name: string): Promise<MethodResult<'skill.remove'>>
  reveal(): Promise<void>
  subscribe?(listener: () => void): () => void
  changed(): Promise<void>
  notice(text: string): void
}

function Problems({ items, title }: { items: SkillProblem[]; title: string }) {
  const m = useMessages(dialogMessages)
  const format = useFormat()
  const { locale } = useLocale()
  return items.length ? <details className="vis-dialog-skills"><summary>{m.problemCount(title, format.number(items.length))}</summary>{items.map((item, index) => <div className="vis-dialog-skill" key={index}><strong>{item.dir}</strong><span>{describeError({ message: item.error, data: { reason: item.reason, params: item.params } }, locale)}</span></div>)}</details> : null
}

export function SkillManager(p: { spaceId: string; importOpen: boolean; actions: SkillManagerActions; onClose(): void }) {
  const a = p.actions
  const m = useMessages(dialogMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [list, setList] = useState<MethodResult<'skill.list'>>({ skillsPath: '', skills: [], problems: [] })
  const [menu, setMenu] = useState(p.importOpen)
  const [stage, setStage] = useState<MethodResult<'skill.stage'> | null>(null)
  const [names, setNames] = useState<string[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [sourceSkills, setSourceSkills] = useState<MethodResult<'skill.list'>['skills']>([])
  const [sourceNames, setSourceNames] = useState<string[]>([])
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: 'chooseArchive' } | { error: unknown } | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const pending = useRef<string | null>(null)
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await action() } catch (error) { setError({ error }) }
    finally { setBusy(false) }
  }
  const close = () => {
    if (busy) return
    if (stage) void run(async () => { await a.discard(stage.stagingId); pending.current = null; setStage(null) })
    else if (removing) setRemoving(null)
    else if (source !== null) setSource(null)
    else p.onClose()
  }
  const modal = useModal(close, busy || stage !== null || source !== null)
  const discardFailed = useEffectEvent((error: unknown) => a.notice(m.discardFailed(describeError(error, locale))))
  useEffect(() => {
    let current = true
    a.list().then(result => { if (current) setList(result) }, error => { if (current) setError({ error }) })
    const unsubscribe = a.subscribe?.(() => { void a.list().then(result => { if (current) setList(result) }, error => { if (current) setError({ error }) }) })
    return () => { unsubscribe?.(); current = false; if (pending.current) void a.discard(pending.current).catch(discardFailed) }
  }, [a])
  const prepared = (result: MethodResult<'skill.stage'> | undefined) => {
    if (!result) return
    pending.current = result.stagingId
    setStage(result); setNames(result.candidates.filter(candidate => !candidate.exists).map(candidate => candidate.name)); setSource(null); setMenu(false)
  }
  const upload = (files: File[]) => void run(async () => {
    if (files.length !== 1 || !/\.(zip|skill)$/i.test(files[0]!.name)) { setError({ message: 'chooseArchive' }); return }
    prepared(await a.upload(files[0]!))
  })
  const toggle = (name: string, selected: string[], update: (names: string[]) => void) => update(selected.includes(name) ? selected.filter(item => item !== name) : [...selected, name])
  const replacing = stage?.candidates.some(candidate => candidate.exists && names.includes(candidate.name))
  const view = stage ? 'confirmImport' : removing ? 'removeSkill' : source !== null ? 'importFromProject' : 'projectSkills'
  const title = m[view]
  const sources = <><button disabled={busy} onClick={() => void run(async () => prepared(await a.folder()))}>{m.fromFolder}</button><button disabled={busy} onClick={() => file.current?.click()}>{m.fromArchive}</button><button disabled={busy} onClick={() => void run(async () => { setProjects((await a.projects()).filter(project => project.spaceId !== p.spaceId)); setSource(''); setSourceSkills([]); setSourceNames([]) })}>{m.fromOtherProject}</button></>
  const focusedView = useRef('')
  useEffect(() => {
    if (!busy && focusedView.current !== view) {
      modal.ref.current?.querySelector<HTMLButtonElement>('.vis-dialog-header button')?.focus()
      focusedView.current = view
    }
  }, [view, busy, modal.ref])
  return <dialog {...modal} aria-label={title} className="vis-dialog vis-workspace-dialog vis-skill-manager" onKeyDown={event => event.stopPropagation()} onDragOver={event => { event.preventDefault() }} onDrop={event => { event.preventDefault(); if (!busy && !stage && source === null && !removing) upload(Array.from(event.dataTransfer.files)) }}>
    <div className="vis-dialog-header"><h2>{title}</h2><IconButton label={m.close} disabled={busy} onClick={close}><CloseIcon /></IconButton></div>
    <div className="vis-dialog-body">{stage ? <>
      <p className="vis-skill-path">{stage.source}</p>
      <div className="vis-skill-manager-list">{stage.candidates.map(candidate => <label className="vis-skill-candidate" key={candidate.name}>
        <input type="checkbox" aria-label={candidate.name} checked={names.includes(candidate.name)} disabled={busy} onChange={() => toggle(candidate.name, names, setNames)} />
        <span><strong>{candidate.name}</strong>{candidate.exists ? <span className="vis-skill-badge">{m.skillExists}</span> : null}{candidate.executables.length ? <span className="vis-skill-badge" title={candidate.executables.join('\n')}>{m.containsScripts}</span> : null}<span className="vis-skill-description">{candidate.description}</span><small>{m.skillCandidateStats(format.number(candidate.fileCount), format.number(candidate.bytes))}</small></span>
      </label>)}</div>
      <Problems items={stage.skipped} title={m.skippedDirectories} />
      {!stage.candidates.length ? <p>{m.noImportableSkills}</p> : null}
      <div className="vis-dialog-actions"><button disabled={busy} onClick={close}>{stage.candidates.length ? m.cancel : m.close}</button>{stage.candidates.length ? <button className="is-primary" disabled={busy || !names.length} onClick={() => void run(async () => {
        const result = await a.import({ stagingId: stage.stagingId, names, replace: Boolean(replacing) })
        pending.current = null; setStage(null)
        a.notice(m.skillsImported(format.number(result.imported.length)))
        await a.changed(); setList(await a.list())
      })}>{replacing ? m.importAndReplace : m.importCount(format.number(names.length))}</button> : null}</div>
    </> : removing ? <>
      <p>{m.removeSkillPrompt(removing)}</p>
      <div className="vis-dialog-actions"><button disabled={busy} onClick={close}>{m.cancel}</button><button disabled={busy} onClick={() => void run(async () => {
        const result = await a.remove(removing)
        setRemoving(null); a.notice(m.skillRemoved(result.removedPath))
        await a.changed(); setList(await a.list())
      })}>{m.confirmRemoval}</button></div>
    </> : source !== null ? <>
      <label>{m.sourceProject}<select aria-label={m.sourceProject} disabled={busy} value={source} onChange={event => { const id = event.target.value; setSource(id); setSourceNames([]); setSourceSkills([]); if (id) void run(async () => setSourceSkills((await a.list(id)).skills)) }}><option value="">{m.selectProject}</option>{projects.map(project => <option key={project.spaceId} value={project.spaceId}>{project.name}</option>)}</select></label>
      {sourceSkills.map(skill => <label className="vis-skill-candidate" key={skill.name}><input type="checkbox" aria-label={skill.name} disabled={busy} checked={sourceNames.includes(skill.name)} onChange={() => toggle(skill.name, sourceNames, setSourceNames)} /><span><strong>{skill.name}</strong><span className="vis-skill-description">{skill.description}</span></span></label>)}
      {source && !busy && !sourceSkills.length ? <p>{m.noProjectSkills}</p> : null}
      <div className="vis-dialog-actions"><button disabled={busy} onClick={close}>{m.cancel}</button><button disabled={busy || !sourceNames.length} onClick={() => void run(async () => prepared(await a.stage({ fromSpaceId: source, names: sourceNames })))}>{m.next}</button></div>
    </> : <>
      <input ref={file} type="file" hidden accept=".zip,.skill" aria-label={m.skillArchive} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) upload(files) }} />
      {list.skills.length ? <div className="vis-skill-manager-head"><span>{m.skillCount(format.number(list.skills.length))}</span>
        <div className="vis-skill-import" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false) }}>
          <button aria-expanded={menu} disabled={busy} onClick={() => setMenu(!menu)}>{m.importMenu}<ChevronDownIcon /></button>
          {menu ? <div className="vis-skill-import-menu">{sources}</div> : null}
        </div>
      </div> : null}
      <div className="vis-skill-manager-list">{list.skills.map(skill => <div className="vis-skill-manager-row" key={skill.path}><div><strong>{skill.name}</strong><SkillCopyBadges copy={skill.copy} /><span className="vis-skill-description" title={skill.description}>{skill.description}</span></div><button disabled={busy} aria-label={m.removeSkillLabel(skill.name)} onClick={() => setRemoving(skill.name)}>{m.remove}</button></div>)}</div>
      {!list.skills.length ? <div className="vis-skill-empty-state">
        <strong>{m.noProjectSkills}</strong>
        <p>{m.archiveDropEmpty}</p>
        <div className="vis-skill-sources">{sources}</div>
      </div> : null}
      <Problems items={list.problems} title={m.unrecognizedDirectories} />
      <div className="vis-skill-manager-foot"><span>{list.skills.length ? m.archiveDropHint : null}</span><button className="vis-skill-reveal" title={list.skillsPath} disabled={busy} onClick={() => void run(a.reveal)}>{m.revealInFinder}</button></div>
    </>}
    {busy ? <p role="status">{m.processing}</p> : null}
    {error ? <div role="alert" className="vis-dialog-error">{'message' in error ? m[error.message] : describeError(error.error, locale)}</div> : null}
    </div>
  </dialog>
}
