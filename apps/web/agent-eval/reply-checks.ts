import { ErrorCode, GuideTopic, METHODS, toolNameOf, type MethodName, type TranscriptItem } from '@vis/protocol'

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const methods = Object.keys(METHODS) as MethodName[]
const methodNames = [...new Set(methods.flatMap(method => [method, toolNameOf(method)]))]
const methodPattern = new RegExp(`(?<![\\w.])(?:mcp__vis__|vis\\.)?(?:${methodNames.map(escape).join('|')})(?![\\w.])`, 'g')
const errorPattern = new RegExp(`\\b(?:${ErrorCode.options.map(escape).join('|')})\\b|\\b[a-z]+(?:_[a-z]+)*\\.[a-z]+(?:_[a-z]+)+\\b`, 'g')
const guidePattern = new RegExp(`skills:\\/\\/[^\\s)\\]>]+|\\bSKILL\\.md\\b|\\b(?:${GuideTopic.options.map(escape).join('|')})[ -](?:guide|skill)\\b`, 'gi')
const pathPattern = /(?:file:\/\/)?\/(?:Users|home|tmp|private|var|opt|etc|Applications|Volumes)\/[^\s`"'<>，。；）)\]]+|~\/[^\s`"'<>，。；）)\]]+|[A-Z]:\\[^\s`"'<>，。；）)\]]+|\b(?:packages|apps|services|docs|skills)\/[\w./-]+/gi

export function scanFinalReplies(transcript: TranscriptItem[], prompts: string[]) {
  const matches: { turnId: string | null; seq: number; kind: string; text: string; reply: string }[] = []
  const turns = [...new Set(transcript.map(item => item.turnId))]
  for (const turnId of turns) {
    const items = transcript.filter(item => item.turnId === turnId)
    const lastToolSeq = Math.max(0, ...items.filter(item => item.kind === 'tool_call' || item.kind === 'tool_result').map(item => item.createdSeq))
    for (const item of items.filter(item => item.kind === 'assistant_text' && item.createdSeq > lastToolSeq)) {
      const reply = String((item.payload as any)?.text ?? '')
      for (const [kind, pattern] of [['method', methodPattern], ['error', errorPattern], ['guide', guidePattern], ['path', pathPattern]] as const) {
        for (const match of reply.matchAll(pattern)) {
          const text = kind === 'path' ? match[0].replace(/[.!:;]+$/, '') : match[0]
          // An explicitly requested path is legitimate delivery context, not a wording finding.
          if (kind === 'path' && prompts.some(prompt => prompt.includes(text))) continue
          matches.push({ turnId, seq: item.createdSeq, kind, text, reply })
        }
      }
    }
  }
  return matches
}
