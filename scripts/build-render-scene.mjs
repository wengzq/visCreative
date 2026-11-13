import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// esbuild is already owned by the daemon build; do not add a runtime dependency.
const require = createRequire(join(root, 'services', 'studiod', 'package.json'))
const { build } = require('esbuild')

export async function buildRenderScene(outfile) {
  const entry = join(root, 'packages', 'scene', 'core', 'src', 'index.ts')
  await build({
    stdin: {
      contents: `export * from ${JSON.stringify(entry.replaceAll('\\', '/'))}\nexport { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'`,
      resolveDir: join(root, 'packages', 'generation'),
      sourcefile: 'vis-scene.ts',
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    // esbuild's external package names also exclude subpaths; the loader itself must be bundled.
    plugins: [{
      name: 'shared-three',
      setup(build) {
        build.onResolve({ filter: /^three$/ }, () => ({ path: 'three', external: true }))
      },
    }],
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('A scene bundle output path is required')
  await buildRenderScene(resolve(process.argv[2]))
}
