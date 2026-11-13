import type { SceneAspectRatio } from '@vis/protocol'
import { sceneAspect } from '@vis/scene-core'

export function captureDimensions(ratio: SceneAspectRatio, longEdge = 1920, pixelStep = 1) {
  const aspect = sceneAspect(ratio)
  const round = (value: number) => Math.round(value / pixelStep) * pixelStep
  return aspect >= 1 ? { width: longEdge, height: round(longEdge / aspect) } : { width: round(longEdge * aspect), height: longEdge }
}

export function cameraViewport(width: number, height: number, aspect: number) {
  const frameWidth = Math.min(width, height * aspect)
  const frameHeight = frameWidth / aspect
  return { x: (width - frameWidth) / 2, y: (height - frameHeight) / 2, width: frameWidth, height: frameHeight }
}

export const isSoftwareRenderer = (name: string) => /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe|\bwarp\b/i.test(name)
