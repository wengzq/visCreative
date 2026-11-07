import { describe, expect, it } from 'vitest'
import { checkSlotDelivery, type DeliveryBindingState, type DeliveryTargetState } from './delivery'

const binding: DeliveryBindingState = { bindingId: 'bind_A', status: 'pending', expectedContentRevision: 5 }

function target(slot: Partial<NonNullable<DeliveryTargetState['slot']>> = {}, nodeDeletedAt: number | null = null): DeliveryTargetState {
  return {
    node: { deletedAt: nodeDeletedAt },
    slot: { deletedAt: null, contentType: 'image', currentRevision: 5, acceptedBindingId: 'bind_A', ...slot },
  }
}

describe('checkSlotDelivery', () => {
  it('allows filling when all four conditions hold', () => {
    expect(checkSlotDelivery(binding, target(), 'image')).toEqual({ ok: true })
  })

  it('deleted or missing target nodes or slots: target_missing without restoring targets', () => {
    const missing = { ok: false, reason: 'target_missing', nextBindingStatus: 'target_missing' }
    expect(checkSlotDelivery(binding, target({}, 123), 'image')).toEqual(missing)
    expect(checkSlotDelivery(binding, target({ deletedAt: 123 }), 'image')).toEqual(missing)
    expect(checkSlotDelivery(binding, { node: null, slot: null }, 'image')).toEqual(missing)
  })

  it('output types incompatible with slots: conflict', () => {
    expect(checkSlotDelivery(binding, target({ contentType: 'video' }), 'image')).toMatchObject({ reason: 'type_mismatch', nextBindingStatus: 'conflict' })
    expect(checkSlotDelivery(binding, target({ contentType: 'text' }), 'image')).toMatchObject({ reason: 'type_mismatch' })
  })

  it('slot content changed after submission: conflict without overwriting later edits', () => {
    expect(checkSlotDelivery(binding, target({ currentRevision: 6 }), 'image')).toMatchObject({ reason: 'revision_changed', nextBindingStatus: 'conflict' })
  })

  it('0001 example: content revision is still 5 but request B is accepted; request A cannot fill even if it finishes first', () => {
    expect(checkSlotDelivery(binding, target({ acceptedBindingId: 'bind_B' }), 'image')).toMatchObject({ reason: 'superseded', nextBindingStatus: 'conflict' })
  })

  it('undo or restoration advances revision without restoring eligibility: still superseded', () => {
    // Undo after deletion restores the slot, but accepted_binding_id is cleared, so old requests do not revive
    expect(checkSlotDelivery(binding, target({ currentRevision: 6, acceptedBindingId: null }), 'image')).toMatchObject({ ok: false, reason: 'superseded' })
  })

  it('delivered or decided bindings: duplicate notifications change neither content nor binding state', () => {
    for (const status of ['delivered', 'conflict', 'target_missing'] as const) {
      expect(checkSlotDelivery({ ...binding, status }, target(), 'image')).toEqual({ ok: false, reason: 'already_settled', nextBindingStatus: null })
    }
  })
})
