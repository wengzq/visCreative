import { agentInstructions as sharedInstructions, turnPrompt, type DispatchInput } from '@vis/workbench-core'

/** Shared creative-space instructions, appended through the dsh persona suffix. */
export function agentInstructions(expanded: boolean, work?: DispatchInput['workContext'], isolation: 'sandbox' | 'none' = 'sandbox'): string {
  const shared = sharedInstructions({ environment: { access: expanded ? 'expanded' : 'readOnly', isolation }, work })
  // dsh-specific: jobs live in the per-turn dsh process, which exits when the turn ends.
  return expanded ? `${shared}\n\nBackground jobs you start end with this turn; collect their output before you reply.` : shared
}

export const AGENT_INSTRUCTIONS = agentInstructions(false)

export function buildPrompt(input: DispatchInput): string {
  return turnPrompt(input)
}
