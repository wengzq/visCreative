// CanvasService: nodes / slots, operation batches, revision checks, and generation delivery. See docs/rfc/0002 and 0003.
export { createCanvasService, type CanvasService } from './service'
export { applyOps, type Actor } from './apply'
export { readNodes } from './views'
export { defaultNodeSize, placeNewNode, type Rect, type Size } from './placement'
export { createFrameNode, frameMemberIds, frameIdAt } from './frames'
export { markScriptEntitiesChanged, migrateScriptEntities } from './script-entities'
export { validateScene } from './scene'
