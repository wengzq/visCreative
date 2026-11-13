import { agentInstructions, turnPrompt, type DispatchInput } from '@vis/workbench-core'

/** Shared creative-space and child configuration guidance, appended to Codex's own system prompt. */
export function developerInstructions(work?: DispatchInput['workContext'], isolation: 'sandbox' | 'none' = 'sandbox'): string {
  return agentInstructions({ environment: { access: 'expanded', isolation }, work })
}

export const DEVELOPER_INSTRUCTIONS = developerInstructions()

export function buildPrompt(input: DispatchInput): string {
  return turnPrompt(input)
}
