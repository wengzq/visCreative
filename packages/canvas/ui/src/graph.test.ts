import { describe, expect, it } from 'vitest'
import { FrameColor, type NodeView } from '@vis/protocol'
import { extensionPosition, freePosition, inputEdges, NODE_GAP, FRAME_COLORS, frameMembers, frameMoveBatch, frameMoveOps } from './graph'

const node = (nodeId: string, extra: Partial<NodeView> = {}): NodeView => ({
  nodeId, kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 0, layoutRevision: 0, slots: [], ...extra,
})

describe('Canvas relationships and positions', () => {
  it('Reuses edges across content and unrelated layout changes but tracks relationships, sides, selection and locale', () => {
    const source = node('source')
    const target = node('target', { inputs: ['source'], x: 500 })
    const other = node('other')
    const nodes = [source, target, other]
    const edges = inputEdges(nodes, new Set(), 'en')
    expect(inputEdges([{ ...source, title: 'New title', slots: [{ slotId: 'text', slotKey: 'main', contentType: 'text', revision: 1, content: { type: 'text', body: 'Changed text' } }] }, target, { ...other, x: 100 }], new Set(), 'en', edges)).toBe(edges)
    expect(inputEdges([source, { ...target, inputs: [] }, other], new Set(), 'en', edges)).toHaveLength(0)
    expect(inputEdges([{ ...source, y: 900 }, target, other], new Set(), 'en', edges)[0]).not.toBe(edges[0])
    expect(inputEdges(nodes, new Set(['target']), 'en', edges)[0]).not.toBe(edges[0])
    expect(inputEdges(nodes, new Set(), 'zh-CN', edges)[0]).not.toBe(edges[0])
    const both = inputEdges(nodes, new Set(['source', 'target']), 'en')
    expect(inputEdges(nodes, new Set(['target', 'source']), 'en', both)).toBe(both)
    expect(inputEdges([source, { ...target, slots: [{ slotId: 'main', slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'empty' }, source: { jobId: 'job', inputNodeIds: ['source'] } }] }, other], new Set(), 'en', edges)[0]).not.toBe(edges[0])
  })

  it('Reuses another relation when only one relation changes its highlighted state', () => {
    const nodes = [node('a'), node('b', { inputs: ['a'] }), node('c', { inputs: ['a'] })]
    const edges = inputEdges(nodes, new Set(['b']), 'en')
    const next = inputEdges(nodes, new Set(['b', 'c']), 'en', edges)
    expect(next[0]).toBe(edges[0])
    expect(next[1]).not.toBe(edges[1])
  })

  it('Dashed provenance edges take precedence over duplicate inputs and filter self and deleted nodes', () => {
    const source = node('source')
    const target = node('target', {
      x: 400, inputs: ['source', 'other', 'other', 'target', 'deleted'],
      slots: [{ slotId: 'main', slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'empty' }, source: { jobId: 'job', inputNodeIds: ['source'] } }],
    })
    const edges = inputEdges([source, node('other', { y: -500 }), target])
    expect(edges).toHaveLength(2)
    expect(edges[0]).toMatchObject({ id: 'source-source-target', sourceHandle: 'out-right', targetHandle: 'in-left', style: { strokeDasharray: '6 4' } })
    expect(edges[1]!.id).toBe('input-other-target')
    expect(edges[1]!.style).toEqual({ stroke: 'var(--vis-input-edge)', strokeWidth: 1 })
    expect(edges[1]!.style).not.toHaveProperty('strokeDasharray')
  })

  it('Left and right expansion keeps an 80 gap and moves downward around nodes of different dimensions', () => {
    const anchor = node('anchor')
    expect(extensionPosition(anchor, 'image', [anchor])).toEqual({ x: 400, y: 0 })
    expect(extensionPosition(anchor, 'text', [anchor])).toEqual({ x: -400, y: 60 })
    const blocker = node('blocker', { x: 400, h: 600 })
    expect(extensionPosition(anchor, 'video', [anchor, blocker])).toEqual({ x: 400, y: blocker.h + NODE_GAP })
  })

  it('Creation at the center skips the full width of occupied nodes', () => {
    expect(freePosition({ x: 20, y: 20 }, { w: 320, h: 200 }, [node('wide', { w: 1600 })], 'x')).toEqual({ x: 1680, y: 20 })
  })
})

