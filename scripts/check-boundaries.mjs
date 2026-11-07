// Check declared @vis/* package dependencies against layering rules. Strict pnpm node_modules
// prevents importing undeclared packages, so guarding package.json guards dependency direction.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE = ['protocol', 'domain', 'storage']

// Package name (without @vis/) -> allowed @vis/* dependencies
const ALLOWED = {
  'protocol': [],
  'domain': ['protocol'],
  'storage': ['protocol', 'domain'],
  'assets': CORE,
  // 0027: asset library and settings; it reaches the canvas only through ports injected by studiod
  'library-core': [...CORE, 'assets'],
  // generation delivers to the canvas through domain ports without directly depending on canvas-core
  'generation': [...CORE, 'assets'],
  // The two systems do not depend on each other; they collaborate through domain ports injected by studiod
  // 0027: scripts cast project settings from library-core
  'canvas-core': [...CORE, 'assets', 'library-core'],
  'workbench-core': CORE,
  'ui-kit': [],
  // UI interacts with the backend only through protocol and must not import any core package
  'canvas-ui': ['protocol', 'ui-kit'],
  'workbench-ui': ['protocol', 'ui-kit'],
  // 0024b: the timeline editor; canvas-ui does not depend on it, the host mounts it and injects 'open timeline'
  'timeline-ui': ['protocol', 'ui-kit'],
  'previz-ui': ['protocol', 'ui-kit'],
  'scene-core': ['protocol'],
  'scene-ui': ['protocol', 'ui-kit', 'scene-core'],
  'writing-ui': ['protocol', 'ui-kit'],
  // 0027: the library panel; like timeline-ui, mounted by the host and never imported by canvas-ui
  'library-ui': ['protocol', 'ui-kit'],
  'studiod': [...CORE, 'assets', 'generation', 'canvas-core', 'library-core', 'workbench-core'],
  'cli': ['protocol'],
  // Like desktop, the development client interacts with the backend only through protocol
  'devcli': ['protocol'],
  // Local web UI: the host connects to studiod only through protocol; the browser mounts UI packages (0006)
  'web': ['protocol', 'ui-kit', 'canvas-ui', 'workbench-ui', 'timeline-ui', 'previz-ui', 'scene-ui', 'writing-ui', 'library-ui'],
  'desktop': ['protocol', 'ui-kit', 'canvas-ui', 'workbench-ui', 'timeline-ui', 'previz-ui', 'scene-ui', 'writing-ui', 'library-ui'],
}

const root = fileURLToPath(new URL('..', import.meta.url))
const dirs = ['apps', 'services', 'packages', 'packages/canvas', 'packages/timeline', 'packages/previz', 'packages/scene', 'packages/writing', 'packages/library', 'packages/workbench']
  .flatMap(d => readdirSync(join(root, d), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => join(root, d, e.name)))
  .filter(d => existsSync(join(d, 'package.json')))

const errors = []
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const name = pkg.name.replace(/^@vis\//, '')
  // Adapter packages implement the same port; adding one must not require another registry here.
  const allowed = name.startsWith('agent-') ? [...CORE, 'workbench-core'] : ALLOWED[name]
  if (!allowed) {
    errors.push(`${pkg.name}: No layering rule registered; add one in scripts/check-boundaries.mjs`)
    continue
  }
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })
    .filter(d => d.startsWith('@vis/'))
    .map(d => d.replace(/^@vis\//, ''))
  for (const dep of deps) {
    if (!allowed.includes(dep) && !(name === 'studiod' && dep.startsWith('agent-'))) errors.push(`${pkg.name} must not depend on @vis/${dep}`)
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`Dependency boundary check passed (${dirs.length} packages)`)
