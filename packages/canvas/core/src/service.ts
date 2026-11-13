import { type CanvasDeliveryPort, type DeliveryOutcome, VisError } from '@vis/domain'
import type { CanvasOp, MethodParams, MethodResult } from '@vis/protocol'
import { runIdempotent, type SpaceDb, type SpaceTx } from '@vis/storage'
import { type Actor, applyOps } from './apply'
import { changeHistory } from './undo'
import { deliverOutput, releasePlaceholders, reservePlaceholder } from './delivery'
import { readNodes, readSlotHistory, readSnapshotNodes } from './views'

export interface CanvasService extends Required<CanvasDeliveryPort<SpaceTx>> {
  undo(params: MethodParams<'canvas.undo'>): MethodResult<'canvas.undo'>
  redo(params: MethodParams<'canvas.redo'>): MethodResult<'canvas.redo'>
  /**
   * Gateway checks and stamps run inside the write transaction after idempotency replay, for new requests only.
   * Returning ops replaces the request's ops; replay still uses the original request fingerprint.
   */
  apply(actor: Actor, params: MethodParams<'canvas.apply'>, prepare?: (tx: SpaceTx) => CanvasOp[] | void): MethodResult<'canvas.apply'>
  /** `snapshot: 'turn'` requires the calling turn's input snapshot */
  get(params: MethodParams<'canvas.get'>, ctx?: { inputSnapshotId: string | null }): MethodResult<'canvas.get'>
  history(params: MethodParams<'slot.history'>): MethodResult<'slot.history'>
}

export function createCanvasService(deps: { db: SpaceDb; now?: () => number; onChanged?: (tx: SpaceTx) => void }): CanvasService {
  const { db } = deps
  const now = deps.now ?? Date.now
  return {
    undo(params) {
      return runIdempotent(db, { requestId: params.requestId, method: 'canvas.undo', params }, tx => { const result = changeHistory(tx, 'undo', params.requestId, now()); deps.onChanged?.(tx); return result }, now)
    },
    redo(params) {
      return runIdempotent(db, { requestId: params.requestId, method: 'canvas.redo', params }, tx => { const result = changeHistory(tx, 'redo', params.requestId, now()); deps.onChanged?.(tx); return result }, now)
    },
    apply(actor, params, prepare) {
      return runIdempotent(db, { requestId: params.requestId, method: 'canvas.apply', params }, tx => {
        const ops = prepare?.(tx)
        const result = applyOps(tx, actor, ops ? { ...params, ops } : params, now())
        deps.onChanged?.(tx)
        return result
      }, now)
    },
    get(params, ctx) {
      if (params.snapshot !== 'turn') return { nodes: db.transaction(tx => readNodes(tx, params.nodeIds)) }
      if (ctx === undefined) throw VisError.of('forbidden', 'canvas.turn_snapshot_required', {}, 'Turn snapshots can only be read within an Agent turn')
      // The snapshot is empty when the turn references no assets
      if (ctx.inputSnapshotId === null) return { nodes: [] }
      const snapshotId = ctx.inputSnapshotId
      return { nodes: db.transaction(tx => readSnapshotNodes(tx, snapshotId, params.nodeIds)) }
    },
    history(params) {
      return db.transaction(tx => readSlotHistory(tx, params))
    },
    deliverOutput(tx, input): DeliveryOutcome {
      return deliverOutput(tx, input, now())
    },
    reservePlaceholder(tx, input) {
      reservePlaceholder(tx, input, now())
    },
    releasePlaceholders(tx, input) {
      releasePlaceholders(tx, input, now())
    },
  }
}
