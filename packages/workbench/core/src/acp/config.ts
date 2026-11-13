import type { AgentModelOption } from '@vis/protocol'

export type AcpChoice = { value: string; name: string; description?: string }
export type AcpConfigOption = { id: string; currentValue: string; options: unknown[] }

export function configOption(options: unknown, id: string | undefined): AcpConfigOption | undefined {
  if (id === undefined || !Array.isArray(options)) return undefined
  return options.find(option => option?.id === id && option.type === 'select' && typeof option.currentValue === 'string' && Array.isArray(option.options))
}

export function configChoices(option: AcpConfigOption | undefined): AcpChoice[] {
  return (option?.options ?? []).flatMap((choice: any) => Array.isArray(choice?.options) ? choice.options : [choice])
    .filter((choice: any): choice is AcpChoice => typeof choice?.value === 'string' && typeof choice.name === 'string')
}

export function modelOption(choice: AcpChoice, options: unknown, defaultModel: string, effortId?: string): AgentModelOption {
  const effort = configOption(options, effortId)
  return {
    id: choice.value,
    label: choice.name,
    ...(choice.description === undefined ? {} : { description: choice.description }),
    isDefault: choice.value === defaultModel,
    efforts: configChoices(effort).filter(value => value.value !== '').map(value => ({
      id: value.value,
      label: value.name,
      ...(value.description === undefined ? {} : { description: value.description }),
    })),
    defaultEffort: effort?.currentValue || null,
    serviceTiers: [],
  }
}
