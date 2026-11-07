import { VisError } from '@vis/domain'
import { SceneDoc } from '@vis/protocol'
import type { SpaceTx } from '@vis/storage'
import { assetVersionKind } from './write'

export function validateScene(tx: SpaceTx, source: SceneDoc): SceneDoc {
  const parsed = SceneDoc.safeParse(source)
  if (!parsed.success) throw VisError.of('invalid_params', 'scene.invalid_document', {}, 'Invalid scene document')
  for (const object of parsed.data.objects) {
    if (object.source.type === 'model' && assetVersionKind(tx, object.source.assetVersionId).kind !== 'model') {
      throw VisError.of('invalid_params', 'scene.model_required', { assetVersionId: object.source.assetVersionId }, 'Scene models must reference model assets')
    }
  }
  for (const view of parsed.data.views) {
    if (view.still && assetVersionKind(tx, view.still).kind !== 'image') throw VisError.of('invalid_params', 'scene.image_required', { assetVersionId: view.still }, 'Scene stills must reference images')
  }
  return parsed.data
}
