import type { LibraryRunKind, METHODS, SERIES_METHODS, SpaceEvent } from '@vis/protocol'

type LibraryMethods = typeof METHODS & typeof SERIES_METHODS
type LibraryMethod = Extract<keyof LibraryMethods, `asset.${string}` | `library.${string}` | `entity.${string}` | 'series.entityList'>
type Params<M extends LibraryMethod> = ReturnType<LibraryMethods[M]['params']['parse']>
type Result<M extends LibraryMethod> = ReturnType<LibraryMethods[M]['result']['parse']>

/**
 * Everything the panel needs from its host (apps/web today, apps/desktop later). library-ui never calls RPC
 * itself. Tab-specific needs live in MediaHost (media/host.ts, A2) and SettingsHost (settings/host.ts, B2).
 */
export type LibraryCoreHost = {
  call<M extends LibraryMethod>(method: M, params: Params<M>): Promise<Result<M>>
  /** Space events after the host's own dedupe by seq; returns an unsubscribe function */
  onEvent(listener: (event: SpaceEvent) => void): () => void
  onClose(): void
  sessions(): Promise<LibrarySession[]>
  sendLibraryTask(task: LibraryTask): Promise<void>
  openSession(sessionId: string): void
}

export type LibrarySession = { sessionId: string; title: string; running: boolean }
export type LibraryTask = { sessionId: string; runId: string; kind: LibraryRunKind; relabel: boolean }
