import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', 'dist', 'artifacts'].includes(entry.name)) return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

const manifests = files(root).filter(path => path.endsWith('package.json'))
for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.notEqual(manifest.name, 'gsap', path)
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert(!Object.hasOwn(manifest[group] ?? {}, 'gsap'), `${path}: ${group}`)
  }
}
assert(!/\bgsap(?:@|:)/i.test(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')), 'The lockfile must not depend on GSAP')

const output = join(root, 'services', 'studiod', 'dist', 'lib')
for (const directory of ['apps/cli/dist', 'apps/devcli/dist', 'apps/web/dist', 'services/studiod/dist']) {
  assert(!files(join(root, directory)).some(path => /gsap/i.test(basename(path))), `${directory} must not ship a GSAP file`)
}
const names = readdirSync(output)
assert(!names.some(name => /gsap/i.test(name)), 'The build must not ship a GSAP file')
assert(names.includes('anime.js'), 'The build must ship anime.js')
assert(names.includes('vis-scene.js'), 'The build must ship vis-scene.js')
const scene = readFileSync(join(output, 'vis-scene.js'), 'utf8')
assert(scene.includes('from "three"'), 'The scene bundle must share the browser three.js module')
assert(!/from ["']three\//.test(scene), 'The scene bundle must include its model loader and addon helpers')
assert(scene.includes('sampleScene') && scene.includes('buildScene') && scene.includes('applySceneFrame'), 'The scene bundle must ship the shared scene implementation')
const script = readFileSync(join(output, 'anime.js'), 'utf8')
assert(script.includes('@copyright 2026 - Julian Garnier'), 'Preserve the browser bundle copyright')
assert(script.includes('@license MIT'), 'Preserve the browser bundle license header')
const license = readFileSync(join(output, 'anime.LICENSE.txt'), 'utf8')
assert(license.includes('Copyright (c) 2025 Julian Garnier'), 'Ship the upstream copyright notice')
assert(license.includes('Permission is hereby granted, free of charge'), 'Ship the full MIT permission notice')
assert(license.includes('THE SOFTWARE IS PROVIDED "AS IS"'), 'Ship the MIT warranty disclaimer')
console.log(`Render asset check passed (${manifests.length} manifests, ${names.length} bundled files)`)
