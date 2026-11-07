import { expect, it } from 'vitest'
import { boundedBody, OutputSizeLimitError } from './download'
import { ProviderError } from './types'

it('bounds chunked output without trusting Content-Length and cancels the stream', async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(4)) },
    cancel() { cancelled = true },
  })
  const error = await boundedBody(new Response(body), 6).catch(error => error)
  expect(error).toBeInstanceOf(OutputSizeLimitError)
  expect(error).toBeInstanceOf(ProviderError)
  expect(error).toMatchObject({ kind: 'rejected', message: 'Generation output exceeds the size limit' })
  expect(cancelled).toBe(true)
})

it('marks Content-Length overflow without relying on the error message', async () => {
  await expect(boundedBody(new Response(new Uint8Array(4), { headers: { 'Content-Length': '4' } }), 3)).rejects.toBeInstanceOf(OutputSizeLimitError)
  await expect(boundedBody(new Response(null), 3)).rejects.not.toBeInstanceOf(OutputSizeLimitError)
})

it('keeps every byte of a bounded streamed output', async () => {
  expect(await boundedBody(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(new Uint8Array([1, 2, 3]))
})
