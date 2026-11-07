import { CanvasOp } from '@vis/protocol'

// Structural subset of zod issues, so the CLI does not depend on zod directly
type Issue = { code: string; path: PropertyKey[]; message: string; errors?: Issue[][]; discriminator?: string }

export const NODE_CREATE_EXAMPLE = '{"op":"node.create","tempId":"n1","kind":"text","format":"code","title":"Intro","content":{"text":"<!doctype html>..."}}'
const CANVAS_OPS = CanvasOp.options.map(option => option.shape.op.value)

function pathOf(path: PropertyKey[]): string {
  return path.reduce<string>((out, key) => typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key), '')
}

function describe(issue: Issue, prefix: PropertyKey[]): string {
  const path = pathOf([...prefix, ...issue.path])
  const at = (text: string) => path ? `${path}: ${text}` : text
  // zod reports an unknown discriminator as a union with no branches; name the field and the accepted values instead
  if (issue.code === 'invalid_union' && issue.discriminator) {
    const field = issue.path.at(-1) === issue.discriminator ? path : path ? `${path}.${issue.discriminator}` : issue.discriminator
    const accepted = issue.discriminator === 'op' && prefix.length === 0 && issue.path[0] === 'ops' ? `: must be one of ${CANVAS_OPS.join(', ')}` : ' has no accepted value'
    return `${field}${accepted}`
  }
  if (issue.code === 'invalid_union' && issue.errors?.length) {
    // zod's raw JSON nests every union branch; agents fix calls faster from one line listing the accepted shapes
    const branches = issue.errors.map(branch => branch.map(inner => describe(inner, [])).join('; ') || 'invalid')
    return at(`must match one of: ${branches.map(b => `(${b})`).join(' or ')}`)
  }
  return at(issue.message)
}

/** Agent-readable summary of a params validation failure: one line per issue, plus an example for node.create mistakes */
export function formatParamsError(method: string, error: { issues: readonly object[] }, params: Record<string, unknown>): string {
  // Read through a structural view; zod's own issue union is not assignable without importing zod
  const issues = error.issues as Issue[]
  const lines = issues.map(issue => describe(issue, []))
  const ops = Array.isArray(params.ops) ? params.ops : []
  // Only for mistakes the example answers: a missing tempId, a wrong content shape, or an unknown op
  const needsExample = method === 'canvas.apply' && issues.some(issue => {
    if (issue.path[0] !== 'ops' || typeof issue.path[1] !== 'number') return false
    if (issue.code === 'invalid_union' && issue.discriminator === 'op') return true
    return (ops[issue.path[1]] as { op?: unknown } | undefined)?.op === 'node.create' && (issue.path[2] === 'tempId' || issue.path[2] === 'content')
  })
  if (needsExample) lines.push(`node.create needs tempId (unique in the batch) and kind; content is {"text": ...} for text nodes or {"assetVersionId": ...} for media. Example: ${NODE_CREATE_EXAMPLE}`)
  if (method === 'canvas.apply') {
    const topics = new Set<string>()
    for (const issue of issues) {
      if (issue.path[0] !== 'ops' || typeof issue.path[1] !== 'number') continue
      const op = (ops[issue.path[1]] as { op?: unknown } | undefined)?.op
      if (op === 'script.replace' || op === 'script.patch') topics.add('script')
      if (op === 'timeline.set') topics.add('timeline')
    }
    for (const topic of topics) lines.push(`See guide "${topic}".`)
  }
  return lines.join('\n')
}
