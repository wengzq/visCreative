import { expect, it, vi } from 'vitest'
import { captureFrame } from './index'

const transient = () => new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot')

it('retries a transient capture failure and returns the frame', async () => {
  const capture = vi.fn<() => Promise<Buffer>>().mockRejectedValueOnce(transient()).mockResolvedValueOnce(Buffer.from('png'))
  await expect(captureFrame(capture, 3, 0)).resolves.toEqual(Buffer.from('png'))
  expect(capture).toHaveBeenCalledTimes(2)
})

it('gives up after the last attempt of a persistent capture failure', async () => {
  const capture = vi.fn<() => Promise<Buffer>>().mockRejectedValue(transient())
  await expect(captureFrame(capture, 3, 0)).rejects.toThrow(/Unable to capture screenshot/)
  expect(capture).toHaveBeenCalledTimes(3)
})

it('does not retry other errors', async () => {
  const capture = vi.fn<() => Promise<Buffer>>().mockRejectedValue(new Error('Target page, context or browser has been closed'))
  await expect(captureFrame(capture, 3, 0)).rejects.toThrow(/closed/)
  expect(capture).toHaveBeenCalledTimes(1)
})
