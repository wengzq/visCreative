import type { BindingStatus, MediaKind, NodeKind } from '@vis/protocol'

// Fill eligibility checks (0001 "Object identity and version rules", 0002 "Generation jobs and delivery").
// Pure function: callers must read state, call this function, and write based on the result within the same write transaction;
// never check first and then write unconditionally.

export type DeliveryTargetState = {
  node: { deletedAt: number | null } | null
  slot: {
    deletedAt: number | null
    contentType: NodeKind
    currentRevision: number
    acceptedBindingId: string | null
  } | null
}

export type DeliveryBindingState = {
  bindingId: string
  status: BindingStatus
  expectedContentRevision: number
}

export type DeliveryRejection =
  | 'already_settled'   // The binding is already delivered or decided; duplicate notification or recovery retry
  | 'target_missing'    // The target node or slot is missing or deleted
  | 'type_mismatch'     // The output type is incompatible with the slot
  | 'revision_changed'  // The user or another agent modified slot content afterward
  | 'superseded'        // The slot has accepted a newer generation request

export type DeliveryVerdict =
  | { ok: true }
  | {
      ok: false
      reason: DeliveryRejection
      // Binding state to write back; null means unchanged (do not rewrite already-decided bindings)
      nextBindingStatus: Extract<BindingStatus, 'conflict' | 'target_missing'> | null
    }

export function checkSlotDelivery(
  binding: DeliveryBindingState,
  target: DeliveryTargetState,
  outputKind: MediaKind,
): DeliveryVerdict {
  if (binding.status !== 'pending') {
    return { ok: false, reason: 'already_settled', nextBindingStatus: null }
  }
  const { node, slot } = target
  if (!node || node.deletedAt !== null || !slot || slot.deletedAt !== null) {
    return { ok: false, reason: 'target_missing', nextBindingStatus: 'target_missing' }
  }
  if (slot.contentType !== outputKind) {
    return { ok: false, reason: 'type_mismatch', nextBindingStatus: 'conflict' }
  }
  // Check supersession first: even with unchanged content, old jobs must not overwrite newer generation intent
  if (slot.acceptedBindingId !== binding.bindingId) {
    return { ok: false, reason: 'superseded', nextBindingStatus: 'conflict' }
  }
  if (slot.currentRevision !== binding.expectedContentRevision) {
    return { ok: false, reason: 'revision_changed', nextBindingStatus: 'conflict' }
  }
  return { ok: true }
}
