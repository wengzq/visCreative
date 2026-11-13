import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('documents the shared upload and release key contract in the adapter and RFC', async () => {
  for (const path of ['./types.ts', '../../../../docs/rfc/0043-video-references-and-media-hosting.md']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    expect(source).toContain('`${idempotencyKey}:${ordinal}`')
    expect(source).toContain('release() takes the bare idempotencyKey')
    expect(source).toContain('splits at the last colon and hashes only the bare key')
  }
})
