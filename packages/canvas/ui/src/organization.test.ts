import { describe, expect, it } from 'vitest'
import { CanvasOp, type NodeView } from '@vis/protocol'
import { arrangeCanvas } from './organization'
import { growFrames } from './frameBounds'

const node = (nodeId: string, extra: Partial<NodeView> = {}): NodeView => ({
  nodeId, kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 0, layoutRevision: 0, slots: [], ...extra,
})
const frame = (nodeId: string, title: string, extra: Partial<NodeView> = {}) => node(nodeId, {
  kind: 'frame', w: 1000, h: 1200, frame: { title, color: 'gray' }, ...extra,
})
const finalNodes = (nodes: NodeView[], ops: CanvasOp[]) => nodes.map(node => ({
  ...node, ...ops.filter(op => op.op === 'node.layout' && op.nodeId === node.nodeId)
    .reduce((layout, op) => ({ ...layout, ...op }), {}),
}))
const overlap = (a: NodeView, b: NodeView) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('Organize canvas by category', () => {
  it('Create category frames and unify group widths while preserving content and relationships in a single layout batch', () => {
    const nodes = [node('small', { category: '人物', w: 250 }), node('wide', { category: '人物', w: 400 }), node('uncategorized')]
    const before = structuredClone(nodes)
    const plan = arrangeCanvas(nodes)
    expect(plan.groups.map(group => group.category)).toEqual(['人物', '未分类'])
    expect(plan.groups[0]!.nodeIds).toEqual(['small', 'wide'])
    expect(plan.ops.filter(op => op.op === 'frame.create')).toHaveLength(2)
    expect(plan.ops.every(op => op.op === 'node.layout' || op.op.startsWith('frame.'))).toBe(true)
    expect(plan.ops.every(op => CanvasOp.safeParse(op).success)).toBe(true)
    expect(nodes).toEqual(before)
    const placed = finalNodes(nodes, plan.ops)
    expect(placed.slice(0, 2).map(node => node.w)).toEqual([400, 400])
    expect(placed.every((node, index) => placed.every((other, otherIndex) => index === otherIndex || !overlap(node, other)))).toBe(true)
    for (const group of plan.groups) for (const id of group.nodeIds) {
      const item = placed.find(node => node.nodeId === id)!
      expect(item.x).toBeGreaterThanOrEqual(group.x + 24)
      expect(item.y).toBeGreaterThanOrEqual(group.y + 56)
      expect(item.x + item.w).toBeLessThanOrEqual(group.x + group.w - 24)
      expect(item.y + item.h).toBeLessThanOrEqual(group.y + group.h - 24)
    }
  })

  it('Upstream provenance and reference partitions sit on the left; input order does not affect the result', () => {
    const nodes = [node('video', { category: '镜头', inputs: ['person'] }), node('person', { category: '人物' }), node('scene', { category: '场景' })]
    nodes[0]!.slots = [{ slotId: 'main', slotKey: 'main', contentType: 'video', revision: 1, content: { type: 'empty' },
      source: { jobId: 'job', inputNodeIds: ['scene', 'scene', 'missing', 'video'] } }]
    const plan = arrangeCanvas(nodes)
    const x = (category: string) => plan.groups.find(group => group.category === category)!.x
    expect(x('人物')).toBeLessThan(x('镜头'))
    expect(x('场景')).toBeLessThan(x('镜头'))
    expect(arrangeCanvas([...nodes].reverse())).toEqual(plan)
  })

  it('Cyclic partitions converge stably; upstream and downstream partitions outside the cycle remain on opposite sides', () => {
    const nodes = [node('a', { category: 'A', inputs: ['b', 'source'] }), node('b', { category: 'B', inputs: ['a'] }),
      node('source', { category: 'Z' }), node('target', { category: 'C', inputs: ['b'] })]
    const plan = arrangeCanvas(nodes)
    expect(plan.groups.map(group => group.category)).toEqual(['Z', 'A', 'B', 'C'])
    expect(arrangeCanvas([...nodes].reverse())).toEqual(plan)
  })

  it('Work documents are never organized or treated as obstacles', () => {
    const artifact = node('artifact', { category: '文案' })
    const working = node('working', { purpose: 'working', x: -10000, y: -10000, w: 100000, h: 100000, category: '计划' })
    expect(arrangeCanvas([working, artifact])).toEqual(arrangeCanvas([artifact]))
    expect(arrangeCanvas([working], new Set(['working']))).toEqual({ ops: [], groups: [], removedFrames: [] })
    expect(arrangeCanvas([frame('f', '空框')]).ops).toEqual([{ op: 'node.delete', nodeId: 'f' }])
  })

  it('Partial selection preserves unselected members and original frame positions; the grid avoids unselected nodes and other frames', () => {
    const nodes = [frame('people', '人物', { x: 100, y: 200 }),
      node('selected', { category: '人物', x: 600, y: 300, frameId: 'people' }),
      node('fixed', { x: 124, y: 256, frameId: 'people', h: 700 }),
      node('outside', { x: 524, y: 1100 }), frame('nested', '嵌套', { x: 124, y: 1500, w: 600, h: 300, frameId: 'people' })]
    const plan = arrangeCanvas(nodes, new Set(['selected']))
    const placed = finalNodes(nodes, plan.ops)
    const group = plan.groups[0]!
    expect(group.frameId).toBe('people')
    expect(group).toMatchObject({ x: 100, y: 200, w: 1000 })
    expect(plan.ops.filter(op => 'nodeId' in op).every(op => 'nodeId' in op && ['people', 'selected'].includes(op.nodeId))).toBe(true)
    expect(placed.filter(node => !['people', 'selected'].includes(node.nodeId))).toEqual(nodes.filter(node => !['people', 'selected'].includes(node.nodeId)))
    expect(nodes.slice(2).every(obstacle => !overlap(placed[1]!, obstacle))).toBe(true)
    expect(placed[1]!.y + placed[1]!.h).toBeLessThanOrEqual(group.y + group.h - 24)
  })

  it('New partitions for partial selection avoid all visible unselected outputs without changing their layout', () => {
    const nodes = [node('chosen', { category: '镜头' }), node('fixed', { w: 800, h: 2000 }), frame('fixed-frame', '其他', { x: 1000, w: 1000 })]
    const plan = arrangeCanvas(nodes, new Set(['chosen']))
    const placed = finalNodes(nodes, plan.ops)
    expect(placed[1]).toEqual(nodes[1])
    expect(placed[2]).toEqual(nodes[2])
    expect(nodes.slice(1).every(obstacle => !overlap(placed[0]!, obstacle))).toBe(true)
  })

  it('Nested partitions do not avoid their ancestors; expanding ancestors in the same batch needs no extra undo batch', () => {
    const nodes = [frame('outer', '总览', { w: 1500, h: 1800 }), frame('people', '人物', { x: 24, y: 56, w: 1000, h: 1600, frameId: 'outer' }),
      node('chosen', { category: '人物', x: 400, y: 800, frameId: 'people' }), node('fixed', { x: 48, y: 112, h: 1300, frameId: 'people' })]
    const plan = arrangeCanvas(nodes, new Set(['chosen']))
    expect(plan.groups[0]).toMatchObject({ frameId: 'people', x: 24, y: 56 })
    const placed = finalNodes(nodes, plan.ops)
    expect(placed[0]!.h).toBeGreaterThan(1800)
    expect(growFrames(placed)).toEqual([])
    expect(placed[3]).toEqual(nodes[3])
  })

  it('New partitions stay vertical; manually widened frames retain their proportions', () => {
    for (const kind of ['text', 'image', 'audio'] as const) {
      for (const count of [1, 2, 3, 4]) {
        const plan = arrangeCanvas(Array.from({ length: count }, (_, index) => node(`${index}`, { kind, h: 140 })))
        expect(plan.groups[0]!.h).toBeGreaterThanOrEqual(plan.groups[0]!.w)
      }
    }
    const plan = arrangeCanvas([frame('f', '人物', { w: 2400, h: 500 }), node('a', { category: '人物' })])
    expect(plan.groups[0]).toMatchObject({ w: 2400, h: 500 })
  })

  it('Existing frame dimensions only grow; sufficiently large manual dimensions remain unchanged', () => {
    const nodes = [frame('people', '人物', { x: -100, y: -200, w: 2400, h: 4000 }), node('person', { category: '人物', x: 100, y: 100, frameId: 'people' })]
    const plan = arrangeCanvas(nodes)
    expect(plan.groups).toEqual([{ category: '人物', frameId: 'people', nodeIds: ['person'], x: -100, y: -200, w: 2400, h: 4000 }])
    expect(plan.ops.some(op => op.op === 'frame.create')).toBe(false)
    expect(plan.ops.some(op => op.op === 'node.layout' && op.nodeId === 'people')).toBe(false)
    const small = arrangeCanvas([frame('small', '人物', { w: 320, h: 200 }), node('person', { category: '人物', h: 800 })])
    expect(small.groups[0]!.w).toBeGreaterThanOrEqual(320)
    expect(small.groups[0]!.h).toBeGreaterThanOrEqual(880)
  })

  it('Empty selection organizes everything; identical layouts generate no duplicate operations', () => {
    const nodes = [frame('f', '人物', { x: 0, y: 0, w: 368, h: 400 }), node('a', { category: '人物', x: 24, y: 56, frameId: 'f' })]
    expect(arrangeCanvas(nodes, new Set())).toEqual(arrangeCanvas(nodes))
    expect(arrangeCanvas(nodes).ops).toEqual([])
  })

  it('The operation limit includes new frames; more than 200 operations fails explicitly instead of splitting batches', () => {
    expect(arrangeCanvas(Array.from({ length: 199 }, (_, index) => node(`item-${index}`))).ops).toHaveLength(200)
    expect(() => arrangeCanvas(Array.from({ length: 200 }, (_, index) => node(`item-${index}`)))).toThrow('超过单次 200 条上限')
  })

  it('Temporary IDs for new frames do not shadow existing node IDs, including hidden nodes', () => {
    const plan = arrangeCanvas([node('organize-frame-0'), node('organize-frame-1', { purpose: 'working' })])
    expect(plan.groups[0]!.frameId).toBe('organize-frame-2')
    expect(plan.ops).toContainEqual(expect.objectContaining({ op: 'node.layout', nodeId: 'organize-frame-0' }))
  })
})

