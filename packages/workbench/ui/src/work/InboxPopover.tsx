import { workFailureText, workMessageLabel } from './model'
import { agentLabel, useAgents } from '../agents'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { workMessages } from '../messages'
import { AgentIcon } from '../AgentIcon'
import type { AgentKind, WorkInboxGroup, WorkMessageView, WorkSessionView } from '@vis/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AgentMarkdown } from '../AgentMarkdown'
import { mergeInboxGroups, relativeTime, statusLabels } from './model'
import { WorkDialog } from './WorkDialog'

/** The host maps both RPC success and already_resolved to this result. */
export type InboxReplyResult = { status: 'sent' } | { status: 'already_resolved'; reply: WorkMessageView }

/** Remount on each opening; retain entries removed from the snapshot until this opening closes. */
export interface InboxPopoverProps {
  groups: readonly WorkInboxGroup[]
  /** Include session information from other projects for model names in message sources. */
  sessions?: readonly WorkSessionView[]
  loading?: boolean
  focusMessageId?: string
  onClose(): void
  onMarkRead(input: { spaceId: string; workItemId: string }): void | Promise<void>
  onReply(input: { spaceId: string; workItemId: string; body: string; replyTo?: string }): Promise<InboxReplyResult>
  onReview(input: { spaceId: string; workItemId: string }): void
  /** The host switches projects before locating the node. */
  onLocateNode(input: { spaceId: string; nodeId: string }): void
}

export function InboxPopover(p: InboxPopoverProps) {
  const t = useMessages(workMessages)
  const [groups, setGroups] = useState(() => [...p.groups])
  useEffect(() => { setGroups(current => mergeInboxGroups(current, p.groups)) }, [p.groups])
  const empty = groups.every(group => group.items.every(item => !item.messages.length))
  return <WorkDialog popover title={t.inbox} className="vis-work-inbox" onClose={p.onClose}>
    {p.loading ? <p role="status" className="vis-work-muted">{t.readingMessages}</p> : null}
    {!p.loading && empty ? <p className="vis-work-empty">{t.noInboxMessages}</p> : null}
    {groups.map(group => <section key={group.spaceId} className="vis-work-inbox-space"><h3>{group.spaceName}</h3>{group.items.filter(item => item.messages.length).map(item => <InboxItem key={item.workItemId} {...p} spaceId={group.spaceId} item={item} />)}</section>)}
  </WorkDialog>
}

function InboxItem({ item, spaceId, ...p }: InboxPopoverProps & { item: WorkInboxGroup['items'][number]; spaceId: string }) {
  const { locale } = useLocale()
  const ref = useRef<HTMLElement>(null)
  const marked = useRef(new Set<string>())
  const markRead = useRef(p.onMarkRead)
  markRead.current = p.onMarkRead
  const [error, setError] = useState<unknown>(null)
  const unread = item.messages.filter(message => message.readAt === null).map(message => message.messageId).join(',')
  useEffect(() => {
    const element = ref.current!
    const key = unread || 'initial'
    const mark = () => {
      if (marked.current.has(key)) return
      marked.current.add(key)
      void Promise.resolve().then(() => markRead.current({ spaceId, workItemId: item.workItemId })).catch(error => {
        marked.current.delete(key)
        setError(error)
      })
    }
    if (typeof IntersectionObserver === 'undefined') { mark(); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) mark() })
    observer.observe(element)
    return () => observer.disconnect()
  }, [spaceId, item.workItemId, unread, locale])
  return <article ref={ref} className="vis-work-inbox-item"><header><strong>{item.title}</strong><span className="vis-work-badge">{statusLabels(locale)[item.status]}</span>{item.parentTitle ? <span className="vis-work-muted">{item.parentTitle}</span> : null}</header>
    {error !== null ? <p role="alert" className="vis-work-error">{describeError(error, locale)}</p> : null}
    {item.messages.map(message => <InboxMessage key={message.messageId} {...p} spaceId={spaceId} message={message} nodeLabels={item.nodeLabels} />)}
  </article>
}

