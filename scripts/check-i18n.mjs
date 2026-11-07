#!/usr/bin/env node
// UI code must not hard-code Chinese copy (0018): checks strings, template strings, and JSX text, excluding comments.
// Put copy in each package messages.ts; literals that must remain (such as regexes detecting Chinese) need i18n-exempt and a reason on the same or preceding line.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const DIRS = process.argv.slice(2).length ? process.argv.slice(2) : ['packages/ui-kit/src', 'packages/canvas/ui/src', 'packages/timeline/ui/src', 'packages/previz/ui/src', 'packages/scene/ui/src', 'packages/writing/ui/src', 'packages/workbench/ui/src', 'apps/web/src/client']
const SKIP = /(\.test\.tsx?|messages\.ts|error-reasons\.ts)$/
const CJK = /[㐀-鿿＀-￯　-〿]/

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return files(path)
    return /\.tsx?$/.test(e.name) && !SKIP.test(e.name) ? [path] : []
  })
}

const errors = []
for (const dir of DIRS) for (const file of files(join(root, dir))) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = node => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    if (literal && CJK.test(node.text)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line
      if (!/i18n-exempt/.test(lines[line] ?? '') && !/i18n-exempt/.test(lines[line - 1] ?? '')) {
        errors.push(`${relative(root, file)}:${line + 1}  ${node.text.trim().slice(0, 40)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (errors.length) {
  console.error(`Found ${errors.length} hard-coded Chinese UI strings; move them to messages.ts:`)
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}
console.log('i18n check passed')