it('English organization translates only the uncategorized title, preserving existing categories and node data', () => {
  const nodes = [node('categorized', { category: '人物' }), node('uncategorized')]
  const before = structuredClone(nodes)
  const plan = arrangeCanvas(nodes, undefined, 'en')
  expect(plan.groups.map(group => group.category)).toEqual(['Uncategorized', '人物'])
  expect(plan.ops.filter(op => op.op === 'frame.create').map(op => op.title)).toEqual(['Uncategorized', '人物'])
  expect(nodes).toEqual(before)
  expect(() => arrangeCanvas(Array.from({ length: 200 }, (_, index) => node(`item-${index}`)), undefined, 'en')).toThrow('Organizing requires 201 operations')
})

it('Reuse uncategorized frames after switching languages, preferring the current language without changing old titles', () => {
  const nodes = [frame('zh-frame', '未分类'), node('uncategorized', { x: 24, y: 56, frameId: 'zh-frame' })]
  expect(arrangeCanvas(nodes).ops.some(op => op.op === 'frame.create')).toBe(false)
  const english = arrangeCanvas(nodes, undefined, 'en')
  expect(english.groups[0]!.frameId).toBe('zh-frame')
  expect(english.ops.some(op => op.op === 'frame.create')).toBe(false)
  expect(nodes[0]!.frame!.title).toBe('未分类')
  const both = [...nodes, frame('en-frame', 'Uncategorized', { x: 2000 })]
  expect(arrangeCanvas(both, undefined, 'en').groups[0]!.frameId).toBe('en-frame')
  expect(arrangeCanvas(both, undefined, 'zh-CN').groups[0]!.frameId).toBe('zh-frame')
  expect(arrangeCanvas([frame('en-frame', 'Uncategorized'), node('uncategorized')]).groups[0]!.frameId).toBe('en-frame')
})

