import { describe, expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { moveFlowNodes, selectFlowNodes, toFlowNode } from './flow-nodes'

const view: NodeView = { nodeId: 'text', kind: 'text', x: 20, y: 40, w: 320, h: 240, z: 0, layoutRevision: 0, slots: [] }

describe('Flow node reconciliation', () => {
  it('Preserves pending measurements without inventing dimensions during content and status updates', () => {
    const initial = toFlowNode(view, undefined, false, undefined)
    expect(initial.measured).toEqual({})
    const updated = toFlowNode({ ...view, title: 'Delivered' }, undefined, false, { running: 0, problems: [] }, initial)
    expect(updated.measured).toBe(initial.measured)
    const acknowledged = { ...updated, measured: { width: 320, height: 240 } }
    expect(toFlowNode(updated.data.view, undefined, false, updated.data.deco, acknowledged)).toBe(acknowledged)
  })

  it('Reuses unchanged nodes including measurements returned by React Flow', () => {
    const previous = { ...toFlowNode(view, undefined, false, undefined), measured: { width: 320, height: 240 } }
    expect(toFlowNode(view, undefined, false, undefined, previous)).toBe(previous)
  })

  it('Keeps measured bounds when content, decoration, selection or layout changes', () => {
    const previous = { ...toFlowNode(view, undefined, false, undefined), measured: { width: 320, height: 240 } }
    const changes = [
      toFlowNode({ ...view, title: 'Updated' }, undefined, false, undefined, previous),
      toFlowNode(view, undefined, false, { running: 1, problems: [] }, previous),
      toFlowNode(view, undefined, true, undefined, previous),
      toFlowNode(view, { x: 50, y: 40, w: 400, h: 240 }, false, undefined, previous),
    ]
    for (const next of changes) {
      expect(next).not.toBe(previous)
      expect(next.measured).toBe(previous.measured)
    }
    expect(changes[3]).toMatchObject({ position: { x: 50, y: 40 }, width: 400 })
    expect(changes[2]!.data).toBe(previous.data)
  })

  it('Selection and dragging replace only affected nodes and skip unchanged updates', () => {
    const first = toFlowNode(view, undefined, false, undefined)
    const second = toFlowNode({ ...view, nodeId: 'second' }, undefined, false, undefined)
    const nodes = [first, second]
    const selected = selectFlowNodes(nodes, new Set(['text']))
    expect(selected[0]).not.toBe(first)
    expect(selected[1]).toBe(second)
    expect(selectFlowNodes(selected, new Set(['text']))).toBe(selected)
    const moved = moveFlowNodes(selected, new Map([['text', { x: 80, y: 60 }]]))
    expect(moved[0]!.position).toEqual({ x: 80, y: 60 })
    expect(moved[1]).toBe(second)
    expect(moveFlowNodes(moved, new Map([['text', { x: 80, y: 60 }]]))).toBe(moved)
  })
})
