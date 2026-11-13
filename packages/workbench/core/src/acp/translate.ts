import { toolReceipts } from '../tool-receipts'
import { truncateReasoning } from '../reasoning'

export type TranslatedItem = {
  itemId: string
  revision: number
  kind: 'assistant_text' | 'tool_call' | 'tool_result' | 'reasoning' | 'plan'
  payload: unknown
}

/** Keep only a summary of tool results; full content is in the Agent transcript */
const MAX_RESULT_CHARS = 4000

/**
 * Convert ACP session/update to transcript entries. Content blocks of one message can arrive separately: accumulate by messageId and increment revisions.
 * Entry IDs combine the ACP session and message or tool-call ID, making repeated delivery idempotent.
 */
export function createTranslator(acpSessionId: string, turnId: string, itemPrefix: string) {
  let planRevision = 0
  const messages = new Map<string, { text: string; revision: number }>()
  const base = (id: string) => `${itemPrefix}:${acpSessionId}:${id}`

  return (update: any): TranslatedItem[] => {
    switch (update?.sessionUpdate) {
      case 'agent_thought_chunk':
      case 'agent_message_chunk': {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') return []
        const thought = update.sessionUpdate === 'agent_thought_chunk'
        const id = `${String(update.messageId ?? 'message')}${thought ? ':thought' : ''}`
        const prev = messages.get(id)
        const next = { text: prev ? `${prev.text}${update.content.text}` : update.content.text, revision: (prev?.revision ?? 0) + 1 }
        messages.set(id, next)
        if (!next.text.trim()) return []
        return [{ itemId: base(id), revision: next.revision, kind: thought ? 'reasoning' : 'assistant_text', payload: { text: thought ? truncateReasoning(next.text) : next.text } }]
      }
      case 'plan':
        if (!Array.isArray(update.entries)) return []
        return [{ itemId: `${base(turnId)}:plan`, revision: ++planRevision, kind: 'plan', payload: { entries: update.entries.map((entry: any) => ({ text: entry.content, status: entry.status })) } }]
      case 'tool_call':
        return [{
          itemId: `${base(update.toolCallId)}:call`,
          revision: 1,
          kind: 'tool_call',
          payload: { toolUseId: update.toolCallId, name: String(update.title ?? 'tool'), input: update.rawInput ?? {} },
        }]
      case 'tool_call_update': {
        if (update.status !== 'completed' && update.status !== 'failed') return []
        const text = contentText(update.content)
        return [{
          itemId: `${base(update.toolCallId)}:result`,
          revision: 1,
          kind: 'tool_result',
          payload: { toolUseId: update.toolCallId, isError: update.status === 'failed', text: truncate(text), ...(update.status === 'completed' ? toolReceipts(text) : {}) },
        }]
      }
      default:
        return []
    }
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(c => {
    const inner = c?.type === 'content' ? c.content : c
    return inner?.type === 'text' && typeof inner.text === 'string' ? inner.text : inner?.type === 'image' ? '[图片]' : ''
  }).join('\n')
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…（已截断）` : text
}
