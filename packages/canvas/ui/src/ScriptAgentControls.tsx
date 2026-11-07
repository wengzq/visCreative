import { useEffect, useRef, useState } from 'react'
import { DEFAULT_AGENT_KIND, type AgentKind } from '@vis/protocol'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import { useCanvasSelector } from './CanvasView'
import type { ScriptAgentTask, ScriptPartProps } from './script-ui'
import { defaultScriptSession, scriptOwner } from './script-agent-model'
import { scriptAgentMessages } from './script-agent-messages'

type Task = { task: ScriptAgentTask; text: string; shotIds?: string[] }

export function useScriptAgent(props: ScriptPartProps) {
  const { actions, sessions, currentScriptSessionId, running } = useCanvasSelector(state => ({
    actions: state.actions, sessions: state.scriptSessions, currentScriptSessionId: state.currentScriptSessionId,
    running: !!state.decorations?.get(props.view.nodeId)?.scriptAgent?.running,
  }), [props.view.nodeId])
  const m = useMessages(scriptAgentMessages)
  const { locale } = useLocale()
  const owner = scriptOwner(props.doc, sessions ?? [])
  const ownerUnavailable = Boolean(owner && actions.agents && !actions.agents.some(agent => agent.kind === owner.agentKind))
  const [chooser, setChooser] = useState<{ task?: Task } | null>(null)
  const [selection, setSelection] = useState('')
  const selectedSession = sessions?.find(session => session.sessionId === selection)
  const selectionUnavailable = Boolean(selectedSession && actions.agents && !actions.agents.some(agent => agent.kind === selectedSession.agentKind))
  const [agentKind, setAgentKind] = useState<AgentKind>(DEFAULT_AGENT_KIND)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!chooser) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); previous?.focus() }
  }, [chooser])
  const choose = (task?: Task) => {
    setSelection(defaultScriptSession(sessions ?? [], currentScriptSessionId))
    setError(null)
    setChooser(task ? { task } : {})
  }
  const run = async (task: Task) => {
    if (busy || running || ownerUnavailable || !actions.onScriptAgent) return
    if (!owner) { choose(task); return }
    setBusy(true)
    setError(null)
    try { await actions.onScriptAgent({ nodeId: props.view.nodeId, ...task, session: { sessionId: owner.sessionId } }) }
    catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!chooser || busy || selectionUnavailable) return
    setBusy(true)
    setError(null)
    try {
      let sessionId = selection
      if (selection === 'new') {
        if (!actions.onCreateScriptSession || !actions.agents?.some(agent => agent.kind === agentKind && agent.available)) return
        sessionId = (await actions.onCreateScriptSession(agentKind)).sessionId
        // Keep the new session selected if saving or sending fails, so retry never creates a duplicate.
        setSelection(sessionId)
      }
      if (sessionId !== props.doc.sessionId) await props.onPatch([{ kind: 'doc.set', rev: props.doc.rev, fields: { sessionId } }])
      if (chooser.task) await actions.onScriptAgent?.({ nodeId: props.view.nodeId, ...chooser.task, session: { sessionId } })
      setChooser(null)
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return {
    owner, ownerUnavailable, busy: busy || running, run, choose,
    feedback: <>
      {ownerUnavailable ? <p role="status">{m.agentUnregistered}</p> : null}
      {error && !chooser ? <p role="alert">{describeError(error, locale)}</p> : null}
      {chooser ? <dialog ref={dialog} className="vis-dialog vis-script-owner-dialog" aria-label={m.chooseOwner} onCancel={event => { if (busy) event.preventDefault(); else setChooser(null) }}>
        <h2>{m.chooseOwner}</h2>
        <label>{m.session}<select aria-label={m.session} value={selection} disabled={busy} onChange={event => setSelection(event.target.value)}>
          {(sessions ?? []).filter(session => !session.archived).sort((a, b) => Number(b.sessionId === currentScriptSessionId) - Number(a.sessionId === currentScriptSessionId)).map(session => <option key={session.sessionId} value={session.sessionId} disabled={actions.agents !== undefined && !actions.agents.some(agent => agent.kind === session.agentKind)}>{session.title}{session.sessionId === currentScriptSessionId ? ` · ${m.current}` : ''}</option>)}
          {selection !== 'new' && !sessions?.some(session => session.sessionId === selection) ? <option value={selection}>{selection}</option> : null}
          <option value="new">{m.newSession}</option>
        </select></label>
        {selection === 'new' ? <label>{m.agentKind}<select aria-label={m.agentKind} value={agentKind} disabled={busy} onChange={event => setAgentKind(event.target.value as AgentKind)}>
          {(actions.agents ?? []).map(agent => <option key={agent.kind} value={agent.kind} disabled={!agent.available}>{agent.label}{agent.available ? '' : ` · ${agent.install.hint[locale === 'zh-CN' ? 'zh' : 'en']}`}</option>)}
        </select></label> : null}
        {error ? <p role="alert">{describeError(error, locale)}</p> : null}
        <footer><button disabled={busy} onClick={() => setChooser(null)}>{m.cancel}</button><button disabled={busy || !selection || selectionUnavailable || selection === 'new' && (!actions.onCreateScriptSession || !actions.agents?.some(agent => agent.kind === agentKind && agent.available))} onClick={() => void confirm()}>{m.confirm}</button></footer>
      </dialog> : null}
    </>,
  }
}

export function ScriptAgentControls(props: ScriptPartProps & { tasks: readonly ScriptAgentTask[]; shotIds?: string[]; showOwner?: boolean }) {
  const { actions, state } = useCanvasSelector(state => ({
    actions: state.actions, state: state.decorations?.get(props.view.nodeId)?.scriptAgent,
  }), [props.view.nodeId])
  const m = useMessages(scriptAgentMessages)
  const agent = useScriptAgent(props)
  const input = props.view.slots.find(slot => slot.slotKey === 'prompt')?.content
  const text = props.requestText ?? (input?.type === 'text' ? input.body : '')
  return <div className="vis-script-agent-bar">
    {props.showOwner !== false ? <div className="vis-script-owner">
      {agent.owner ? <button onClick={() => actions.onOpenSession?.(agent.owner!.sessionId)}>{m.owner(agent.owner.title)}</button> : <span>{m.noOwner}</span>}
      <button disabled={agent.busy} onClick={() => agent.choose()}>{m.change}</button>
      {state?.running ? <button role="status" onClick={() => actions.onOpenSession?.(state.sessionId)}>{state.task === 'breakdown' ? m.breakingDown : state.task === 'prompts' ? m.writingPrompts : m.working}{` · ${state.title}`}</button> : null}
    </div> : null}
    <div className="vis-script-agent-tasks">{props.tasks.map(task => <button key={task} disabled={agent.busy || agent.ownerUnavailable || !actions.onScriptAgent || task === 'custom' && !text.trim()} onClick={() => void agent.run({ task, text, ...(props.shotIds ? { shotIds: props.shotIds } : {}) })}>{m[task]}</button>)}</div>
    {agent.feedback}
  </div>
}
