import type { AgentModelOption } from '@vis/protocol'

type Choice = { value: string; name: string; description?: string }
type ConfigOption = { id: string; currentValue: string; options: unknown[] }

export function configOption(options: unknown, id: string): ConfigOption | undefined {
  if (!Array.isArray(options)) return undefined
  return options.find(option => option?.id === id && option.type === 'select' && typeof option.currentValue === 'string' && Array.isArray(option.options))
}

export function configChoices(option: ConfigOption | undefined): Choice[] {
  return (option?.options ?? []).flatMap((choice: any) => Array.isArray(choice?.options) ? choice.options : [choice])
    .filter((choice: any): choice is Choice => typeof choice?.value === 'string' && typeof choice.name === 'string')
}

export function modelOption(choice: Choice, options: unknown, defaultModel: string): AgentModelOption {
  const reasoning = configOption(options, 'reasoning_effort')
  return {
    id: choice.value,
    label: choice.name,
    ...(choice.description === undefined ? {} : { description: choice.description }),
    isDefault: choice.value === defaultModel,
    efforts: configChoices(reasoning).filter(effort => effort.value !== '').map(effort => ({
      id: effort.value,
      label: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
    })),
    defaultEffort: reasoning?.currentValue || null,
    // dsh has no speed tiers
    serviceTiers: [],
  }
}
