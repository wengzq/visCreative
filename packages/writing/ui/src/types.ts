import type { PassageShot } from './sources'
import type { MethodParams, SeriesView, MethodResult, NodeView, WritingImportPreview, TextProposal, TextEditRef } from '@vis/protocol'

export type WritingHost = {
  node: NodeView
  scripts?: readonly string[] | undefined
  sourceQuote?: string | undefined
  shots?: readonly PassageShot[] | undefined
  openShot?(shot: PassageShot): Promise<void>
  series?: { seriesId: string; name: string; episode: number } | undefined
  seriesList?(): Promise<SeriesView[]>
  split?(params: Omit<MethodParams<'writing.split'>, 'nodeId'>): Promise<MethodResult<'writing.split'>>
  proposals?: readonly TextProposal[]
  session?: { title: string; working: boolean }
  sendSelection?(action: 'rewrite' | 'continue' | 'expand' | 'ask' | 'shots' | 'extract', chapter: string, selection: string, instruction: string): Promise<void>
  rejectEdits?(edits: TextEditRef[]): Promise<void>
  commit(body: string, expectedRevision: number, review?: { requestId: string; edits: TextEditRef[] }): Promise<'ok' | 'conflict'>
  history(beforeRevision?: number): Promise<MethodResult<'slot.history'>>
  upload(file: File): Promise<WritingImportPreview>
  lastWriter?(): string | undefined
  onClose(): void
}
