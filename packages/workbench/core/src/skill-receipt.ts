import { SkillDraftReceipt } from '@vis/protocol'

/** Keep the card identity independently of tool-log truncation, without retaining the draft body twice. */
export function skillReceipt(text: string) {
  try {
    const result = JSON.parse(text)
    if (result.location !== 'Settings > My skills') return {}
    const parsed = SkillDraftReceipt.safeParse(result.draft)
    if (parsed.success) return { skillDraft: parsed.data }
  } catch { /* Other tool output has no skill receipt. */ }
  return {}
}
