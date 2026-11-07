import { z } from 'zod'
import { AgentKind } from './session'

export const AgentDescriptor = z.object({
  kind: AgentKind,
  label: z.string().min(1),
  icon: z.array(z.string()),
  homepage: z.string(),
  install: z.object({
    hint: z.object({ zh: z.string(), en: z.string() }),
    command: z.string().optional(),
  }),
  envPassthrough: z.array(z.string()),
  forbiddenPaths: z.array(z.string()),
  capabilities: z.object({
    resume: z.boolean(),
    interrupt: z.boolean(),
    models: z.boolean(),
    effort: z.boolean(),
    approvals: z.boolean(),
  }),
})
export type AgentDescriptor = z.infer<typeof AgentDescriptor>
export const AgentView = AgentDescriptor.extend({ available: z.boolean(), reason: z.string().optional() })
export type AgentView = z.infer<typeof AgentView>

export const agents = {
  list: { params: z.object({}), result: z.object({ agents: z.array(AgentView) }) },
} as const
