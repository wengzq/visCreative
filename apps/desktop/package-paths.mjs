import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const outputDir = resolve(process.env.VIS_DESKTOP_OUTPUT_DIR || resolve(root, 'artifacts/desktop'))
export const stageDir = resolve(outputDir, 'stage')
export const distDir = resolve(outputDir, 'dist')

// Set before loading the downloaders; both accept absolute cache locations.
process.env.electron_config_cache = resolve(process.env.electron_config_cache || resolve(outputDir, 'cache/electron'))
process.env.ELECTRON_BUILDER_CACHE = resolve(process.env.ELECTRON_BUILDER_CACHE || resolve(outputDir, 'cache/electron-builder'))
