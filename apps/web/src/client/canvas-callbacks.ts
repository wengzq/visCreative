import { useLayoutEffect, useMemo, useRef } from 'react'
import type { CanvasActions } from '@vis/canvas-ui'
import type { Locale } from '@vis/ui-kit'
import { canvasActions, type Notice } from './actions'
import type { SpaceConnection } from './space'
import { createScriptSession, sendScriptRequest, type ScriptRequestRecord } from './script-actions'

type Bindings = {
  agents?: readonly import('@vis/protocol').AgentView[] | undefined
  locale: Locale
  openSession(id: string): void
  openPreviz?(id: string, panelId?: string): void
  openScene?(id: string): void
  previzDraft?(nodeId: string, text: string): void
  openWriting?(id: string, quote?: string): void
  importWriting?(at: { x: number; y: number }): void
  openTimeline(id: string): void
  focus(id: string): void
  reference(ids: string[]): void
  selection(ids: string[]): void
  record(request: ScriptRequestRecord): void
}

export function useCanvasCallbacks(conn: SpaceConnection, notify: (notice: Omit<Notice, 'id'>) => void, spaceId: string | undefined, bindings: Bindings): CanvasActions {
  const current = useRef(bindings)
  // Canvas invokes these from user events and passive effects, never from a child layout effect.
  useLayoutEffect(() => { current.current = bindings }, [bindings])
  return useMemo(() => {
    const { generationOperations: _operations, ...callbacks } = canvasActions(conn, notify, () => current.current.locale)
    return {
      ...callbacks,
      agents: bindings.agents,
      onAssembleScriptTimeline: async nodeId => {
        const created = await callbacks.onAssembleScriptTimeline!(nodeId)
        current.current.focus(created)
        return created
      },
      onOpenPreviz: (id, panelId) => current.current.openPreviz?.(id, panelId),
      onOpenScene: id => current.current.openScene?.(id),
      onPrevizDraft: (id, text) => current.current.previzDraft?.(id, text),
      onOpenWriting: (id, quote) => current.current.openWriting?.(id, quote),
      onImportWriting: at => current.current.importWriting?.(at),
      onOpenTimeline: id => current.current.openTimeline(id),
      onCreateScriptSession: agentKind => createScriptSession(conn, agentKind),
      onOpenSession: id => current.current.openSession(id),
      onScriptAgent: request => sendScriptRequest(conn, request, current.current.locale, record => current.current.record(record)),
      onSelectionChange: ids => current.current.selection(ids),
      onReference: ids => current.current.reference(ids),
    }
  }, [conn, notify, spaceId, bindings.agents])
}
