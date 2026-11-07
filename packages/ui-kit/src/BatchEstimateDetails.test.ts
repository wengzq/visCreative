import { expect, it, vi } from 'vitest'
import { BatchEstimateDetails, type BatchDetails } from './BatchEstimateDetails'

vi.mock('./i18n', async importOriginal => ({
  ...await importOriginal<typeof import('./i18n')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useFormat: () => ({ number: String }),
}))

const batch: BatchDetails = {
  media: 'video', estimate: { shots: 1, jobs: 2, billedJobs: 2, provider: 'provider', model: 'model', quotaRemaining: 4, frameMode: 'first',
    staleShots: 1, shotsMissingAssetImages: 1, shotsMissingFirstFrame: 1, shotsWithoutPrompt: 1 },
  shots: [{ shotId: 'shot', steps: [{ role: 'first' }, { role: 'video' }] }], changedShotIds: ['shot'],
}

it('shares estimates, all nonblocking warnings, frame fallback and changed-shot highlighting', () => {
  const content = JSON.stringify(BatchEstimateDetails({ batch }))
  for (const text of ['1 shot', '2 generation jobs', '2 billed jobs', 'Quota remaining today: 4', 'stale prompts', 'without reference images', 'no first frame', 'no prompt', 'Changed since the request', 'ignore the last frame']) expect(content).toContain(text)
  expect(content).toContain('is-changed')
  expect(JSON.stringify(BatchEstimateDetails({ batch: { ...batch, estimate: { ...batch.estimate, frameMode: null, billedJobs: 0, quotaRemaining: null } } }))).toContain('shot continuity cannot be guaranteed')
})
