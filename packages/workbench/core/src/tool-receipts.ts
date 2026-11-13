import { SceneProposal } from '@vis/protocol'
import { skillReceiptValue } from './skill-receipt'

/** Preserve reviewable proposals before the adapter truncates its human-readable tool log. */
export function toolReceipts(text: string) {
  try {
    const result: unknown = JSON.parse(text)
    if (result && typeof result === 'object') {
      const { requestId: _requestId, ...proposal } = result as Record<string, unknown>
      const parsed = SceneProposal.safeParse(proposal)
      if (parsed.success) return { sceneProposal: parsed.data }
    }
    return skillReceiptValue(result)
  } catch { /* Other tool output has no review receipt. */ }
  return {}
}
