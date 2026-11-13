import { SkillDraftReceipt } from '@vis/protocol'

/** Keep the card identity independently of tool-log truncation, without retaining the draft body twice. */
export function skillReceiptValue(result: unknown) {
  if (!result || typeof result !== 'object' || !('location' in result) || result.location !== 'Settings > My skills' || !('draft' in result)) return {}
  const parsed = SkillDraftReceipt.safeParse(result.draft)
  return parsed.success ? { skillDraft: parsed.data } : {}
}

export function skillReceipt(text: string) {
  try { return skillReceiptValue(JSON.parse(text)) } catch { /* Other tool output has no skill receipt. */ }
  return {}
}