it('Cross-language uncategorized frame fallback does not claim a frame belonging to another existing category', () => {
  const plan = arrangeCanvas([frame('zh-frame', '未分类'), node('explicit', { category: '未分类' }), node('uncategorized')], undefined, 'en')
  expect(plan.groups.find(group => group.category === '未分类')!.frameId).toBe('zh-frame')
  expect(new Set(plan.groups.map(group => group.frameId)).size).toBe(2)
})

it('removes frames emptied by tidy, including old empty frames, while retaining targets and every member', () => {
  const nodes = [frame('old', 'Old'), frame('empty', 'Empty'), frame('target', 'Art'), node('art', { category: 'Art', frameId: 'old' })]
  const plan = arrangeCanvas(nodes)
  expect(plan.removedFrames.map(frame => frame.nodeId)).toEqual(['empty', 'old'])
  expect(plan.ops.filter(op => op.op === 'node.delete')).toEqual([{ op: 'node.delete', nodeId: 'empty' }, { op: 'node.delete', nodeId: 'old' }])
  expect(plan.groups[0]?.frameId).toBe('target')
  expect(plan.ops.every(op => op.op !== 'node.delete' || nodes.find(node => node.nodeId === op.nodeId)?.kind === 'frame')).toBe(true)
  expect(arrangeCanvas([frame('empty', 'Empty')]).ops).toEqual([{ op: 'node.delete', nodeId: 'empty' }])
})

