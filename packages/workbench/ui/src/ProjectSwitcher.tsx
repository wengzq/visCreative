import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { AgentKind } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { ProjectDialog, type ProjectOption, type DirectoryPicker } from './WorkspaceDialog'
import { SessionIcon } from './SessionIcon'
import { sessionMessages } from './messages'
import './session.css'
import { groupProjects, type ProjectSeriesInput, type SeriesProjectHost } from './series-model'
import { SeriesProjectDialog } from './SeriesProjectDialog'
import { seriesProjectMessages } from './series-messages'

export type ProjectSwitcherProps = {
  projects: ProjectOption[]
  projectsDir: string
  projectId: string | null
  projectAttention?: ReadonlySet<string>
  seriesHost?: SeriesProjectHost
  onSelectProject(spaceId: string): Promise<void>
  onCreateProject(name: string, rootPath: string | undefined, agentKind: AgentKind | null, series?: ProjectSeriesInput): Promise<void>
  onDeleteProject?(spaceId: string): void
  onPickDirectory: DirectoryPicker
  onRevealProject(): void
}

function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
}

export function ProjectSwitcher(p: ProjectSwitcherProps) {
  const m = useMessages(sessionMessages)
  const seriesCopy = useMessages(seriesProjectMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [menuOpen, setMenuOpen] = useState(false)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'project' | null>(null)
  const [projectError, setProjectError] = useState<unknown>(null)
  const [seriesDialog, setSeriesDialog] = useState<{ project: ProjectOption; action: 'join' | 'leave' | 'episode' | 'delete' } | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    setProjectMenu(null)
    // Start on the current project, never on a series heading's delete action.
    const items = menu.current
    const start = items?.querySelector<HTMLButtonElement>('button[aria-current=true]') ?? items?.querySelector<HTMLButtonElement>('.vis-project-menu-choice > button') ?? items?.querySelector<HTMLButtonElement>('button')
    start?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !createButton.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [menuOpen])
  const project = p.projects.find(project => project.spaceId === p.projectId)
  const groups = groupProjects(p.projects)
  const seriesAction = (project: ProjectOption, action: 'join' | 'leave' | 'episode' | 'delete') => {
    setMenuOpen(false); setSeriesDialog({ project, action })
  }
  const projectRow = (item: ProjectOption) => <div key={item.spaceId} className="vis-project-menu-row" role="none">
    <div className="vis-project-menu-choice" role="none"><button role="menuitem" title={item.rootPath} aria-current={item.spaceId === p.projectId ? 'true' : undefined} onClick={() => { setMenuOpen(false); setProjectError(null); void p.onSelectProject(item.spaceId).catch(error => setProjectError(error)) }}>
      <strong>{item.series ? <small className="vis-project-episode">{seriesCopy.episodeLabel(format.number(item.series.episode))}</small> : null}{item.name} {p.projectAttention?.has(item.spaceId) ? <span className="vis-work-project-dot" aria-label={m.awaitingReply}>●</span> : null}</strong>
    </button>
      {p.onDeleteProject || p.seriesHost ? <button type="button" role="menuitem" className="vis-project-more" aria-label={m.projectMore(item.name)} aria-haspopup="menu" aria-expanded={projectMenu === item.spaceId} onClick={event => {
        const row = event.currentTarget.closest('.vis-project-menu-row')
        setProjectMenu(projectMenu === item.spaceId ? null : item.spaceId)
        if (projectMenu !== item.spaceId) requestAnimationFrame(() => row?.querySelector<HTMLButtonElement>('.vis-project-actions button')?.focus())
      }}>⋯</button> : null}
    </div>
    {projectMenu === item.spaceId ? <div role="menu" aria-label={m.projectActions(item.name)} className="vis-project-actions"><hr />
      {p.seriesHost ? item.series ? <>
        <button type="button" role="menuitem" onClick={() => seriesAction(item, 'episode')}>{seriesCopy.changeEpisode}</button>
        <button type="button" role="menuitem" onClick={() => seriesAction(item, 'leave')}>{seriesCopy.leave}</button>
      </> : <button type="button" role="menuitem" onClick={() => seriesAction(item, 'join')}>{seriesCopy.join}</button> : null}
      {p.onDeleteProject ? <button type="button" role="menuitem" className="vis-project-delete" onClick={() => { setMenuOpen(false); createButton.current?.focus(); p.onDeleteProject?.(item.spaceId) }}>{m.deleteProject}</button> : null}
    </div> : null}
  </div>
  return <>
    <div className="vis-project-switcher-wrap">
      <button ref={createButton} className="vis-project-switcher" aria-label={m.switchProject} aria-haspopup="menu" aria-expanded={menuOpen} title={project?.rootPath} onClick={() => setMenuOpen(value => !value)}>{project?.name ?? m.chooseProject} {p.projects.some(item => item.spaceId !== p.projectId && p.projectAttention?.has(item.spaceId)) ? <span className="vis-work-project-dot" aria-label={m.otherProjectAttention}>●</span> : null} <span className="vis-project-chevron" aria-hidden="true"><SessionIcon kind="chevron" /></span></button>
      {menuOpen ? <div ref={menu} role="menu" aria-label={m.project} className="vis-popover vis-session-menu vis-project-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false) }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); createButton.current?.focus(); return }
        moveMenuFocus(event)
      }}>
        {groups.series.map(group => <div key={group.seriesId} role="group" aria-label={group.name} className="vis-project-series-group">
          <div className="vis-project-series-heading"><strong>{group.name}</strong><small>{seriesCopy.episodeCount(format.number(group.projects.length))}</small>
            {p.seriesHost ? <button role="menuitem" aria-label={`${seriesCopy.delete} ${group.name}`} onClick={() => seriesAction(group.projects[0]!, 'delete')}>{seriesCopy.delete}</button> : null}
          </div>{group.projects.map(projectRow)}
        </div>)}
        {groups.standalone.map(projectRow)}
        {project ? <button role="menuitem" onClick={() => { setMenuOpen(false); p.onRevealProject() }}>{m.openAssets}</button> : null}
        <button role="menuitem" className="vis-project-create" onClick={() => { setMenuOpen(false); setDialog('project') }}>{m.createProject}</button>
      </div> : null}
    </div>
    {projectError ? <div role="alert" className="vis-dialog-error">{describeError(projectError, locale)}</div> : null}
    {dialog === 'project' ? <ProjectDialog projectsDir={p.projectsDir} seriesHost={p.seriesHost} onClose={() => setDialog(null)} onCreate={p.onCreateProject} onPickDirectory={p.onPickDirectory} /> : null}
    {seriesDialog && p.seriesHost ? <SeriesProjectDialog project={seriesDialog.project} action={seriesDialog.action} host={p.seriesHost} onClose={() => setSeriesDialog(null)} /> : null}
  </>
}