function InboxMessage({ message, spaceId, nodeLabels, ...p }: InboxPopoverProps & { message: WorkMessageView; spaceId: string; nodeLabels: Record<string, string> }) {
  const { locale } = useLocale()
  const agents = useAgents()
  const t = useMessages(workMessages)
  const format = useFormat()
  const label = workMessageLabel(message, locale)
  const messageRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (p.focusMessageId !== message.messageId) return
    messageRef.current?.scrollIntoView({ block: 'center' })
    messageRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }, [p.focusMessageId, message.messageId])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [resolution, setResolution] = useState<WorkMessageView | null>(null)
  const [discarded, setDiscarded] = useState(false)
  const deleted = resolution?.kind === 'deleted'
  const needsReply = ['question', 'blocked', 'escalation'].includes(message.kind) && message.resolvedBy === null
  const sourceSession = p.sessions?.find(session => message.from.kind === 'session' && session.sessionId === message.from.sessionId)
  const source = message.from.kind === 'session' ? sourceSession ? agentLabel(agents, sourceSession.agentKind) : t.agent : message.from.kind === 'user' ? t.me : t.system
  const send = async (append = false) => {
    if (busy || !draft.trim()) return
    setBusy(true)
    setError(null)
    const body = draft.trim()
    try {
      const result = await p.onReply({ spaceId, workItemId: message.workItemId, body, ...(append ? {} : { replyTo: message.messageId }) })
      if (result.status === 'already_resolved') setResolution(result.reply)
      else { setSent(body); setDraft(''); setResolution(null) }
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <section ref={messageRef} className="vis-work-message" aria-label={t.messageLabel(label, source)}>
    <header><span className={`vis-work-badge${needsReply ? ' is-waiting' : ''}`}>{label}</span><span>{sourceSession ? <AgentIcon kind={sourceSession.agentKind} /> : null}{source}</span><time dateTime={new Date(message.createdAt).toISOString()} title={format.dateTime(message.createdAt)}>{relativeTime(message.createdAt, undefined, locale)}</time></header>
    <InboxBody body={message.from.kind === 'system' && message.from.failure ? workFailureText(message.from.failure, locale) : message.body} />
    {message.refs.nodeIds?.length ? <div className="vis-work-chips">{message.refs.nodeIds.map(nodeId => { const label = nodeLabels[nodeId] ?? nodeId; return <button key={nodeId} title={label} onClick={() => p.onLocateNode({ spaceId, nodeId })} aria-label={t.locateRelatedNode(label)}>{label}</button> })}</div> : null}
    {message.kind === 'done' ? <button onClick={() => p.onReview({ spaceId, workItemId: message.workItemId })}>{t.review}</button> : null}
    {sent !== null ? <div className="vis-work-notice" role="status"><strong>{t.repliedByYou}</strong><p>{sent}</p></div> : null}
    {resolution ? <div className="vis-work-notice" role="status">{deleted ? <strong>{t.itemDeleted}</strong> : <><strong>{t.parentReplied}</strong><div className="vis-work-markdown"><AgentMarkdown>{resolution.body}</AgentMarkdown></div></>}</div> : null}
    {sent === null && !discarded && !deleted && (needsReply || resolution) ? <div className="vis-work-reply">
      <textarea aria-label={t.replyKind(label)} placeholder={t.replyPlaceholder} rows={3} maxLength={20_000} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void send(!!resolution) }
      }} />
      {error !== null ? <p className="vis-work-error" role="alert">{describeError(error, locale)}</p> : null}
      <div className="vis-work-form-actions">{resolution ? <button disabled={busy} onClick={() => { setDraft(''); setDiscarded(true) }}>{t.discard}</button> : null}<button disabled={busy || !draft.trim()} onClick={() => void send(!!resolution)}>{busy ? t.sending : resolution ? t.appendReply : t.sendReply}</button></div>
    </div> : null}
    {!needsReply && sent === null && !resolution && ['question', 'blocked', 'escalation'].includes(message.kind) ? <p className="vis-work-muted">{t.resolved}</p> : null}
  </section>
}

function InboxBody({ body }: { body: string }) {
  const t = useMessages(workMessages)
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current!
    const measure = () => { if (!expanded) setOverflows(element.scrollHeight > element.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [body, expanded])
  return <><div ref={ref} className={`vis-work-markdown${expanded ? '' : ' is-folded'}`}><AgentMarkdown>{body}</AgentMarkdown></div>{overflows ? <button className="vis-work-text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t.collapseBody : t.expandBody}</button> : null}</>
}
