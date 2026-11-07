import { WritingEditor, WritingImportDialog, writingMessages, type PassageShot, type WritingHost } from '@vis/writing-ui'
import { WritingImportPreview, writingCardSize, type NodeView, type TextProposal, type SessionSummary } from '@vis/protocol'
import { messagesFor, useFormat, useLocale, type Locale } from '@vis/ui-kit'
import { useMemo } from 'react'
import { actionMessages } from './messages'
import { RpcError } from './rpc'
import type { SpaceConnection } from './space'

export async function uploadWriting(conn: SpaceConnection, file: File) {
  const spaceId = conn.getView().space?.spaceId
  if (!spaceId || !conn.getView().ready) throw new Error('Project is unavailable')
  const response = await fetch(`/upload?kind=writing&t=${encodeURIComponent(conn.token)}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
  const data = await response.json()
  if (!response.ok) throw new RpcError(data.error?.code ?? 'unavailable', data.error?.message ?? `HTTP ${response.status}`, data.error?.data)
  if (conn.getView().space?.spaceId !== spaceId || !conn.getView().ready) throw new Error('Project changed during import')
  return WritingImportPreview.parse(data)
}

export function writingEditorHost(conn: SpaceConnection, node: NodeView, locale: Locale, close: () => void, proposals: readonly TextProposal[] = [], session?: SessionSummary, update?: (proposals: TextProposal[]) => void): WritingHost {
  const spaceId = conn.getView().space!.spaceId
  const assertProject = () => {
    if (!conn.getView().ready || conn.getView().space?.spaceId !== spaceId) throw new Error(messagesFor(actionMessages, locale).projectChanged)
  }
  const slot = () => {
    assertProject()
    const current = conn.getView().state.nodes.get(node.nodeId)
    const main = current?.slots.find(slot => slot.slotKey === 'main')
    if (!main || current?.format === 'code') throw new Error(messagesFor(actionMessages, locale).nodeDeleted)
    return main
  }
  return {
    node, proposals,
    ...(session ? { session: { title: session.title, working: !!session.activeTurnId || (session.queuedMessageCount ?? 0) > 0 } } : {}),
    async sendSelection(action, chapter, selection, instruction) {
      assertProject()
      if (!session || !conn.getView().state.sessions.has(session.sessionId)) throw new Error('The selected Agent session is unavailable')
      const task = action === 'shots' ? 'Read the writing and script guides. Break this passage into shots in the script named in Instruction, or create a new script. Use existing script tools, preserve the manuscript, and put source: { nodeId, quote } on every shot using an exact unique passage quote.' : action === 'extract' ? 'Read the writing and library guides. Extract characters and scenes into project settings with short descriptions drawn from this passage. List settings first; report same-kind same-name settings to the user and reuse them without updating or overwriting them. Create only missing settings through entity.create. Preserve the manuscript.' : 'Read the writing guide and propose anchored edits for review.'
      const text = `Writing task: ${action}\nnodeId: ${node.nodeId}\nslotId: ${slot().slotId}\nChapter: ${JSON.stringify(chapter)}\nSelection: ${JSON.stringify(selection)}\nInstruction: ${JSON.stringify(instruction)}\n${task}`
      await conn.rpc.call('session.sendMessage', { requestId: `writing-action-${crypto.randomUUID()}`, sessionId: session.sessionId, text, refs: [{ nodeId: node.nodeId, versionPolicy: 'latest-at-execution' }] })
    },
    async rejectEdits(edits) {
      const result = await conn.rpc.call('text.proposal.resolve', { requestId: `writing-reject-${crypto.randomUUID()}`, slotId: slot().slotId, action: 'reject', edits })
      update?.(result.proposals)
    },
    async commit(body, expectedRevision, review) {
      try {
        if (review) {
          const result = await conn.rpc.call('text.proposal.resolve', { requestId: review.requestId, slotId: slot().slotId, expectedRevision, body, action: 'accept', edits: review.edits })
          update?.(result.proposals)
        } else await conn.rpc.call('canvas.apply', { requestId: `writing-${crypto.randomUUID()}`, ops: [{ op: 'slot.setText', slotId: slot().slotId, body, expectedRevision }] })
        return 'ok'
      } catch (error) {
        if (error instanceof RpcError && (error.code === 'revision_conflict' || (review && ['writing.edit_stale', 'writing.edit_not_pending', 'writing.draft_mismatch'].includes((error.data as { reason?: string })?.reason ?? '')))) { await conn.refreshNodes([node.nodeId]); return 'conflict' }
        throw error
      }
    },
    series: conn.getView().space?.series,
    seriesList: async () => { assertProject(); return (await conn.rpc.call('series.list', {})).items },
    split: params => { assertProject(); return conn.rpc.call('writing.split', { ...params, nodeId: node.nodeId }) },
    history: beforeRevision => conn.rpc.call('slot.history', { slotId: slot().slotId, limit: 10, ...(beforeRevision === undefined ? {} : { beforeRevision }) }),
    upload: file => { assertProject(); return uploadWriting(conn, file) },
    lastWriter() {
      const writer = slot().writer
      return writer?.actor === 'agent' && writer.sessionId ? conn.getView().state.sessions.get(writer.sessionId)?.title : undefined
    },
    onClose: close,
  }
}

export function WritingEditorMount({ conn, node, nodes, sourceQuote, openShot, close, proposals, session, update }: { conn: SpaceConnection; node: NodeView; nodes: NodeView[]; sourceQuote?: string | undefined; openShot(shot: PassageShot): Promise<void>; close(): void; proposals: readonly TextProposal[]; session?: SessionSummary; update(proposals: TextProposal[]): void }) {
  const { locale } = useLocale()
  const format = useFormat()
  const host = useMemo(() => {
    const m = messagesFor(writingMessages, locale)
    return { ...writingEditorHost(conn, node, locale, close, proposals, session, update), sourceQuote, openShot,
      scripts: [...new Set(nodes.filter(node => node.kind === 'script' && node.title).map(node => node.title!))],
      shots: nodes.flatMap(script => script.slots.flatMap(slot => slot.content.type === 'script' ? slot.content.doc.shots.flatMap((shot, index) => shot.source?.nodeId === node.nodeId ? [{ scriptNodeId: script.nodeId, shotId: shot.id, quote: shot.source.quote, label: m.shotMarker(script.title ?? script.nodeId, format.number(index + 1)) }] : []) : [])) }
  }, [conn, node, nodes, locale, close, proposals, session, update, sourceQuote, openShot, format])
  return <WritingEditor host={host} />
}

export function CanvasWritingImport({ conn, at, close, created }: { conn: SpaceConnection; at: { x: number; y: number }; close(): void; created(id: string): void }) {
  const spaceId = conn.getView().space?.spaceId
  const { locale } = useLocale()
  return <WritingImportDialog upload={file => uploadWriting(conn, file)} close={close} insert={async preview => {
    if (!spaceId || conn.getView().space?.spaceId !== spaceId || !conn.getView().ready) throw new Error('Project changed during import')
    const result = await conn.rpc.call('canvas.apply', { requestId: `writing-import-${crypto.randomUUID()}`, ops: [{ op: 'node.create', tempId: 'manuscript', kind: 'text', format: 'markdown', title: preview.name.replace(/\.[^.]+$/, '').slice(0, 60) || messagesFor(actionMessages, locale).text, content: { text: preview.body }, ...writingCardSize(preview.body, true), ...at }] })
    created(result.idMap.manuscript!)
  }} />
}
