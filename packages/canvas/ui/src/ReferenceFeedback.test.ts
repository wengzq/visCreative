import type { ReactElement, ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { ReferenceFeedback } from './ReferenceFeedback'
import { videoReferenceState } from './reference-validation'

vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useFormat: () => ({ number: String }),
  useLocale: () => ({ locale: 'en' }),
}))

function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  return [value as ReactElement<any>, ...elements((value as ReactElement<any>).props.children)]
}

it('opens existing settings navigation and offers a retry only for an actual fetch failure', () => {
  const onManage = vi.fn()
  const onRetry = vi.fn()
  const state = { count: 1, knownCount: 0, totalMs: 0, limits: { max: 3, minMs: 2000, maxMs: 15000, totalMs: 15000 }, hostingRequired: true, durationUnchecked: true, problem: undefined, blocked: true } as ReturnType<typeof videoReferenceState>
  const draw = (loading: boolean, failed = true) => elements(ReferenceFeedback({ state, loading, failed, onManage, onRetry }))
  const hosting = draw(true).find(element => element.type === 'button')!
  expect(hosting.props.children).toBe('Media hosting settings')
  hosting.props.onClick()
  expect(onManage).toHaveBeenCalledOnce()
  expect(draw(true).filter(element => element.type === 'button')).toHaveLength(1)
  expect(draw(false, false).filter(element => element.type === 'button')).toHaveLength(1)
  draw(false).find(element => element.type === 'button' && element.props.children === 'Retry reading duration')!.props.onClick()
  expect(onRetry).toHaveBeenCalledOnce()
})
