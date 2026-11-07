import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const kinds = new Set(['codex', 'deepseek', 'claude'])
const allowlist = new Map([
  ['services/studiod/src/main.ts', 'Production composition root registers the bundled adapters.'],
  ['services/studiod/src/codex.ts', 'Codex runtime factory binds adapter-specific launch options.'],
  ['services/studiod/src/deepseek.ts', 'DeepSeek runtime factory binds adapter-specific launch options.'],
  ['services/studiod/src/claude.ts', 'Claude runtime factory binds adapter-specific launch options.'],
  ['apps/web/agent-eval/runner.ts', 'Opt-in evaluation launches only the explicitly approved adapters.'],
  ['apps/web/agent-eval/safety.ts', 'Evaluation safety restricts paid real-Agent runs to the approved subset.'],
])
const skipped = new Set(['node_modules', 'dist', 'artifacts', 'migrations'])
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? skipped.has(entry.name) ? [] : files(path) : /\.(?:tsx?|mjs)$/.test(entry.name) ? [path] : []
  })
}
const errors = []
for (const file of ['packages', 'services', 'apps'].flatMap(directory => files(join(root, directory)))) {
  const path = relative(root, file).split(sep).join('/')
  if (/\.(?:test|e2e|eval-test)\./.test(path) || path.startsWith('apps/web/e2e/') || path.includes('/fixtures/')) continue
  if (/^packages\/workbench\/(?:codex|deepseek|claude)\//.test(path) || allowlist.has(path)) continue
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = node => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && kinds.has(node.text)) {
      const declaration = node.parent
      if (path === 'packages/protocol/src/session.ts' && ts.isVariableDeclaration(declaration) && declaration.name.getText(source) === 'DEFAULT_AGENT_KIND') return
      errors.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: read Agent metadata from the registry`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('Agent literal boundary check passed')
