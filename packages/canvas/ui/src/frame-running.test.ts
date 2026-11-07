import { expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { frameRunningStates } from './frame-running'

it('Marks all ancestor frames once, including running frames, without scanning each frame membership', () => {
  const nodes = [
    { nodeId: 'outer', kind: 'frame' },
    { nodeId: 'inner', kind: 'frame', frameId: 'outer' },
    { nodeId: 'first', kind: 'text', frameId: 'inner' },
    { nodeId: 'second', kind: 'image', frameId: 'inner' },
    { nodeId: 'idle', kind: 'frame' },
  ] as NodeView[]
  const decorations = new Map([['first', { running: 1, problems: [] }], ['second', { running: 1, problems: [] }]])
  expect([...frameRunningStates(nodes, decorations)]).toEqual([['inner', true], ['outer', true]])
  expect([...frameRunningStates(nodes, new Map([['inner', { running: 1, problems: [] }]]))]).toEqual([['outer', true]])
  expect([...frameRunningStates(nodes, undefined)]).toEqual([])
})
