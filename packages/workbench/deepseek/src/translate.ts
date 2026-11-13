import { createAcpTranslator } from '@vis/workbench-core'

export type { AcpTranslatedItem as TranslatedItem } from '@vis/workbench-core'

/** Preserve the DeepSeek transcript namespace for existing callers. */
export function createTranslator(acpSessionId: string, turnId: string) {
  return createAcpTranslator(acpSessionId, turnId, 'ds')
}
