import { createAcpRuntime, type AcpRuntimeOptions } from '@vis/workbench-core'
import { codebuddyProfile } from './profile'

export type CodebuddyRuntimeOptions = AcpRuntimeOptions & { codebuddyPath?: string }

export function createCodebuddyRuntime(
  ctx: Parameters<typeof createAcpRuntime>[0],
  options: CodebuddyRuntimeOptions,
): ReturnType<typeof createAcpRuntime> {
  return createAcpRuntime(ctx, options, codebuddyProfile(options))
}
