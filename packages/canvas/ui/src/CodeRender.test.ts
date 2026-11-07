import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { CodeRender } from './CodeRender'
import type { CanvasActions } from './CanvasView'

it('Code rendering is explicit; initially show the conservative unrendered hint and never execute code on the page', () => {
  let submitted = false
  const html = renderToStaticMarkup(createElement(CodeRender, {
    nodeId: 'code', revision: 2, edited: false, commit: async () => true,
    actions: { onRenderCode: async () => { submitted = true; return { jobId: 'job', revision: 2 } } } as unknown as CanvasActions,
  }))
  expect(submitted).toBe(false)
  expect(html).toContain('html')
  expect(html).toContain('代码已修改，未渲染')
  expect(html).toContain('>渲染</button>')
})

it('The browser saves successfully rendered revisions, avoids false hints after refresh, and still marks new edits as unrendered', () => {
  vi.stubGlobal('localStorage', { getItem: () => '2' })
  try {
    const render = (revision: number, edited = false) => renderToStaticMarkup(createElement(CodeRender, {
      nodeId: 'code', revision, edited, commit: async () => true, actions: {} as CanvasActions,
    }))
    expect(render(2)).not.toContain('代码已修改，未渲染')
    expect(render(3)).toContain('代码已修改，未渲染')
    expect(render(2, true)).toContain('代码已修改，未渲染')
  } finally { vi.unstubAllGlobals() }
})
