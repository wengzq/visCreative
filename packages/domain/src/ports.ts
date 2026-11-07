// Cross-system ports: implementations are injected during studiod assembly; neither side depends on the other (see README "Dependency rules")

export type DeliveryOutcome =
  | { status: 'delivered'; nodeId: string; slotId: string; slotRevision: number }
  | { status: 'conflict' | 'target_missing' }
  | { status: 'already_settled' }

/**
 * generation -> canvas: delivers a registered output to the canvas using persisted bindings. Must be idempotent.
 * Runs inside the caller write transaction so registration and filling commit together. Tx is determined during studiod assembly.
 */
export interface CanvasDeliveryPort<Tx> {
  deliverOutput(tx: Tx, input: { bindingId: string; assetVersionId: string }): DeliveryOutcome
}
