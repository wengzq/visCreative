// Bundles the Electron main process and the sandboxed preload script. `electron` stays external: the runtime provides it.
import { build } from 'esbuild'

const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], logLevel: 'info' }
await build({
  ...common,
  entryPoints: ['src/main.ts'],
  format: 'esm',
  outfile: 'dist/main.mjs',
  // Bundled CommonJS dependencies (ws) call require.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
// A sandboxed preload must be CommonJS.
await build({ ...common, entryPoints: ['src/preload.ts'], format: 'cjs', outfile: 'dist/preload.cjs' })
