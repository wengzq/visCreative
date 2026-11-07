import { expect, it, vi } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { cameraViewport, captureDimensions, isSoftwareRenderer } from './viewport-math'
import { createSceneViewportController, viewportBinding } from './viewport-state'

it('keeps selection, tool and view state local and exposes the initial panel target without sending', () => {
  const target = { nodeId: 'previz', panelId: 'panel' }
  const controller = createSceneViewportController({ initialViewId: 'wide', initialTarget: target })
  const listener = vi.fn()
  const unsubscribe = controller.subscribe(listener)
  const initial = controller.getSnapshot()
  expect(controller.getSnapshot()).toBe(initial)
  expect(initial).toMatchObject({ mode: 'camera', viewId: 'wide', initialTarget: target })
  controller.select('figure')
  controller.setTool('rotate')
  controller.setView('close')
  controller.setMode('orbit')
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'figure', tool: 'rotate', viewId: 'close', mode: 'orbit', initialTarget: target })
  expect(listener).toHaveBeenCalledTimes(4)
  controller.setTool('rotate')
  expect(listener).toHaveBeenCalledTimes(4)
  unsubscribe()
  controller.select(null)
  expect(listener).toHaveBeenCalledTimes(4)
})

it('falls back to the first view when the initial view was deleted, including without WebGL', () => {
  const node: NodeView = {
    nodeId: 'scene', kind: 'scene', x: 0, y: 0, w: 300, h: 200, z: 1, layoutRevision: 1,
    slots: [{ slotId: 'main', slotKey: 'main', revision: 1, contentType: 'scene', content: { type: 'scene', doc: {
      version: 1, rev: 0, objects: [], views: [{ id: 'first', name: 'First', aspectRatio: '16:9', still: null, camera: { position: [3, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 } }],
    } } }],
  }
  const controller = createSceneViewportController({ initialViewId: 'deleted', node })
  expect(controller.getSnapshot()).toMatchObject({ viewId: 'first', mode: 'camera' })
})

it('selects joints locally, switches to rotation and clears the joint when selecting an object', () => {
  const controller = createSceneViewportController()
  controller.selectJoint('tip')
  expect(controller.getSnapshot().selectedJointId).toBeNull()
  controller.select('figure')
  controller.selectJoint('tip')
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'figure', selectedJointId: 'tip', tool: 'rotate' })
  controller.setTool('translate')
  expect(controller.getSnapshot().selectedJointId).toBe('tip')
  controller.select('figure')
  expect(controller.getSnapshot()).toMatchObject({ selectedId: 'figure', selectedJointId: null })
})

it('connects capture and camera commands only while a viewport owns the binding', async () => {
  const controller = createSceneViewportController()
  await expect(controller.captureView('wide')).rejects.toThrow('not ready')
  const capture = vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
  const frame = vi.fn()
  const camera = { position: [1, 2, 3] as [number, number, number], target: [0, 1, 0] as [number, number, number], roll: 0, focalLengthMm: 50 }
  viewportBinding(controller).connect({ captureView: capture, frameSelection: frame, readCamera: () => camera })
  expect((await controller.captureView('wide')).type).toBe('image/png')
  expect(capture).toHaveBeenCalledExactlyOnceWith('wide')
  controller.frameSelection()
  expect(frame).toHaveBeenCalledOnce()
  expect(controller.readCamera()).toEqual(camera)
  viewportBinding(controller).connect(null)
  expect(controller.readCamera()).toBeNull()
})

it.each([
  ['16:9', 1920, 1080], ['9:16', 1080, 1920], ['1:1', 1920, 1920],
  ['4:3', 1920, 1440], ['3:4', 1440, 1920], ['21:9', 1920, 823],
] as const)('captures %s with a 1920-pixel long edge', (ratio, width, height) => {
  expect(captureDimensions(ratio)).toEqual({ width, height })
})

it('fits an exact camera viewport into a larger stage without stretching', () => {
  expect(cameraViewport(1000, 1000, 16 / 9)).toEqual({ x: 0, y: 218.75, width: 1000, height: 562.5 })
  expect(cameraViewport(1600, 900, 1)).toEqual({ x: 350, y: 0, width: 900, height: 900 })
})

it('recognizes software renderer strings while allowing real GPU backends', () => {
  for (const value of ['ANGLE (Google, Vulkan SwiftShader Device)', 'llvmpipe (LLVM 15)', 'Microsoft Basic Render Driver', 'Software Rasterizer', 'Mesa lavapipe']) expect(isSoftwareRenderer(value)).toBe(true)
  for (const value of ['ANGLE (NVIDIA GeForce, D3D11)', 'Apple M3 Metal', 'Mesa Intel UHD Graphics']) expect(isSoftwareRenderer(value)).toBe(false)
})
