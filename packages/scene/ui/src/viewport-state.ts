import { useSyncExternalStore } from 'react'
import type { SceneView } from '@vis/protocol'
import type { SceneEditorHost, SceneViewportController, SceneViewportState } from './types'

export type SceneViewportBinding = {
  frameSelection(): void
  readCamera(): SceneView['camera']
  captureView(viewId: string): Promise<Blob>
}

export function createSceneViewportController(initial: Pick<SceneEditorHost, 'initialViewId' | 'initialTarget'> & Partial<Pick<SceneEditorHost, 'node'>> = {}): SceneViewportController {
  const content = initial.node?.slots.find(slot => slot.slotKey === 'main')?.content
  const views = content?.type === 'scene' ? content.doc.views : null
  const viewId = views ? views.find(view => view.id === initial.initialViewId)?.id ?? views[0]?.id ?? null : initial.initialViewId ?? null
  let state: SceneViewportState = {
    selectedId: null, selectedJointId: null, viewId, tool: 'translate', mode: initial.initialViewId && viewId ? 'camera' : 'orbit',
    dragging: false, status: 'loading', failedModels: 0, softwareRenderer: false, error: null, initialTarget: initial.initialTarget ?? null,
  }
  let binding: SceneViewportBinding | null = null
  const listeners = new Set<() => void>()
  const update = (fields: Partial<SceneViewportState>) => {
    if (Object.entries(fields).every(([key, value]) => Object.is(state[key as keyof SceneViewportState], value))) return
    state = { ...state, ...fields }
    listeners.forEach(listener => listener())
  }
  const controller: SceneViewportController = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    select: selectedId => update({ selectedId, selectedJointId: null }),
    selectJoint: id => update({ selectedJointId: state.selectedId ? id : null, ...(id && state.selectedId ? { tool: 'rotate' as const } : {}) }),
    setView: viewId => update({ viewId }),
    setTool: tool => update({ tool }),
    setMode: mode => update({ mode }),
    frameSelection: () => binding?.frameSelection(),
    readCamera: () => binding?.readCamera() ?? null,
    captureView: viewId => binding?.captureView(viewId) ?? Promise.reject(new Error('The scene viewport is not ready')),
  }
  bindings.set(controller, { update, connect(next) { binding = next } })
  return controller
}

const bindings = new WeakMap<SceneViewportController, { update(fields: Partial<SceneViewportState>): void; connect(binding: SceneViewportBinding | null): void }>()
export function viewportBinding(controller: SceneViewportController) {
  const result = bindings.get(controller)
  if (!result) throw new Error('Use createSceneViewportController to create the viewport controller')
  return result
}
export const useSceneViewportState = (controller: SceneViewportController): SceneViewportState => useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
