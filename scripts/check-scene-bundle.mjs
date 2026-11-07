import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const web = resolve(root, 'apps/web')
const require = createRequire(resolve(web, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)

await build({
  configFile: resolve(web, 'vite.config.ts'),
  root: resolve(web, 'src/client'),
  plugins: [{
    name: 'vis-scene-bundle-check',
    generateBundle(_options, bundle) {
      const initial = Object.values(bundle).filter(chunk => chunk.type === 'chunk' && chunk.isEntry)
      if (!initial.length) this.error('The web build has no entry chunks')
      const modules = new Set()
      const chunks = new Set()
      const failures = new Set()
      const isThree = id => id === 'three' || id.startsWith('three/') || /(?:^|\/)node_modules\/three\//.test(id.replaceAll('\\', '/'))
      const inspectModule = id => {
        if (modules.has(id)) return
        modules.add(id)
        if (isThree(id)) failures.add(id)
        // Checking the resolved graph also catches imports folded into constants by the optimizer.
        for (const dependency of this.getModuleInfo(id)?.importedIds ?? []) inspectModule(dependency)
      }
      const inspectChunk = chunk => {
        if (chunks.has(chunk.fileName)) return
        chunks.add(chunk.fileName)
        for (const id of Object.keys(chunk.modules)) if (isThree(id)) failures.add(id)
        // Dynamic chunks belong to the editor and must stay outside the initial load.
        for (const dependency of chunk.imports) {
          if (isThree(dependency)) failures.add(dependency)
          const imported = bundle[dependency]
          if (imported?.type === 'chunk') inspectChunk(imported)
        }
      }
      for (const chunk of initial) {
        if (chunk.facadeModuleId) inspectModule(chunk.facadeModuleId)
        inspectChunk(chunk)
      }
      if (failures.size) this.error(`three.js entered the main web bundle:\n${[...failures].join('\n')}`)
      console.log(`Scene bundle check passed: three.js is absent from ${chunks.size} initial chunks`)
    },
  }],
})
