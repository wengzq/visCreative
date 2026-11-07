import { VisError } from '@vis/domain'
import { PrevizDoc } from '@vis/protocol'
import type { SpaceTx } from '@vis/storage'
import { assetVersionKind } from './write'

export function validatePreviz(tx: SpaceTx, source: PrevizDoc): PrevizDoc {
  const parsed = PrevizDoc.safeParse(source)
  if (!parsed.success) throw VisError.of('invalid_params', 'previz.invalid_document', {}, 'Invalid previz document')
  const ids = new Set(parsed.data.panels.flatMap(panel => [panel.underlay, panel.sketch, panel.image, panel.blockout].filter((id): id is string => id !== null)))
  for (const assetVersionId of ids) {
    if (assetVersionKind(tx, assetVersionId).kind !== 'image') throw VisError.of('invalid_params', 'previz.image_required', { assetVersionId }, 'Previz pictures must reference image assets')
  }
  return parsed.data
}
