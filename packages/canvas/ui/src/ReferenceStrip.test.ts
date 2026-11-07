import type { ReactElement, ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { ReferencePreview } from './ReferenceStrip'
import { VideoPoster } from './VideoPoster'

const hooks = vi.hoisted(() => ({ duration: null as number | null }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => [hooks.duration, (value: number) => { hooks.duration = value }],
}))
vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useFormat: () => ({ number: String }),
}))
beforeEach(() => { hooks.duration = null })

function preview(kind: 'image' | 'video' | 'audio') {
  return ReferencePreview({
    reference: { nodeId: 'node', number: 1, node: { kind, slots: [{ slotKey: 'main', content: { type: 'asset', assetVersionId: 'asset' } }] } as NodeView },
    assetUrl: id => `/assets/${id}`, posterUrl: id => `/posters/${id}`,
  }) as ReactElement<any>
}

function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  return [value as ReactElement<any>, ...elements((value as ReactElement<any>).props.children)]
}

it('uses a poster for video references while keeping image asset URLs', () => {
  const video = preview('video')
  expect(video.type).toBe(VideoPoster)
  expect(video.props).toMatchObject({ src: '/assets/asset', posterSrc: '/posters/asset' })
  const image = preview('image')
  expect(image.type).toBe('img')
  expect(image.props.src).toBe('/assets/asset')
})

it('keeps loading audio metadata and displaying its duration', () => {
  const audio = elements(preview('audio')).find(element => element.type === 'audio')!
  expect(audio.props).toMatchObject({ src: '/assets/asset', preload: 'metadata' })
  audio.props.onLoadedMetadata({ currentTarget: { duration: 75.4 } })
  expect(elements(preview('audio')).find(element => element.type === 'small')?.props.children.join('')).toBe('1:15')
})
