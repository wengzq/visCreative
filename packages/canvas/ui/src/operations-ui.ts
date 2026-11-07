import type { ComponentType } from 'react'
import type { LocalOperation, NodeView, SlotView } from '@vis/protocol'
import { IMAGE_PANELS } from './imagePanels'
import { MEDIA_PANELS } from './mediaPanels'
import type { PreviewLoader } from './peaks'

// 0021: local operations that need interaction on the node first (a selection, handles, split points) take over the node body with a panel.
// Operations without a panel are submitted directly when clicked in the toolbar.

export type OperationPanelProps = {
  view: NodeView
  /** The node main slot, holding the asset */
  slot: SlotView
  assetVersionId: string
  src: string
  onPreview?: PreviewLoader | undefined
  /** Submit media.process params; the panel closes on success and stays open with the error on failure */
  onSubmit(params: Record<string, unknown>): Promise<void>
  onCancel(): void
  /** Toolbar entries that share one operation pass a variant, e.g. audio.split 'custom' or 'smart' */
  variant?: string
  /** media.analyze audio.silence for this node; present when the host supports it */
  onAnalyze?(): Promise<{ durationMs: number; pointsMs: number[] }>
}

export type OperationPanel = ComponentType<OperationPanelProps>

export const OPERATION_PANELS: Partial<Record<LocalOperation, OperationPanel>> = { ...IMAGE_PANELS, ...MEDIA_PANELS }
