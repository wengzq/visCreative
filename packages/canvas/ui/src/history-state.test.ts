import type { NodeView, SlotVersionView } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { historySelection } from './history-state'

const view: NodeView = { nodeId: 'own', kind: 'image', x: 0, y: 0, w: 320, h: 240, z: 0, layoutRevision: 0, slots: [] }
const version = (revision: number): SlotVersionView => ({
  revision, content: { type: 'asset', assetVersionId: 'asset-' + revision, mime: 'image/png' },
  createdAt: 0, actor: 'user', isCurrent: false,
})

describe('Canvas history snapshots', () => {
  it('Keeps object identity for other slots and reads an own-slot change from the published snapshot', () => {
    const own = [version(1)]
    let state = { nodes: new Map([['own', view]]), histories: new Map([['slot', own]]) }
    const source = { getSnapshot: () => state, subscribe: () => () => {} }
    const getSnapshot = historySelection(source, view, 'slot', undefined)
    expect(getSnapshot()).toBe(own)
    state = { ...state, histories: new Map([...state.histories, ['other', [version(2)]]]) }
    expect(getSnapshot()).toBe(own)
    const next = [version(1), version(2)]
    state = { ...state, histories: new Map([['slot', next]]) }
    expect(getSnapshot()).toBe(next)
  })

  it('Keeps the last returned history until React receives the matching node version', () => {
    const first = [version(1)]
    const second = [version(1), version(2)]
    let state = { nodes: new Map([['own', view]]), histories: new Map([['slot', first]]) }
    const source = { getSnapshot: () => state, subscribe: () => () => {} }
    const getSnapshot = historySelection(source, view, 'slot', first)
    state = { ...state, histories: new Map([['slot', second]]) }
    expect(getSnapshot()).toBe(second)
    const revised = { ...view, title: 'Revised' }
    const third = [version(3)]
    state = { nodes: new Map([['own', revised]]), histories: new Map([['slot', third]]) }
    expect(getSnapshot()).toBe(second)
    expect(historySelection(source, revised, 'slot', first)()).toBe(third)
    state = { nodes: new Map(), histories: new Map() }
    expect(getSnapshot()).toBe(second)
  })

  it('Uses immutable prop histories without an external source and delivers invalidation', () => {
    const fallback = [version(1)]
    expect(historySelection(undefined, view, 'slot', fallback)()).toBe(fallback)
    const source = { getSnapshot: () => ({ nodes: new Map([['own', view]]), histories: new Map() }), subscribe: () => () => {} }
    expect(historySelection(source, view, 'slot', fallback)()).toBeUndefined()
  })
})
