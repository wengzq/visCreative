import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const studiod = join(root, 'services', 'studiod')
const generation = join(root, 'packages', 'generation')
const migrations = join(studiod, 'migrations')

rmSync(migrations, { recursive: true, force: true })
// Node 24 cpSync aborts the process on Windows paths with non-ASCII characters; the async cp does not
await cp(join(root, 'packages', 'storage', 'migrations'), migrations, { recursive: true })
mkdirSync(join(studiod, 'dist', 'fixtures'), { recursive: true })
copyFileSync(join(generation, 'src', 'providers', 'mock', 'fixtures', 'sample.mp4'), join(studiod, 'dist', 'fixtures', 'sample.mp4'))
// Rebuild the owned library directory so removed dependencies do not survive an incremental build.
rmSync(join(studiod, 'dist', 'lib'), { recursive: true, force: true })
mkdirSync(join(studiod, 'dist', 'lib'), { recursive: true })
copyFileSync(join(generation, 'node_modules', 'animejs', 'dist', 'bundles', 'anime.umd.min.js'), join(studiod, 'dist', 'lib', 'anime.js'))
copyFileSync(join(generation, 'node_modules', 'animejs', 'LICENSE.md'), join(studiod, 'dist', 'lib', 'anime.LICENSE.txt'))
copyFileSync(join(generation, 'node_modules', 'roughjs', 'bundled', 'rough.js'), join(studiod, 'dist', 'lib', 'rough.js'))
for (const name of ['three.module.js', 'three.core.js']) {
  copyFileSync(join(generation, 'node_modules', 'three', 'build', name), join(studiod, 'dist', 'lib', name))
}
