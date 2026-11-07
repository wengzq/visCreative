import { expect, it, vi } from 'vitest'
import type { EntityView } from '@vis/protocol'
import type { SettingsLibraryHost } from './host'
import { updateSetting } from './SettingEditor'

const previous: EntityView = {
  id: 'hero', kind: 'character', name: 'Hero', description: 'Blue coat', refs: [], members: [],
  revision: 1, createdAt: 1, updatedAt: 1, usage: { scriptNodeIds: [], shotCount: 0 },
}
const conflict = { code: 'revision_conflict' }

it('rereads and retries once when concurrent edits touched different setting fields', async () => {
  const current = { ...previous, revision: 2, description: 'Red coat' }
  const call = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, name: 'Lead' })
  await expect(updateSetting({ call } as unknown as SettingsLibraryHost, previous, { name: 'Lead' })).resolves.toMatchObject({ name: 'Lead' })
  expect(call.mock.calls).toEqual([
    ['entity.update', { entityId: 'hero', expectedRevision: 1, name: 'Lead' }],
    ['entity.get', { entityId: 'hero' }],
    ['entity.update', { entityId: 'hero', expectedRevision: 2, name: 'Lead' }],
  ])
})

it('preserves a conflict when another editor changed the same field', async () => {
  const call = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ ...previous, revision: 2, name: 'Other name' })
  await expect(updateSetting({ call } as unknown as SettingsLibraryHost, previous, { name: 'Lead' })).rejects.toBe(conflict)
  expect(call).toHaveBeenCalledTimes(2)
})

it('does not retry a second revision conflict', async () => {
  const call = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ ...previous, revision: 2 }).mockRejectedValueOnce(conflict)
  await expect(updateSetting({ call } as unknown as SettingsLibraryHost, previous, { name: 'Lead' })).rejects.toBe(conflict)
  expect(call).toHaveBeenCalledTimes(3)
})