it('selected tidy only removes frames it emptied and keeps frames with unselected or working members', () => {
  const nodes = [frame('old', 'Old'), frame('empty', 'Empty'), frame('partial', 'Partial'),
    node('selected', { category: 'Art', frameId: 'old' }), node('selected2', { category: 'Art', frameId: 'partial' }), node('keep', { frameId: 'partial' })]
  expect(arrangeCanvas(nodes, new Set(['selected', 'selected2'])).removedFrames.map(frame => frame.nodeId)).toEqual(['old'])
  expect(arrangeCanvas([...nodes, node('working', { frameId: 'old', purpose: 'working' })]).removedFrames.map(frame => frame.nodeId)).not.toContain('old')
})

it('removes emptied ancestors of relocated category frames while retaining untouched nested empty frames in selected tidy', () => {
  const nodes = [frame('outer', 'Outer'), frame('target', 'Art', { frameId: 'outer' }), node('art', { category: 'Art', frameId: 'target' })]
  expect(arrangeCanvas(nodes).removedFrames.map(frame => frame.nodeId)).toEqual(['outer'])
  expect(arrangeCanvas(nodes, new Set(['art'])).removedFrames.map(frame => frame.nodeId)).toEqual(['outer'])
  expect(arrangeCanvas([...nodes, node('working', { frameId: 'target', purpose: 'working' })]).removedFrames).toEqual([])
  expect(arrangeCanvas([...nodes, frame('empty', 'Empty', { frameId: 'target' })], new Set(['art'])).removedFrames).toEqual([])
  const nested = [frame('outer', 'Outer'), frame('empty', 'Empty', { frameId: 'outer' }), node('art', { category: 'Art', frameId: 'outer' })]
  expect(arrangeCanvas(nested, new Set(['art'])).removedFrames).toEqual([])
  expect(arrangeCanvas(nested).removedFrames.map(frame => frame.nodeId)).toEqual(['empty', 'outer'])
})
