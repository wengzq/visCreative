import { z } from 'zod'
import { METHODS, isMethodName, type Caller, type MethodName, type MethodResult, type MethodSpec } from './methods'
import type { CapabilitySummary } from './runtime'

export function commandOf(method: MethodName): readonly string[] {
  const spec: MethodSpec = METHODS[method]
  return spec.command ?? method.split('.')
}

/** Share command aliases with the MCP catalog to prevent display names from drifting from actual tool names. */
export function toolNameOf(method: MethodName): string {
  return commandOf(method).join('_')
}

export function listCapabilities(caller: Caller): CapabilitySummary[] {
  const capabilities: CapabilitySummary[] = []
  for (const method of Object.keys(METHODS) as MethodName[]) {
    const spec: MethodSpec = METHODS[method]
    if (spec.callers.includes(caller)) {
      capabilities.push({ method, command: commandOf(method).join(' '), summary: spec.summary })
    }
  }
  return capabilities
}

export function describeCapability(method: string, caller: Caller): MethodResult<'capabilities.describe'> | undefined {
  if (!isMethodName(method)) return undefined
  const spec: MethodSpec = METHODS[method]
  if (!spec.callers.includes(caller)) return undefined
  return {
    method,
    command: commandOf(method).join(' '),
    summary: spec.summary,
    description: spec.description ?? spec.summary,
    params: z.toJSONSchema(spec.params, { io: 'input', unrepresentable: 'any' }),
    result: z.toJSONSchema(spec.result, { io: 'output', unrepresentable: 'any' }),
  }
}
