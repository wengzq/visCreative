import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider } from '@vis/ui-kit'
import type { NodeView } from '@vis/protocol'
import { expect, it, vi } from 'vitest'
import { OperationPromptPanel } from './OperationPromptPanel'
import type { CanvasActions } from './CanvasView'

vi.mock('./use-video-references', () => ({ useVideoReferences: () => { throw new Error('Operation subjects must not resolve reference metadata') } }))

it('renders a video operation subject without requesting reference duration metadata', () => {
  const view = { nodeId: 'subject', kind: 'video', w: 320, slots: [{ slotKey: 'main', content: { type: 'asset', assetVersionId: 'video' } }] } as NodeView
  const render = () => renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale() {}, children: createElement(OperationPromptPanel, {
    view, operation: 'video.reshoot', actions: {} as CanvasActions, assetUrl: id => id, posterUrl: id => id, onClose() {},
  }) }))
  expect(render).not.toThrow()
  expect(render()).toContain('Operation subject')
})
