#!/usr/bin/env node
// Code is written in English (AGENTS.md): comments, test names, log lines and error fallback messages.
// UI copy, Agent-facing text and user-content test data may stay Chinese; see EXEMPT_STRINGS and the
// `english-exempt` marker (same line or the line above, with a reason) for anything else that must stay.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const DIRS = process.argv.slice(2).length ? process.argv.slice(2) : ['apps', 'services', 'packages', 'scripts', 'runtime']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'migrations', 'artifacts', 'fixtures'])
const HAN = /[㐀-鿿＀-￯　-〿]/
// Files whose string literals are UI copy or Agent-facing text; their comments are still checked.
const EXEMPT_STRINGS = /(messages\.ts|error-messages\.ts|prompt\.ts|overlay\.ts|methods\.ts)$/
const TEST_FNS = new Set(['it', 'test', 'describe', 'bench'])
const ERROR_CLASSES = /^(Error|TypeError|RangeError|VisError|ProviderError|DispatchError|RpcRequestError|UsageError|[A-Z]\w*Error)$/
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug'])

function files(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries.flatMap(e => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : files(path)
    return /\.(tsx?|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path] : []
  })
}

function textOf(node) {
  if (!node) return ''
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(s => s.literal.text).join('')
  if (ts.isBinaryExpression(node)) return textOf(node.left) + textOf(node.right)
  return ''
}

/** it / it.each(...) / it.runIf(...) / describe.skip ... → the identifier at the root */
function calleeRoot(expr) {
  while (true) {
    if (ts.isIdentifier(expr)) return expr.text
    if (ts.isPropertyAccessExpression(expr)) expr = expr.expression
    else if (ts.isCallExpression(expr)) expr = expr.expression
    else return undefined
  }
}

const errors = []
for (const dir of DIRS) for (const file of files(join(root, dir))) {
  const rel = relative(root, file).split(sep).join('/')
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const exempt = line => /english-exempt/.test(lines[line] ?? '') || /english-exempt/.test(lines[line - 1] ?? '')
  const report = (pos, kind, sample) => {
    const line = source.getLineAndCharacterOfPosition(pos).line
    if (!exempt(line)) errors.push(`${rel}:${line + 1}  [${kind}] ${sample.trim().replace(/\s+/g, ' ').slice(0, 50)}`)
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

  // Comments: scan every token's leading and trailing comment ranges once.
  const seen = new Set()
  const scanComments = pos => {
    for (const range of [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])]) {
      if (seen.has(range.pos)) continue
      seen.add(range.pos)
      const comment = text.slice(range.pos, range.end)
      if (HAN.test(comment)) report(range.pos, 'comment', comment)
    }
  }

  // Walk every token, not just child nodes: a comment right before `}` (an empty catch, a JSX `{/* */}`) is trivia of that token
  const walkTokens = node => {
    scanComments(node.getFullStart())
    scanComments(node.getEnd())
    for (const child of node.getChildren(source)) walkTokens(child)
  }
  walkTokens(source)

  const stringsExempt = EXEMPT_STRINGS.test(rel)
  const visit = node => {
    scanComments(node.getFullStart())
    scanComments(node.getEnd())
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? []
      const root = calleeRoot(node.expression)
      if (ts.isCallExpression(node) && root && TEST_FNS.has(root) && HAN.test(textOf(args[0]))) {
        report(args[0].getStart(), 'test name', textOf(args[0]))
      }
      if (!stringsExempt) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
        const owner = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText(source) : ''
        let message
        if (ts.isNewExpression(node) && ERROR_CLASSES.test(name)) message = args.find(a => HAN.test(textOf(a)))
        else if (name === 'of' && owner === 'VisError') message = args[3]
        else if (owner === 'console' && LOG_METHODS.has(name)) message = args.find(a => HAN.test(textOf(a)))
        if (message && HAN.test(textOf(message))) report(message.getStart(), 'error/log message', textOf(message))
      }
    }
    // zod and similar option objects: { message: '...' }
    if (!stringsExempt && ts.isPropertyAssignment(node) && node.name.getText(source) === 'message' && HAN.test(textOf(node.initializer))) {
      report(node.initializer.getStart(), 'error/log message', textOf(node.initializer))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (errors.length) {
  console.error(`${errors.length} place(s) use Chinese where code must be English (see AGENTS.md):`)
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}
console.log('English check passed')
