import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { HUMAN_BODY, type BodyDescriptor } from '@vis/scene-core'
import { LocaleProvider } from '@vis/ui-kit'
import { PoseInspector } from './PoseInspector'
import { createSceneViewportController } from './viewport-state'

it('shows descriptor joints and presets for a non-human body and hides mirror without pairs', () => {
  const body: BodyDescriptor = {
    id: 'test-coil', heightM: 1, poses: [{ id: 'curled', joints: { coil: [0, 0, 0, 1] } }],
    joints: [{ id: 'coil', parent: null, offset: [0, 0, 0], parts: [], limits: { min: [-0.4, -0.2, -0.1], max: [0.4, 0.2, 0.1] } }],
  }
  const controller = createSceneViewportController()
  controller.select('creature')
  controller.selectJoint('coil')
  const html = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale: vi.fn(), children: createElement(PoseInspector, {
    body, pose: {}, controller, disabled: false, change: vi.fn(),
  }) }))
  expect(html).toContain('aria-label="Select joint: coil"')
  expect(html).toContain('aria-label="coil rotation (degrees) X"')
  expect(html).toContain('value="curled"')
  expect(html).not.toContain('Mirror pose')
  expect(html).not.toContain('shoulder')
})

it('offers every descriptor preset and both copy directions for a paired body', () => {
  const controller = createSceneViewportController()
  const html = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale: vi.fn(), children: createElement(PoseInspector, {
    body: HUMAN_BODY, pose: {}, controller, disabled: false, change: vi.fn(),
  }) }))
  for (const pose of HUMAN_BODY.poses) expect(html).toContain(`value="${pose.id}"`)
  expect(html).toContain('aria-label="Copy left to right"')
  expect(html).toContain('aria-label="Copy right to left"')
  expect(html).toContain('aria-label="Swap sides"')
})
