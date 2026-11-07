import { describe, expect, it } from 'vitest'
import { EMPTY_PREVIZ, EMPTY_SCRIPT, emptyPrevizPanel, type NodeView } from '@vis/protocol'
import { newestBlockout, orderedPanelLinks, panelShot, previzScripts, shotBlockouts } from './previz'

const script: NodeView = { nodeId: 'script', kind: 'script', title: 'Street', x: 0, y: 0, w: 480, h: 320, z: 1, layoutRevision: 1,
  slots: [{ slotId: 'script-main', slotKey: 'main', contentType: 'script', revision: 1, content: { type: 'script', doc: { ...EMPTY_SCRIPT, shots: ['a', 'b'].map(id => ({ id, rev: 1, description: id, transition: 'cut', characterIds: [], propIds: [] })) } } }] }

describe('Previz shot links', () => {
  it('previews order-based links without modifying the document, preserves existing links and leaves extra panels unlinked', () => {
    const scripts = previzScripts([script])
    const doc = { ...EMPTY_PREVIZ, panels: [
      { ...emptyPrevizPanel('one'), shot: { scriptNodeId: 'script', shotId: 'b' } }, emptyPrevizPanel('two'), emptyPrevizPanel('extra'),
    ] }
    const before = structuredClone(doc)
    const preview = orderedPanelLinks(doc, scripts[0]!, false)
    expect(doc).toEqual(before)
    expect(preview.panels.map(panel => panel.shot)).toEqual([{ scriptNodeId: 'script', shotId: 'b' }, { scriptNodeId: 'script', shotId: 'b' }, null])
    const replaced = orderedPanelLinks(doc, scripts[0]!, true)
    expect(replaced.panels.map(panel => panel.shot)).toEqual([{ scriptNodeId: 'script', shotId: 'a' }, { scriptNodeId: 'script', shotId: 'b' }, null])
    expect(panelShot(replaced.panels[0]!, scripts)?.index).toBe(0)
    expect(panelShot({ ...doc.panels[0]!, shot: { scriptNodeId: 'deleted', shotId: 'b' } }, scripts)).toBeNull()
    expect(panelShot({ ...doc.panels[0]!, shot: { scriptNodeId: 'script', shotId: 'deleted' } }, scripts)).toBeNull()
  })
})


it('associates only completed input-linked blockouts, choosing the newest and excluding finished shot outputs', () => {
  const video = (time: string, overrides: Partial<NodeView> = {}): NodeView => ({ ...script, nodeId: `node_${time}AAAAAAAAAAAAAAAA`, kind: 'video', inputs: ['board'],
    slots: [{ slotId: 'video-main', slotKey: 'main', contentType: 'video', revision: 1, content: { type: 'asset', assetVersionId: time, mime: 'video/mp4' } }], ...overrides })
  const old = video('0000000001', { shot: { scriptNodeId: 'script', shotId: 'a', role: 'previz' } })
  const latest = video('0000000002')
  const final = video('0000000003', { shot: { scriptNodeId: 'script', shotId: 'a', role: 'video' } })
  const unrelated = video('0000000004', { inputs: ['other-board'] })
  const pending = video('0000000005', { slots: [] })
  expect(newestBlockout([latest, pending, old, final, unrelated], 'board')).toEqual(latest)
  expect(newestBlockout([old, latest], 'other-board')).toBeUndefined()
  expect(newestBlockout([old, final], 'board')).toEqual(old)
})

it('finds every shot of a blockout through its previz panels', () => {
  const slot = (content: unknown) => [{ slotId: 'main', slotKey: 'main', contentType: 'previz', revision: 1, content }]
  const panels = ['a', 'b'].map(shotId => ({ ...emptyPrevizPanel(shotId), shot: { scriptNodeId: 'script', shotId } }))
  const other = { ...emptyPrevizPanel('c'), shot: { scriptNodeId: 'other', shotId: 'c' } }
  const previz = { nodeId: 'previz', kind: 'previz', slots: slot({ type: 'previz', doc: { ...EMPTY_PREVIZ, panels: [...panels, other] } }) } as unknown as NodeView
  const video = (nodeId: string, shot?: NodeView['shot']) => ({ nodeId, kind: 'video', inputs: ['previz'], shot, slots: slot({ type: 'asset', assetVersionId: nodeId }) }) as unknown as NodeView
  const found = shotBlockouts([previz, video('node_01AAA0000000'), video('node_01BBB0000000')], 'script')
  expect([...found.keys()]).toEqual(['a', 'b'])
  expect(found.get('a')?.nodeId).toBe('node_01BBB0000000')
  // A finished shot output that happens to use the previz as input is not a blockout.
  expect(shotBlockouts([previz, video('node_01FINAL00000', { scriptNodeId: 'script', shotId: 'a', role: 'video' })], 'script').size).toBe(0)
})
