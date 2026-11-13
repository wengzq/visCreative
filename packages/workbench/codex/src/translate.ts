import { toolReceipts, truncateReasoning } from '@vis/workbench-core'

export type TranslatedItem = {
  itemId: string
  revision: number
  kind: 'assistant_text' | 'tool_call' | 'tool_result' | 'reasoning'
  payload: unknown
}

/** Keep only a summary of tool results; full content is in the Codex thread log */
const MAX_RESULT_CHARS = 4000

/**
 * Convert app-server thread items to transcript entries, excluding streaming deltas; create an empty entry when thinking starts to preserve creation time, then update on completion;
 * entry IDs combine Codex turn and item IDs, making one delivery each at start and completion idempotent.
 */
export function translate(phase: 'started' | 'completed', codexTurnId: string, item: any): TranslatedItem[] {
  if (!item || typeof item.id !== 'string') return []
  const base = `cx:${codexTurnId}:${item.id}`
  const call = (name: string, input: unknown): TranslatedItem => ({ itemId: `${base}:call`, revision: 1, kind: 'tool_call', payload: { toolUseId: item.id, name, input } })
  const result = (isError: boolean, text: string): TranslatedItem => ({ itemId: `${base}:result`, revision: 1, kind: 'tool_result', payload: { toolUseId: item.id, isError, text: truncate(text), ...(!isError ? toolReceipts(text) : {}) } })

  switch (item.type) {
    case 'reasoning': {
      if (phase === 'started') return [{ itemId: base, revision: 1, kind: 'reasoning', payload: { text: '' } }]
      const summary = Array.isArray(item.summary) ? item.summary.join('\n\n') : ''
      const text = summary.trim() ? summary : Array.isArray(item.content) ? item.content.join('\n\n') : ''
      return [{ itemId: base, revision: 2, kind: 'reasoning', payload: { text: truncateReasoning(text) } }]
    }
    case 'agentMessage':
      return phase === 'completed' && typeof item.text === 'string' && item.text.trim()
        ? [{ itemId: base, revision: 1, kind: 'assistant_text', payload: { text: item.text } }]
        : []
    case 'mcpToolCall': {
      const items = [call(`${item.server}.${item.tool}`, item.arguments ?? {})]
      if (phase === 'completed') {
        items.push(item.error
          ? result(true, String(item.error.message ?? '工具调用失败'))
          : result(item.status === 'failed', contentText(item.result?.content)))
      }
      return items
    }
    case 'commandExecution': {
      const items = [call('shell', { command: item.command })]
      if (phase === 'completed') {
        const declined = item.status === 'declined'
        items.push(result(declined || item.status === 'failed' || (item.exitCode ?? 0) !== 0, declined ? '已拒绝：本空间不允许运行命令' : String(item.aggregatedOutput ?? '')))
      }
      return items
    }
    case 'webSearch': {
      // Without these entries a claim that a page was unavailable cannot be checked (RFC 0048).
      const action = item.action && typeof item.action === 'object' ? item.action : undefined
      const items = [call('web_search', { query: item.query ?? '', ...(action ? { action } : {}) })]
      if (phase === 'completed') items.push(result(false, webSearchText(item.query, action)))
      return items
    }
    default:
      return []
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(c => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : c?.type === 'image' ? '[图片]' : '')).join('\n')
}

function webSearchText(query: unknown, action: any): string {
  if (action?.type === 'openPage' && typeof action.url === 'string') return `openPage ${action.url}`
  if (action?.type === 'findInPage') return `findInPage ${[action.url, action.pattern].filter(value => typeof value === 'string').join(' ')}`
  const queries = Array.isArray(action?.queries) ? action.queries.filter((value: unknown) => typeof value === 'string') : []
  return `search ${queries.length ? queries.join(' | ') : typeof action?.query === 'string' ? action.query : String(query ?? '')}`
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…（已截断）` : text
}