describe('Canvas frames', () => {
  it('Recursive membership ignores geometric overlap; cycles never move the root node twice', () => {
    const nodes = [node('outer', { kind: 'frame', frameId: 'inner' }), node('inner', { kind: 'frame', frameId: 'outer' }), node('text', { frameId: 'inner' }), node('outside')]
    expect(frameMembers('outer', nodes).map(n => n.nodeId)).toEqual(['inner', 'text'])
    expect(frameMoveOps(nodes, [{ nodeId: 'outer', x: 50, y: -20 }, { nodeId: 'inner', x: 50, y: -20 }])).toEqual([{ op: 'frame.move', nodeId: 'outer', dx: 50, dy: -20 }])
    expect(frameMoveBatch(nodes, [{ nodeId: 'outer', x: 50, y: -20 }, { nodeId: 'inner', x: 50, y: -20 }])).toEqual([
      { nodeId: 'outer', x: 50, y: -20, w: 320, h: 320 },
      { nodeId: 'inner', x: 50, y: -20, w: 320, h: 320 },
      { nodeId: 'text', x: 50, y: -20, w: 320, h: 320 },
    ])
  })
  it('Moving preserves member offsets, dimensions, and external node positions', () => {
    const nodes = [node('frame', { kind: 'frame', x: 100 }), node('member', { frameId: 'frame', x: 140, y: 50, h: 200 }), node('outside')]
    expect(frameMoveBatch(nodes, [{ nodeId: 'frame', x: 120.4, y: 30.2 }])).toEqual([
      { nodeId: 'frame', x: 120, y: 30, w: 320, h: 320 }, { nodeId: 'member', x: 160, y: 80, w: 320, h: 200 },
    ])
    expect(nodes[1]!.x).toBe(140)
  })
  it('All contract colors map to theme variables; automatic placement does not avoid frames', () => {
    expect(Object.keys(FRAME_COLORS)).toEqual(FrameColor.options)
    for (const color of FrameColor.options) expect(FRAME_COLORS[color]).toContain(`--vis-frame-${color}`)
    expect(freePosition({ x: 20, y: 20 }, { w: 320, h: 200 }, [node('frame', { kind: 'frame', w: 1600 })], 'x')).toEqual({ x: 20, y: 20 })
  })
})


it('Frame moves submit one operation; selected recursive members are not moved twice', () => {
  const nodes = [node('outer', { kind: 'frame', x: 100 }), node('inner', { kind: 'frame', frameId: 'outer' }),
    ...Array.from({ length: 220 }, (_, i) => node(`member-${i}`, { frameId: 'inner' })), node('outside')]
  expect(frameMoveOps(nodes, [{ nodeId: 'outer', x: 150, y: 60 }, { nodeId: 'inner', x: 50, y: 60 },
    { nodeId: 'member-0', x: 50, y: 60 }, { nodeId: 'outside', x: 50, y: 60 }])).toEqual([
    { op: 'frame.move', nodeId: 'outer', dx: 50, dy: 60 }, { op: 'node.layout', nodeId: 'outside', x: 50, y: 60 },
  ])
})


it('Frame move previews preserve fractional member positions and match server-relative displacement', () => {
  const nodes = [node('frame', { kind: 'frame', x: 0.3 }), node('member', { frameId: 'frame', x: 0.4, y: 0.7 })]
  const moves = [{ nodeId: 'frame', x: 10.2, y: 20.2 }]
  const op = frameMoveOps(nodes, moves)[0]!
  expect(op).toEqual({ op: 'frame.move', nodeId: 'frame', dx: 9.7, dy: 20 })
  const batch = frameMoveBatch(nodes, moves)
  expect(batch[1]!.x).toBeCloseTo(10.1)
  expect(batch[1]!.y).toBeCloseTo(20.7)
})


it('Selecting a child frame with fractional coordinates first still previews the parent frame\'s submitted displacement', () => {
  const nodes = [node('outer', { kind: 'frame' }), node('inner', { kind: 'frame', frameId: 'outer', x: 0.4 })]
  const batch = frameMoveBatch(nodes, [{ nodeId: 'inner', x: 10.6, y: 0 }, { nodeId: 'outer', x: 10.2, y: 0 }])
  expect(batch.find(n => n.nodeId === 'inner')!.x).toBe(10.4)
})


it('Selecting one or more nodes emphasizes only directly connected provenance and references; deselection restores them', () => {
  const nodes = [node('a'), node('b', { inputs: ['a'] }), node('c', { inputs: ['b'] }), node('d', { inputs: ['c'] })]
  nodes[1]!.slots = [{ slotId: 'main', slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'empty' }, source: { jobId: 'job', inputNodeIds: ['a'] } }]
  const selected = inputEdges(nodes, new Set(['a', 'd']))
  expect(selected.map(edge => edge.style?.opacity)).toEqual([1, 0.2, 1])
  expect(selected[0]!.ariaLabel).toContain('来源连线（已高亮）')
  expect(selected[0]!.style).toMatchObject({ stroke: 'var(--vis-accent)', strokeDasharray: '6 4', strokeWidth: 2.5 })
  expect(selected[1]!.ariaLabel).not.toContain('已高亮')
  expect(inputEdges(nodes, new Set(['b'])).map(edge => edge.style?.opacity)).toEqual([1, 1, 0.2])
  expect(inputEdges(nodes).every(edge => edge.style?.opacity === undefined && edge.style?.strokeWidth === 1)).toBe(true)
})

it('Edge accessibility labels follow the language without translating node IDs', () => {
  const nodes = [node('原图'), node('target', { inputs: ['原图'] })]
  expect(inputEdges(nodes, new Set(['target']), 'en')[0]!.ariaLabel).toBe('Reference connection (highlighted): 原图 → target')
  expect(inputEdges(nodes, new Set(['target']), 'zh-CN')[0]!.ariaLabel).toBe('参考连线（已高亮）：原图 → target')
})
