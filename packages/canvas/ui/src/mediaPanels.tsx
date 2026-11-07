import type { LocalOperation } from '@vis/protocol'
import type { OperationPanel } from './operations-ui'
import { FramePanel, SpeedPanel, SplitPanel, TrimPanel } from './MediaOperationPanels'

export const MEDIA_PANELS: Partial<Record<LocalOperation, OperationPanel>> = {
  'video.trim': TrimPanel,
  'video.frame': FramePanel,
  'audio.trim': TrimPanel,
  'audio.split': SplitPanel,
  'audio.speed': SpeedPanel,
}
