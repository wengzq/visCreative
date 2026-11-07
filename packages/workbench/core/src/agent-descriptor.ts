import type { AgentDescriptor as WireDescriptor } from '@vis/protocol'

export type AgentDescriptor = Omit<WireDescriptor, 'icon' | 'envPassthrough' | 'forbiddenPaths'> & {
  icon: readonly string[]
  envPassthrough: readonly string[]
  forbiddenPaths: readonly string[]
}
