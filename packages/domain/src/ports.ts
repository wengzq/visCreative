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
  /**
   * Creates the empty result node of a pending new_node binding and points the binding at its main slot (RFC 0047).
   * The canvas service implements both placeholder methods; a double without them keeps create-on-delivery.
   */
  reservePlaceholder?(tx: Tx, input: { bindingId: string }): void
  /** Removes a cancelled job's placeholders whose main slot is still empty and still awaits that job (RFC 0047 decision 1) */
  releasePlaceholders?(tx: Tx, input: { jobId: string }): void
}
