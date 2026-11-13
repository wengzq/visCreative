import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocaleProvider, type Locale } from '@vis/ui-kit'
import { CanvasView, selectCanvasNode, type CanvasViewProps } from './CanvasView'
import { OrganizationPreview } from './OrganizationPreview'
import type { NodeView } from '@vis/protocol'
import { numberedReferences } from './prompt-references'

const render = (locale: Locale) => renderToStaticMarkup(createElement(LocaleProvider, {
  locale, setLocale() {}, children: createElement(CanvasView, { nodes: [], assetUrl: (id: string) => id } as unknown as CanvasViewProps),
}))

describe('Canvas UI language', () => {
  it('English toolbar, category suggestions, and empty-canvas hints contain no Chinese', () => {
    const html = render('en')
    expect(html).toContain('aria-label="Generate image"')
    expect(html).toContain('aria-label="Canvas shortcuts"')
    expect(html).toContain('value="Characters"')
    expect(html).not.toMatch(/[\u3400-\u9fff]/)
  })

  it('Chinese toolbar, category suggestions, and menu copy remain unchanged', () => {
    const html = render('zh-CN')
    expect(html).toContain('aria-label="生图"')
    expect(html).toContain('aria-label="画布快捷键"')
    expect(html).toContain('value="人物"')
    expect(html).toContain('整理全部产物；保留内容、连线和已有框大小，可一次撤销。')
  })
})


it('The English organization preview preserves original titles of reused frames', () => {
  const frame: NodeView = { nodeId: 'frame', kind: 'frame', x: 0, y: 0, w: 400, h: 400, z: 0, layoutRevision: 0, slots: [], frame: { title: '未分类', color: 'gray' } }
  const html = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en', setLocale() {}, children: createElement(OrganizationPreview, {
      nodes: [frame], ops: [], groups: [{ frameId: 'frame', category: 'Uncategorized', nodeIds: [], x: 0, y: 0, w: 400, h: 400 }],
    }),
  }))
  expect(html).toContain('>未分类</text>')
  expect(html).toContain('Uncategorized 0 nodes')
})


it.each(['image', 'video', 'script'] as const)('keeps hidden attached media in the selected %s node snapshot', kind => {
  const media = (nodeId: string, kind: 'image' | 'video'): NodeView => ({
    nodeId, kind, purpose: 'working', x: 0, y: 0, w: 100, h: 100, z: 0, layoutRevision: 0,
    slots: [{ slotId: nodeId, slotKey: 'main', revision: 1, contentType: kind, content: { type: 'asset', assetVersionId: nodeId, mime: `${kind}/test` } }],
  })
  const target: NodeView = { ...media('target', 'image'), kind, purpose: 'artifact', slots: [], inputs: ['image', 'video'] }
  const allNodes = [media('image', 'image'), media('video', 'video'), target]
  const state = {
    nodeViews: new Map(allNodes.map(node => [node.nodeId, node])), nodes: [target], allNodes,
    selectedId: 'target', titleNumbers: new Map(), frameRunning: new Map(),
  } as unknown as Parameters<typeof selectCanvasNode>[0]
  const snapshot = selectCanvasNode(state, undefined, 'target')!
  expect(snapshot.nodes).toEqual([target])
  expect(numberedReferences(target.inputs!, snapshot.allNodes).map(reference => [reference.node?.kind, reference.number])).toEqual([
    ['image', 1], ['video', 1],
  ])
  const unselected = selectCanvasNode({ ...state, selectedId: null }, undefined, 'target')!
  if (kind !== 'script') expect(unselected.allNodes).toEqual([])
})
