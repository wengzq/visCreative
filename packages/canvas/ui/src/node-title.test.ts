import { expect, it } from 'vitest'
import { nodeTitleNumber, nodeTitleNumbers } from './node-title'

it('numbers default titles by canvas z order within each kind, including explicit titles', () => {
  const nodes = [
    { nodeId: 'later', kind: 'image', z: 5 },
    { nodeId: 'text', kind: 'text', z: 1 },
    { nodeId: 'first', kind: 'image', z: 0, title: 'Named' },
  ]
  expect(nodeTitleNumber(nodes[0]!, nodes)).toBe(2)
  expect(nodeTitleNumber(nodes[2]!, nodes)).toBe(1)
  expect(nodeTitleNumber({ nodeId: 'missing', kind: 'image' }, nodes)).toBe(1)
  const numbers = nodeTitleNumbers(nodes)
  for (const node of nodes) expect(numbers.get(node.nodeId)).toBe(nodeTitleNumber(node, nodes))
})
