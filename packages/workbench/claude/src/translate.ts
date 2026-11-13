import { toolReceipts } from '@vis/workbench-core'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export type TranslatedItem = {
  itemId: string
  revision: number
  kind: 'assistant_text' | 'tool_call' | 'tool_result'
  payload: unknown
}

/** Keep only a summary of tool results; full content is in the Claude transcript */
const MAX_RESULT_CHARS = 4000

/**
 * Convert SDK messages to transcript entries, using only complete main-Agent messages (excluding streaming fragments and subagents).
 * Entry IDs combine the message uuid and block index, making repeated delivery idempotent.
 */
export function translate(msg: SDKMessage): TranslatedItem[] {
  if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
    const items: TranslatedItem[] = []
    msg.message.content.forEach((block, i) => {
      const itemId = `${msg.uuid}:${i}`
      if (block.type === 'text' && block.text.trim()) items.push({ itemId, revision: 1, kind: 'assistant_text', payload: { text: block.text } })
      if (block.type === 'tool_use') items.push({ itemId, revision: 1, kind: 'tool_call', payload: { toolUseId: block.id, name: block.name, input: block.input } })
    })
    return items
  }
  if (msg.type === 'user' && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
    const items: TranslatedItem[] = []
    msg.message.content.forEach((block, i) => {
      if (block.type !== 'tool_result') return
      const text = resultText(block.content)
      items.push({
        itemId: `${msg.uuid}:${i}`,
        revision: 1,
        kind: 'tool_result',
        payload: { toolUseId: block.tool_use_id, isError: block.is_error ?? false, text: truncate(text), ...(!block.is_error ? toolReceipts(text) : {}) },
      })
    })
    return items
  }
  return []
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(c => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : c?.type === 'image' ? '[图片]' : '')).join('\n')
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…（已截断）` : text
}
