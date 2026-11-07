import { describe, expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { constrainedMoves, growFrames, leaveFrameOps, memberMoveOps } from './frameBounds'

const node = (nodeId: string, extra: Partial<NodeView> = {}): NodeView => ({ nodeId, kind: 'text', x: 40, y: 70, w: 100, h: 80, z: 0, layoutRevision: 0, slots: [], ...extra })
const frame = node('frame', { kind: 'frame', x: 0, y: 0, w: 400, h: 300 })
const child = node('child', { frameId: 'frame' })

describe('Frame bounds', () => {
  it('All four boundaries include padding; modifier keys allow crossing them', () => {
    const moves = [{ nodeId: 'child', x: 999, y: -300 }]
    expect(constrainedMoves([frame, child], moves)).toEqual([{ nodeId: 'child', x: 276, y: 56 }])
    expect(constrainedMoves([frame, child], moves, true)).toEqual(moves)
    expect(constrainedMoves([frame, child], [{ nodeId: 'child', x: -90, y: 900 }])).toEqual([{ nodeId: 'child', x: 24, y: 196 }])
  })
  it('Nested frames are constrained by their parent; moving parent and child together applies no separate constraint', () => {
    const inner = { ...child, kind: 'frame' as const }
    expect(constrainedMoves([frame, inner], [{ nodeId: 'child', x: 900, y: 800 }])[0]).toMatchObject({ x: 276, y: 196 })
    expect(constrainedMoves([frame, inner], [{ nodeId: 'frame', x: 900, y: 800 }, { nodeId: 'child', x: 940, y: 870 }])[1]).toMatchObject({ x: 940, y: 870 })
    expect(memberMoveOps([frame, child], [{ nodeId: 'frame', x: 900, y: 800 }])).toEqual([{ op: 'frame.move', nodeId: 'frame', dx: 900, dy: 800 }, { op: 'node.layout', nodeId: 'frame', x: 900, y: 800 }])
  })
  it('Expand from inside out without shrinking user dimensions or changing node content', () => {
    const inner = node('inner', { kind: 'frame', frameId: 'frame', x: 100, y: 100, w: 320, h: 200 })
    const large = node('large', { frameId: 'inner', x: 120, y: 150, w: 500, h: 400 })
    const ops = growFrames([frame, inner, large])
    expect(ops[0]).toMatchObject({ nodeId: 'inner', x: 96, y: 94, w: 548, h: 480 })
    expect(ops[1]).toMatchObject({ nodeId: 'frame', w: 668, h: 598 })
    expect(growFrames([frame, child])).toEqual([])
    expect(growFrames([frame])).toEqual([])
    expect(frame.w).toBe(400)
  })
  it('Move outside the frame with nested members following', () => {
    expect(leaveFrameOps(child, [frame, child])).toEqual([{ op: 'node.layout', nodeId: 'child', x: 480, y: 70 }])
    expect(leaveFrameOps(node('free'), [frame])).toEqual([])
  })
})
