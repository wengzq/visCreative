import { describe, expect, it } from 'vitest'
import type { NodeKind, NodeView } from '@vis/protocol'
import { readingOrder } from './Lightbox'
import { mediaTime } from './VideoPlayer'

const node = (nodeId: string, x: number, y: number, kind: NodeKind = 'image'): NodeView => ({
  nodeId, kind, x, y, w: 100, h: 100, z: 0, layoutRevision: 1,
  slots: [{ slotId: nodeId, slotKey: 'main', contentType: kind, revision: 1, content: kind === 'text' ? { type: 'text', body: '' } : { type: 'asset', assetVersionId: nodeId, mime: 'image/png' } }],
})

describe('Preview reading order', () => {
  it('Group rows within an 80px tolerance from the row top, sort by x within rows, and exclude text and empty media', () => {
    const empty = { ...node('empty', 0, 0), slots: [] }
    const nodes = [node('right', 200, 0), node('next', -100, 81), node('left', 0, 80), node('text', -200, 0, 'text'), empty]
    expect(readingOrder(nodes).map(n => n.nodeId)).toEqual(['left', 'right', 'next'])
    expect(nodes[0]!.nodeId).toBe('right')
  })
})

describe('Media duration', () => {
  it('Timecodes retain minutes, seconds, and zero padding without digit grouping', () => {
    expect(mediaTime(0)).toBe('0:00')
    expect(mediaTime(61.9)).toBe('1:01')
    expect(mediaTime(3600)).toBe('60:00')
    expect(mediaTime(60000)).toBe('1000:00')
  })
})
